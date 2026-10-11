/**
 * The machine underneath: the services the platform depends on, what the
 * host is carrying over time, every container on it with live usage and the
 * app — and student — it belongs to, and the disk Docker is using.
 */

"use client";

import Link from "next/link";
import { Checkbox, Select } from "@/components/Controls";
import { useEffect, useMemo, useState } from "react";

import { ChartPanel, TimeSeries } from "@/components/charts";
import { Badge, Dot, Eyebrow, SectionTitle, Skeleton, cx } from "@/components/ui";
import {
  getContainers,
  getDisk,
  getHostMetrics,
  getPlatformStatusFull,
  type ContainersView,
  type HostMetrics,
  type PlatformStatusFull,
} from "@/lib/admin";
import type { Window } from "@/lib/apps";
import { bytes, percent } from "@/lib/format";

const SERVICES: { key: keyof PlatformStatusFull; name: string; does: string; without: string }[] = [
  { key: "docker", name: "Docker", does: "Builds images and runs every app's containers.", without: "Nothing can be built, started or stopped." },
  { key: "redis", name: "Redis", does: "Holds the build queue, rate limits, metrics and the code-view cache.", without: "Builds cannot be queued and graphs stop." },
  { key: "router", name: "Router (Traefik)", does: "Sends each app's address to its container, with HTTPS when configured.", without: "Apps keep running but no URL reaches them." },
  { key: "registry", name: "Image registry", does: "Keeps every version of every app, so rollback never needs a rebuild.", without: "New builds are not kept; rollback to them is not possible." },
  { key: "buildpacks", name: "Buildpacks (pack)", does: "Builds apps that have no Dockerfile.", without: "Only Dockerfile and Compose apps can be built." },
];

type Sort = "cpu" | "mem" | "name";

export default function InfrastructurePage() {
  const [status, setStatus] = useState<PlatformStatusFull | null>(null);
  const [host, setHost] = useState<HostMetrics | null>(null);
  const [containers, setContainers] = useState<ContainersView | null>(null);
  const [disk, setDisk] = useState<Awaited<ReturnType<typeof getDisk>> | null>(null);
  const [win, setWin] = useState<Window>("1h");
  const [now, setNow] = useState(() => Date.now());
  const [sort, setSort] = useState<Sort>("cpu");
  const [showPlatform, setShowPlatform] = useState(true);

  useEffect(() => {
    let active = true;
    const load = () => {
      getPlatformStatusFull().then((s) => active && setStatus(s)).catch(() => undefined);
      getContainers().then((c) => active && setContainers(c)).catch(() => undefined);
    };
    load();
    getDisk().then((d) => active && setDisk(d)).catch(() => active && setDisk([]));
    const t = setInterval(load, 10_000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const load = () => getHostMetrics(win).then((h) => {
      if (!active) return;
      setHost(h);
      setNow(Date.now());
    }).catch(() => undefined);
    load();
    const t = setInterval(load, 20_000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [win]);

  const span = win === "1h" ? 3_600_000 : win === "6h" ? 6 * 3_600_000 : 24 * 3_600_000;
  const rows = useMemo(() => {
    const list = (containers?.containers ?? []).filter((c) => showPlatform || !c.platform);
    return [...list].sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : sort === "mem" ? (b.mem ?? 0) - (a.mem ?? 0) : (b.cpu ?? 0) - (a.cpu ?? 0));
  }, [containers, sort, showPlatform]);

  return (
    <div className="space-y-8">
      <div>
        <Eyebrow>Operations</Eyebrow>
        <h1 className="mt-3 text-[2rem] font-semibold leading-tight">Infrastructure</h1>
        <p className="mt-1.5 text-sm text-[var(--text-muted)]">Checked live. Every app on the platform depends on these.</p>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {SERVICES.map((svc) => {
          const ok = status ? Boolean(status[svc.key]) : null;
          return (
            <div key={svc.key} className={cx("plate p-5", ok === false && "border-[var(--danger)]/30")}>
              <div className="flex items-center justify-between gap-3">
                <p className="font-semibold">{svc.name}</p>
                {ok === null ? <Skeleton className="h-5 w-20" /> : (
                  <Badge tone={ok ? "ok" : "danger"}><Dot tone={ok ? "ok" : "danger"} pulse={ok} />{ok ? "Operational" : "Down"}</Badge>
                )}
              </div>
              <p className="mt-2 text-sm text-[var(--text-muted)]">{svc.does}</p>
              {ok === false ? (
                <p className="mt-3 text-xs text-[var(--danger)]">{status?.detail[svc.key as string] ?? svc.without}</p>
              ) : <p className="mt-3 text-xs text-[var(--text-dim)]">Without it: {svc.without}</p>}
            </div>
          );
        })}
        <div className="plate p-5">
          <p className="font-semibold">Host</p>
          {containers ? (
            <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-[var(--text-dim)]">CPU cores</dt><dd className="tabular text-right">{containers.host.cpus ?? "—"}</dd>
              <dt className="text-[var(--text-dim)]">Memory</dt><dd className="tabular text-right">{bytes(containers.host.mem_total)}</dd>
              <dt className="text-[var(--text-dim)]">Docker</dt><dd className="text-right">{containers.host.docker ?? "—"}</dd>
              <dt className="text-[var(--text-dim)]">Images</dt><dd className="tabular text-right">{containers.host.images ?? "—"}</dd>
              <dt className="col-span-2 truncate text-xs text-[var(--text-dim)]" title={containers.host.os ?? ""}>{containers.host.os}</dt>
            </dl>
          ) : <Skeleton className="mt-3 h-24" />}
        </div>
      </div>

      <section>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Load</h2>
            <p className="mt-1 text-sm text-[var(--text-muted)]">Summed across every container, sampled by the platform.</p>
          </div>
          <div className="inline-flex rounded-full border border-[var(--hairline)] bg-[var(--surface)] p-1">
            {(["1h", "6h", "24h"] as Window[]).map((w) => (
              <button key={w} onClick={() => setWin(w)}
                className={cx("rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
                  win === w ? "bg-[var(--solid)] text-[var(--solid-text)]" : "text-[var(--text-muted)] hover:text-[var(--text)]")}>
                {w}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-4 lg:grid-cols-2 [&>*]:h-[17rem]">
          <ChartPanel title="CPU" value={percent(host?.latest?.cpu)} caption="share of the whole machine">
            <TimeSeries domain={[now - span, now]} series={[{ key: "cpu", label: "CPU", points: host?.series.cpu ?? [] }]}
              format={(v, d) => `${v.toFixed(d ?? 1)}%`} />
          </ChartPanel>
          <ChartPanel title="Memory" value={bytes(host?.latest?.mem)} caption={host?.latest?.mem_total ? `of ${bytes(host.latest.mem_total)}` : undefined}>
            <TimeSeries domain={[now - span, now]} series={[{ key: "mem", label: "Memory", points: host?.series.mem ?? [] }]}
              format={(v) => bytes(v, 0)} />
          </ChartPanel>
          <ChartPanel title="Apps running" value={host?.latest?.apps ?? "—"}>
            <TimeSeries domain={[now - span, now]} series={[{ key: "apps", label: "Apps", points: host?.series.apps ?? [] }]} integer
              format={(v) => String(Math.round(v))} />
          </ChartPanel>
          <ChartPanel title="Builds running" value={host?.latest?.builds ?? "—"}>
            <TimeSeries domain={[now - span, now]} series={[{ key: "builds", label: "Builds", points: host?.series.builds ?? [] }]} integer
              format={(v) => String(Math.round(v))} />
          </ChartPanel>
        </div>
      </section>

      <section>
        <SectionTitle hint="Live. Containers that belong to an app link to it; platform containers are marked."
          action={
            <div className="flex items-center gap-2 text-xs">
              <Checkbox checked={showPlatform} onChange={setShowPlatform}>Platform containers</Checkbox>
              <Select<Sort>
                ariaLabel="Sort containers"
                variant="pill"
                align="right"
                menuClassName="w-40"
                value={sort}
                onChange={setSort}
                options={[
                  { value: "cpu", label: "By CPU" },
                  { value: "mem", label: "By memory" },
                  { value: "name", label: "By name" },
                ]}
              />
            </div>
          }>
          Containers
        </SectionTitle>
        {!containers ? <Skeleton className="h-64" /> : (
          <div className="plate thin-scroll table-frame">
            <table className="w-full min-w-[56rem] text-sm">
              <thead>
                <tr className="border-b border-[var(--hairline)] text-left text-[11px] uppercase tracking-[0.12em] text-[var(--text-dim)]">
                  <th className="px-4 py-3 font-medium">Container</th>
                  <th className="px-4 py-3 font-medium">Belongs to</th>
                  <th className="px-4 py-3 text-right font-medium">CPU</th>
                  <th className="px-4 py-3 text-right font-medium">Memory</th>
                  <th className="px-4 py-3 text-right font-medium">Net in / out</th>
                  <th className="px-4 py-3 text-right font-medium">Procs</th>
                  <th className="px-4 py-3 font-medium">Up</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--hairline)]">
                {rows.map((c) => {
                  const memShare = c.mem && c.mem_limit ? c.mem / c.mem_limit : 0;
                  return (
                    <tr key={c.name}>
                      <td className="max-w-[16rem] px-4 py-2.5">
                        <p className="truncate font-[family-name:var(--font-jetbrains-mono)] text-xs">{c.name}</p>
                        <p className="truncate text-[11px] text-[var(--text-dim)]">{c.image}</p>
                      </td>
                      <td className="max-w-[16rem] px-4 py-2.5 text-xs">
                        {c.app ? (
                          <Link href={`/admin/apps/${c.app.app_id}`} className="block truncate hover:text-[var(--accent)]">
                            {c.app.app}<span className="block text-[var(--text-dim)]">{c.app.owner}</span>
                          </Link>
                        ) : c.platform ? <Badge tone="accent">Platform</Badge> : <span className="text-[var(--text-dim)]">—</span>}
                      </td>
                      <td className="tabular px-4 py-2.5 text-right text-xs">{percent(c.cpu)}</td>
                      <td className={cx("tabular px-4 py-2.5 text-right text-xs", memShare > 0.9 ? "text-[var(--danger)]" : memShare > 0.75 ? "text-[var(--warn)]" : "")}>
                        {bytes(c.mem)}{c.mem_limit ? <span className="text-[var(--text-dim)]"> / {bytes(c.mem_limit, 0)}</span> : null}
                      </td>
                      <td className="tabular px-4 py-2.5 text-right text-xs text-[var(--text-muted)]">{bytes(c.net_rx)} / {bytes(c.net_tx)}</td>
                      <td className="tabular px-4 py-2.5 text-right text-xs text-[var(--text-muted)]">{c.pids ?? "—"}</td>
                      <td className="px-4 py-2.5 text-xs text-[var(--text-muted)]">{c.status}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <SectionTitle hint="Reclaimable space is what `docker system prune` would free.">Disk</SectionTitle>
        {disk === null ? <Skeleton className="h-32" /> : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {disk.map((d) => (
              <div key={d.Type} className="plate px-5 py-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">{d.Type}</p>
                <p className="mt-2 text-2xl font-semibold">{d.Size}</p>
                <p className="mt-1 text-xs text-[var(--text-dim)]">{d.TotalCount} total · {d.Active} active · {d.Reclaimable} reclaimable</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
