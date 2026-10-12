/**
 * The administrator's first screen: is the platform healthy, how loaded is
 * the machine, how are builds going, and what needs someone's attention.
 *
 * Ordered by urgency. Service status and the attention list come first —
 * those are things to act on; trends and breakdowns follow, for context.
 */

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useLive } from "@/lib/live";

import {
  ChartPanel,
  Meter,
  ProportionBar,
  RankedBars,
  StackedBars,
  StatTile,
  TimeSeries,
} from "@/components/charts";
import { AlertIcon, BanIcon, BoxIcon, CheckIcon, ChevronRight, CpuIcon, QueueIcon, UsersIcon } from "@/components/Icons";
import { Badge, Dot, Eyebrow, Panel, PanelEmpty, Skeleton, cx } from "@/components/ui";
import {
  adminApps,
  getAnalytics,
  getHostMetrics,
  getPlatformStatusFull,
  type HostMetrics,
  type PlatformAnalytics,
  type PlatformStatusFull,
} from "@/lib/admin";
import { appState, type App } from "@/lib/apps";
import { bytes, percent, seconds, share } from "@/lib/format";
import { frameworkName } from "@/lib/github";

export default function AdminOverview() {
  const [analytics, setAnalytics] = useState<PlatformAnalytics | null>(null);
  const [status, setStatus] = useState<PlatformStatusFull | null>(null);
  const [host, setHost] = useState<HostMetrics | null>(null);
  const [apps, setApps] = useState<App[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Re-read the moment the server reports a change (lib/live.ts).
  const [liveTick, setLiveTick] = useState(0);
  useLive(() => setLiveTick((n) => n + 1));

  useEffect(() => {
    let active = true;
    const load = () => {
      getAnalytics().then((a) => active && setAnalytics(a)).catch(() => undefined);
      getPlatformStatusFull().then((s) => active && setStatus(s)).catch(() => undefined);
      getHostMetrics("1h").then((h) => {
        if (!active) return;
        setHost(h);
        setNow(Date.now());
      }).catch(() => undefined);
      adminApps().then((a) => active && setApps(a)).catch(() => undefined);
    };
    load();
    const t = setInterval(load, 20_000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [liveTick]);

  const latest = host?.latest;
  const attention = (apps ?? []).filter((a) => {
    const s = appState(a);
    return s.tone === "danger";
  });

  const services: { key: keyof PlatformStatusFull; label: string }[] = [
    { key: "docker", label: "Docker" },
    { key: "redis", label: "Queue (Redis)" },
    { key: "router", label: "Router" },
    { key: "registry", label: "Registry" },
    { key: "buildpacks", label: "Buildpacks" },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>Platform</Eyebrow>
          <h1 className="mt-3 text-[2rem] font-semibold leading-tight">Overview</h1>
          <p className="mt-1.5 text-sm text-[var(--text-muted)]">The machine every student&apos;s app shares, and how it is doing.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {status ? services.map((svc) => {
            const ok = Boolean(status[svc.key]);
            return (
              <Link key={svc.key} href="/admin/infrastructure" title={status.detail[svc.key as string] ?? "Operational"}>
                <Badge tone={ok ? "ok" : "danger"}><Dot tone={ok ? "ok" : "danger"} pulse={ok} />{svc.label}</Badge>
              </Link>
            );
          }) : <Skeleton className="h-6 w-80" />}
        </div>
      </div>

      {/* --- KPIs ----------------------------------------------------------- */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Students" value={analytics ? analytics.users - analytics.admins : "—"}
          hint={analytics ? `${analytics.github_connections} connected GitHub · ${analytics.blocked_users} blocked` : undefined}
          icon={<UsersIcon />} />
        <StatTile label="Apps running" value={analytics ? analytics.running : "—"}
          hint={analytics ? `of ${analytics.repositories} apps · ${analytics.suspended} suspended` : undefined}
          trend={host?.series.apps} icon={<BoxIcon />} tone={analytics && analytics.running > 0 ? "ok" : undefined} />
        <StatTile label="Build success" value={analytics?.success_rate == null ? "—" : share(analytics.success_rate)}
          hint={analytics ? `median ${seconds(analytics.build_seconds_median)} · slowest ${seconds(analytics.build_seconds_max)}` : undefined}
          tone={analytics?.success_rate == null ? undefined : analytics.success_rate >= 0.8 ? "ok" : analytics.success_rate >= 0.5 ? "warn" : "danger"} />
        <Link href="/admin/queue" className="block">
          <StatTile label="Build queue" value={status ? status.builds_running : "—"}
            hint={status ? `building now · ${status.builds_waiting} waiting · ${status.build_backend === "actions" ? "GitHub Actions" : "this server"}` : undefined}
            trend={host?.series.builds} icon={<QueueIcon />} />
        </Link>
      </div>

      {/* --- Machine -------------------------------------------------------- */}
      <div className="grid gap-4 lg:h-[19rem] lg:grid-cols-[1.6fr_1fr]">
        <ChartPanel title="Machine CPU" value={latest ? percent(latest.cpu) : "—"}
          caption={latest?.cpus ? `${latest.cpus} cores · last hour` : "last hour"}>
          <TimeSeries domain={[now - 3_600_000, now]}
            series={[{ key: "cpu", label: "CPU", points: host?.series.cpu ?? [] }]}
            format={(v, d) => `${v.toFixed(d ?? 1)}%`} />
        </ChartPanel>
        <Panel title="Memory in use" icon={<CpuIcon className="h-4 w-4" />}
          action={<Link href="/admin/infrastructure" className="inline-flex items-center gap-1 font-medium text-[var(--text-muted)] hover:text-[var(--text)]">
            Containers <ChevronRight className="h-3.5 w-3.5" /></Link>}
          bodyClassName="flex flex-col justify-between gap-4">
          <div>
            <p className="tabular text-[22px] font-semibold leading-none">{latest ? bytes(latest.mem) : "—"}</p>
            <p className="mt-1.5 text-xs text-[var(--text-dim)]">of {latest?.mem_total ? bytes(latest.mem_total) : "—"} available to Docker</p>
            <Meter className="mt-3" value={latest?.mem ?? 0} max={latest?.mem_total || 1} />
          </div>
          <dl className="grid grid-cols-4 gap-3 border-t border-[var(--hairline)] pt-4 text-sm">
            {[
              ["Containers", latest?.containers ?? "—", ""],
              ["Deploys", analytics?.deployments ?? "—", ""],
              ["Failed", analytics?.failed ?? "—", "text-[var(--danger)]"],
              ["Stopped", analytics?.stopped ?? "—", ""],
            ].map(([label, value, tone]) => (
              <div key={String(label)}>
                <dt className="text-[11px] text-[var(--text-dim)]">{label}</dt>
                <dd className={cx("tabular mt-1 text-lg font-semibold", String(tone))}>{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>

      {/* --- Attention + deploys ------------------------------------------- */}
      <div className="grid gap-4 lg:h-[22rem] lg:grid-cols-[1fr_1.4fr]">
        <Panel title="Needs attention" hint="Failed or suspended apps. Everything else is fine." flush
          action={<Link href="/admin/apps" className="font-medium text-[var(--text-muted)] hover:text-[var(--text)]">All apps →</Link>}>
          {apps === null ? <div className="p-5"><Skeleton className="h-40" /></div> : attention.length === 0 ? (
            <PanelEmpty icon={<CheckIcon className="h-6 w-6 text-[var(--ok)]" />} title="Nothing is failing right now">
              Failed builds, apps that crash on start, and suspended apps appear here.
            </PanelEmpty>
          ) : (
            <ul className="divide-y divide-[var(--hairline)]">
              {attention.map((a) => {
                const st = appState(a);
                return (
                  <li key={a.id}>
                    <Link href={`/admin/apps/${a.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--surface-2)]">
                      {st.label === "Suspended" ? <BanIcon className="h-4 w-4 shrink-0 text-[var(--danger)]" /> : <AlertIcon className="h-4 w-4 shrink-0 text-[var(--danger)]" />}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{a.target_label}</p>
                        <p className="truncate text-xs text-[var(--text-dim)]">{a.owner_email} · {a.current?.error_message ?? st.label}</p>
                      </div>
                      <Badge tone="danger">{st.label}</Badge>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <ChartPanel title="Deployments per day" value={analytics ? analytics.daily.reduce((n, d) => n + d.count, 0) : "—"}
          caption="last 14 days">
          <StackedBars days={(analytics?.daily ?? []).map((d) => d.date)}
            parts={[{ key: "d", label: "Deployments", color: "var(--series-1)", values: (analytics?.daily ?? []).map((d) => d.count) }]}
          />
        </ChartPanel>
      </div>

      {/* --- Breakdown ---------------------------------------------------- */}
      <div className="grid gap-4 lg:h-[15rem] lg:grid-cols-3">
        <Panel title="How apps are built">
          {analytics ? (Object.keys(analytics.by_method).length ? (
            <ProportionBar items={Object.entries(analytics.by_method).map(([k, v]) => ({
              label: k === "docker" ? "Dockerfile" : k === "compose" ? "Compose" : k === "buildpack" ? "Buildpacks" : k, value: v,
            }))} />
          ) : <PanelEmpty title="No builds yet" />) : <Skeleton className="h-12" />}
        </Panel>
        <Panel title="Frameworks">
          {analytics ? (Object.keys(analytics.by_framework).length ? (
            <ProportionBar items={Object.entries(analytics.by_framework).map(([k, v]) => ({ label: frameworkName(k), value: v }))} />
          ) : <PanelEmpty title="None detected yet" />) : <Skeleton className="h-12" />}
        </Panel>
        <Panel title="Busiest students">
          {analytics ? (
            analytics.top_users.length ? (
              <RankedBars rows={analytics.top_users.slice(0, 8).map((u) => ({
                label: u.email, value: u.deployments, hint: <span className={cx(u.running > 0 && "text-[var(--ok)]")}>· {u.running} live</span>,
              }))} format={(v) => `${v} deploys`} />
            ) : <PanelEmpty title="No deployments yet" />
          ) : <Skeleton className="h-32" />}
        </Panel>
      </div>
    </div>
  );
}
