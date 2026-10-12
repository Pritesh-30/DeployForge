/**
 * What the app uses and how fast it answers, over the last hour, six hours
 * or day.
 *
 * Sampled by the platform every few seconds whether or not anyone is
 * looking, so the graph of "what happened at 3am" exists before anyone asks.
 * One measure per chart: CPU and memory have different units, and drawing
 * them against two y-axes on one chart invites comparing lines that are not
 * comparable.
 */

"use client";

import { useEffect, useState } from "react";

import { useApp } from "@/components/app/AppFrame";
import { ChartPanel, StatTile, TimeSeries } from "@/components/charts";
import { useSession } from "@/components/Session";
import { Skeleton, cx } from "@/components/ui";
import type { AppMetrics, Window } from "@/lib/apps";
import { bytes, ms, percent, rate, share } from "@/lib/format";

const WINDOWS: { key: Window; label: string; ms: number }[] = [
  { key: "1h", label: "1 hour", ms: 3_600_000 },
  { key: "6h", label: "6 hours", ms: 6 * 3_600_000 },
  { key: "24h", label: "24 hours", ms: 24 * 3_600_000 },
];

export default function AppMetricsView() {
  const { app, api } = useApp();
  const { meta } = useSession();
  const [win, setWin] = useState<Window>("1h");
  const [data, setData] = useState<AppMetrics | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    const load = () => {
      api.metrics(app.id, win).then((m) => {
        if (!active) return;
        setData(m);
        setNow(Date.now());
      }).catch(() => undefined);
    };
    load();
    const t = setInterval(load, 20_000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [api, app.id, win]);

  const span = WINDOWS.find((w) => w.key === win)!.ms;
  const domain: [number, number] = [now - span, now];
  const s = data?.summary;
  const memLimit = data?.latest?.mem_limit;

  return (
    <div className="space-y-6">
      {/* Filters sit in one row above everything they scope. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-full border border-[var(--hairline)] bg-[var(--surface)] p-1">
          {WINDOWS.map((w) => (
            <button key={w.key} onClick={() => setWin(w.key)}
              className={cx(
                "rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors duration-[var(--t-hover)]",
                win === w.key ? "bg-[var(--solid)] text-[var(--solid-text)]" : "text-[var(--text-muted)] hover:text-[var(--text)]",
              )}>
              Last {w.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--text-dim)]">
          Sampled every {meta?.metrics_interval_seconds ?? 15}s · {data ? `${data.samples.toLocaleString()} samples` : "loading"} · gaps mean the app was not running
        </p>
      </div>

      {!data ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-64" />)}
        </div>
      ) : (
        <div className={cx("space-y-6 transition-opacity", !data && "opacity-50")}>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Uptime" value={s?.uptime == null ? "—" : share(s.uptime, 2)}
              tone={s?.uptime == null ? undefined : s.uptime >= 0.99 ? "ok" : s.uptime >= 0.9 ? "warn" : "danger"}
              hint="probes answered below HTTP 500" />
            <StatTile label="Latency p50 / p95" value={ms(s?.latency_p50)} hint={`p95 ${ms(s?.latency_p95)}`} />
            <StatTile label="CPU avg / peak" value={percent(s?.cpu_avg)} hint={`peak ${percent(s?.cpu_max)} of one core`} />
            <StatTile label="Memory avg / peak" value={bytes(s?.mem_avg)} hint={`peak ${bytes(s?.mem_max)}${memLimit ? ` of ${bytes(memLimit)}` : ""}`} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2 [&>*]:h-[19rem]">
            <ChartPanel title="CPU" value={percent(data.latest?.cpu)} caption="% of one core">
              <TimeSeries domain={domain} series={[{ key: "cpu", label: "CPU", points: data.series.cpu }]}
                format={(v, d) => `${v.toFixed(d ?? 1)}%`} />
            </ChartPanel>
            <ChartPanel title="Memory" value={bytes(data.latest?.mem)} caption={memLimit ? `limit ${bytes(memLimit)}` : undefined}>
              <TimeSeries domain={domain} series={[{ key: "mem", label: "Memory", points: data.series.mem }]}
                format={(v) => bytes(v, 0)} />
            </ChartPanel>
            <ChartPanel title="Response time" value={ms(data.latest?.latency)} caption="front page, through the router">
              <TimeSeries domain={domain} series={[{ key: "lat", label: "Latency", points: data.series.latency }]}
                format={(v) => ms(v)} />
            </ChartPanel>
            <ChartPanel title="Network" caption="bytes per second">
              <TimeSeries domain={domain} area={false}
                series={[
                  { key: "rx", label: "In", points: data.series.net_rx },
                  { key: "tx", label: "Out", points: data.series.net_tx },
                ]}
                format={(v) => rate(v)} />
            </ChartPanel>
          </div>
        </div>
      )}
    </div>
  );
}
