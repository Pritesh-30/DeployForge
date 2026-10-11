"""
Metrics: parsing Docker's numbers, downsampling, and turning samples into
the summaries a dashboard shows.
"""

from __future__ import annotations

import math
import random
import uuid

import pytest

from app.metrics import sampling, store
from app.metrics.collector import usage_by_deployment
from app.metrics.lttb import lttb
from app.models.deployment import BuildMethod, Deployment, DeploymentStatus


# --- LTTB -------------------------------------------------------------------

def test_lttb_keeps_both_ends_and_the_requested_count():
    points = [(float(i), math.sin(i / 10)) for i in range(1000)]
    out = lttb(points, 100)
    assert len(out) == 100
    assert out[0] == points[0] and out[-1] == points[-1]


def test_lttb_keeps_a_spike_that_averaging_would_flatten():
    """The reason not to average: the spike is what someone came to see."""
    points = [(float(i), 1.0) for i in range(1000)]
    points[503] = (503.0, 99.0)
    out = lttb(points, 50)
    assert (503.0, 99.0) in out
    averaged = [sum(p[1] for p in points[i:i + 20]) / 20 for i in range(0, 1000, 20)]
    assert max(averaged) < 6


def test_lttb_leaves_small_inputs_alone():
    points = [(0.0, 1.0), (1.0, 2.0), (2.0, 3.0)]
    assert lttb(points, 10) == points
    assert lttb(points, 2) == points


def test_lttb_output_is_ordered_and_a_subset():
    rng = random.Random(4)
    points = [(float(i), rng.random()) for i in range(500)]
    out = lttb(points, 60)
    assert [p[0] for p in out] == sorted(p[0] for p in out)
    assert set(out) <= set(points)


# --- Docker's numbers -------------------------------------------------------

@pytest.mark.parametrize(
    "text,expected",
    [
        ("0B", 0),
        ("512MiB", 512 * 1024**2),
        ("1.5GiB", int(1.5 * 1024**3)),
        ("12.3kB", 12_300),
        ("2.04MB", 2_040_000),
        ("", 0),
        ("garbage", 0),
    ],
)
def test_sizes_parse(text, expected):
    assert sampling.parse_size(text) == expected


def test_a_stats_row_parses():
    row = {
        "Name": "df-abc", "CPUPerc": "12.50%", "MemUsage": "100MiB / 512MiB",
        "NetIO": "1.2kB / 3.4kB", "BlockIO": "0B / 4.1MB", "PIDs": "11",
    }
    s = sampling.ContainerStats.from_docker(row)
    assert s.cpu_percent == 12.5
    assert s.mem_bytes == 100 * 1024**2
    assert s.mem_limit_bytes == 512 * 1024**2
    assert (s.net_rx_bytes, s.net_tx_bytes) == (1200, 3400)
    assert s.pids == 11


def test_labels_parse():
    assert sampling.parse_labels("a=1,com.docker.compose.project=df-x") == {
        "a": "1", "com.docker.compose.project": "df-x",
    }


# --- Attributing containers to apps -----------------------------------------

def _deployment(**kw) -> Deployment:
    return Deployment(id=uuid.uuid4(), repository_id=uuid.uuid4(), user_id=uuid.uuid4(),
                      status=DeploymentStatus.RUNNING, **kw)


def _stats(name, cpu, mem):
    return sampling.ContainerStats(name, cpu, mem, 512, 0, 0, 0, 0, 1)


def test_a_compose_stack_is_summed_into_its_app():
    """'My app uses 400 MB' is the answer its owner wanted, not five rows."""
    single = _deployment(build_method=BuildMethod.DOCKER, container_name="df-one")
    stack = _deployment(build_method=BuildMethod.COMPOSE, compose_project="df-proj")
    containers = [
        {"Names": "df-one", "LabelMap": {}},
        {"Names": "df-proj-web-1", "LabelMap": {"com.docker.compose.project": "df-proj"}},
        {"Names": "df-proj-db-1", "LabelMap": {"com.docker.compose.project": "df-proj"}},
        {"Names": "someone-else", "LabelMap": {}},
    ]
    stats = {
        "df-one": _stats("df-one", 5.0, 100),
        "df-proj-web-1": _stats("df-proj-web-1", 10.0, 200),
        "df-proj-db-1": _stats("df-proj-db-1", 2.5, 300),
        "someone-else": _stats("someone-else", 90.0, 999),
    }
    usage = usage_by_deployment([single, stack], containers, stats)

    assert usage[str(single.id)].cpu == 5.0
    assert usage[str(stack.id)].cpu == 12.5
    assert usage[str(stack.id)].mem == 500
    assert usage[str(stack.id)].containers == 2


# --- Summaries --------------------------------------------------------------

def test_network_rates_survive_a_restart():
    """A counter that resets must not draw a huge negative spike."""
    samples = [(0, {"net_rx": 0}), (1000, {"net_rx": 1000}), (2000, {"net_rx": 10}), (3000, {"net_rx": 510})]
    assert store.rates(samples, "net_rx") == [(1000, 1000.0), (2000, 0.0), (3000, 500.0)]


def test_uptime_counts_answers_below_500_as_up():
    samples = [
        (0, {"status": 200, "latency": 10}),
        (1, {"status": 404, "latency": 12}),   # an API with no root route is up
        (2, {"status": 502, "latency": 1}),
        (3, {"status": 0, "latency": 5000}),   # nothing answered
    ]
    summary = store.summarize(samples)
    assert summary.uptime == 0.5
    assert summary.latency_p50 in (10, 12)


def test_percentiles():
    assert store.percentile([], 0.5) is None
    assert store.percentile([5.0], 0.95) == 5.0
    assert store.percentile([float(i) for i in range(101)], 0.95) == 95.0


async def test_samples_round_trip_through_a_stream():
    stream = store.app_key("test-app")
    await store.append(stream, {"cpu": 1.5, "mem": 100}, ts_ms=1_000)
    await store.append(stream, {"cpu": 2.5, "mem": 200}, ts_ms=2_000)
    await store.append(stream, {"cpu": 9.0, "mem": 300}, ts_ms=3_000)

    window = await store.read(stream, since_ms=1_500)
    assert [ts for ts, _ in window] == [2_000, 3_000]
    assert window[0][1]["cpu"] == 2.5
    assert (await store.latest(stream))[1]["mem"] == 300


async def test_app_metrics_view_shapes_a_chart(monkeypatch):
    from app.metrics import views

    app_id = uuid.uuid4()
    monkeypatch.setattr(store, "window_start", lambda w: 0)
    for i in range(10):
        await store.append(store.app_key(app_id),
                           {"cpu": i, "mem": i * 10, "net_rx": i * 100, "status": 200, "latency": 5 + i},
                           ts_ms=1000 * (i + 1))

    body = await views.app_metrics(app_id, window="1h", points=5)
    assert body["samples"] == 10
    assert len(body["series"]["cpu"]) == 5
    assert body["summary"]["uptime"] == 1.0
    assert body["latest"]["cpu"] == 9
