/**
 * An app at a glance: is it up, how fast is it, what is it using, how do its
 * builds go, and what happened to it lately.
 *
 * Numbers lead and charts support them — the first row answers "is it
 * healthy?" before anyone has to read a graph.
 */

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useApp } from "@/components/app/AppFrame";
import { ActivityList } from "@/components/app/ActivityList";
import { DeploymentRow } from "@/components/app/DeploymentRow";
import { ChartPanel, Meter, Sparkline, StackedBars, StatTile } from "@/components/charts";
import { ChevronRight, CpuIcon, GlobeIcon, HistoryIcon, PulseIcon, UndoIcon } from "@/components/Icons";
import { Mono, Panel, PanelEmpty, Skeleton, cx, relativeTime } from "@/components/ui";
import { appIsBusy, type Activity, type AppMetrics } from "@/lib/apps";
import { bytes, ms, percent, seconds, share } from "@/lib/format";
import { isRunning } from "@/lib/deployments";

export default function AppOverview() {
  const { app, api } = useApp();
  const [metrics, setMetrics] = useState<AppMetrics | null>(null);
  const [activity, setActivity] = useState<Activity[] | null>(null);
  const live = app.current && isRunning(app.current.status) ? app.current : null;

  useEffect(() => {
    let active = true;
    const load = () => {
      api.metrics(app.id, "1h").then((m) => active && setMetrics(m)).catch(() => undefined);
      api.activity(app.id).then((a) => active && setActivity(a)).catch(() => undefined);
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [api, app.id]);

  const s = app.stats;
  const windowOk = s.daily.reduce((n, d) => n + d.succeeded, 0);
  const windowTotal = windowOk + s.daily.reduce((n, d) => n + d.failed, 0);
  const latest = metrics?.latest;
  const memLimit = latest?.mem_limit ?? 0;

  return (
    <div className="space-y-8">
      {/* --- Health --------------------------------------------------------- */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Uptime · 1h"
          value={metrics ? (metrics.summary.uptime == null ? "—" : share(metrics.summary.uptime, 1)) : "…"}
          tone={metrics?.summary.uptime == null ? undefined : metrics.summary.uptime >= 0.99 ? "ok" : metrics.summary.uptime >= 0.9 ? "warn" : "danger"}
          hint={live ? "share of probes that answered" : "not running"}
          icon={<GlobeIcon />}
        />
        <StatTile
          label="Response time"
          value={metrics ? ms(metrics.summary.latency_p50) : "…"}
          hint={metrics?.summary.latency_p95 != null ? `p95 ${ms(metrics.summary.latency_p95)}` : "median over the hour"}
          trend={metrics?.series.latency}
          icon={<PulseIcon />}
        />
        <StatTile
          label="CPU"
          value={latest ? percent(latest.cpu) : "—"}
          hint={metrics?.summary.cpu_max != null ? `peak ${percent(metrics.summary.cpu_max)} this hour` : "of one core"}
          trend={metrics?.series.cpu}
          icon={<CpuIcon />}
        />
        <div className="plate flex flex-col justify-between gap-3 px-5 py-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">Memory</p>
          <div>
            <p className="text-[28px] font-semibold leading-none">{latest ? bytes(latest.mem) : "—"}</p>
            <p className="mt-2 text-xs text-[var(--text-dim)]">{memLimit ? `of ${bytes(memLimit)} limit` : "limit applies while running"}</p>
          </div>
          <Meter value={latest?.mem ?? 0} max={memLimit || 1} />
        </div>
      </div>

      {/* Two rows of fixed height: side-by-side panels always line up, and
          whichever holds more scrolls inside itself. */}
      <div className="grid gap-4 lg:h-[25rem] lg:grid-cols-[1.35fr_1fr]">
        <Panel
          title={live ? "Production deployment" : "Latest deployment"}
          hint={app.current ? `Created ${relativeTime(app.current.created_at)}` : "This app has never been built."}
          action={app.current && (
            <Link href={api.deploymentHref(app.current.id)}
              className="inline-flex items-center gap-1 font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text)]">
              Details <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          )}
          footer={app.current?.url ? <span className="font-[family-name:var(--font-jetbrains-mono)]">{app.current.url.replace(/^https?:\/\//, "")}</span> : undefined}
        >
          {app.current ? (
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Fact label="Status" value={app.current.status} />
              <Fact label="Commit" value={<Mono>{app.current.commit_sha?.slice(0, 12) ?? "—"}</Mono>} />
              <Fact label="Built with" value={app.current.build_method ?? "—"} />
              <Fact label="Build time" value={<>
                {seconds(
                  app.current.build_started_at && app.current.build_finished_at
                    ? (new Date(app.current.build_finished_at).getTime() - new Date(app.current.build_started_at).getTime()) / 1000
                    : null,
                )}
                {app.current.reused_from_id && <span className="text-[var(--info)]"> · image reused</span>}
              </>} />
              <Fact label="Listens on" value={app.current.app_port ? `port ${app.current.app_port}` : "—"} />
              <Fact label="Trigger" value={app.current.ci_trigger === "push" ? "Push to GitHub" : "Deploy button"} />
              <div className="sm:col-span-2">
                <Fact label="Image" value={<Mono className="break-all">{app.current.image_ref ?? (app.current.compose_project ? `compose stack ${app.current.compose_project}` : "—")}</Mono>} />
              </div>
              {app.current.compose_services && app.current.compose_services.length > 0 && (
                <div className="sm:col-span-2">
                  <dt className="text-[11px] uppercase tracking-wider text-[var(--text-dim)]">Services</dt>
                  <dd className="mt-1.5 flex flex-wrap gap-1.5">
                    {app.current.compose_services.map((svc) => (
                      <span key={svc} className={cx(
                        "rounded-full border px-2.5 py-0.5 text-xs",
                        svc === app.current?.compose_web_service
                          ? "border-[var(--ok)]/30 bg-[var(--ok-soft)] text-[var(--ok)]"
                          : "border-[var(--hairline)] text-[var(--text-muted)]",
                      )}>
                        {svc}{svc === app.current?.compose_web_service ? " · public" : ""}
                      </span>
                    ))}
                  </dd>
                </div>
              )}
              {app.current.status === "failed" && app.current.error_message && (
                <div className="sm:col-span-2 rounded-[var(--r-sm)] border border-[var(--danger)]/20 bg-[var(--danger-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--danger)]">
                  {app.current.error_message}
                </div>
              )}
            </dl>
          ) : (
            <PanelEmpty title="Not built yet">Press Redeploy to build it for the first time.</PanelEmpty>
          )}
        </Panel>

        <ChartPanel
          title="Builds · last 14 days"
          value={windowTotal}
          caption={<>{windowTotal ? `${share(windowOk / windowTotal)} succeeded` : "none in this window"}<br />
            {s.success_rate == null ? "" : `${share(s.success_rate)} of all ${s.builds}`}</>}
          footer={<>
            <span>Median build {seconds(s.build_seconds_median)} · last {seconds(s.build_seconds_last)}</span>
            {s.build_seconds_trend.length > 1 && <Sparkline points={s.build_seconds_trend} label="recent build durations" />}
          </>}
        >
          <StackedBars
            days={s.daily.map((d) => d.date)}
            parts={[
              { key: "ok", label: "Succeeded", color: "var(--ok)", values: s.daily.map((d) => d.succeeded) },
              { key: "failed", label: "Failed", color: "var(--danger)", values: s.daily.map((d) => d.failed) },
            ]}
          />
        </ChartPanel>
      </div>

      <div className="grid gap-4 lg:h-[26rem] lg:grid-cols-[1.35fr_1fr]">
        <Panel
          title="Recent deployments"
          hint="Roll back to any that built successfully — it runs that exact image again."
          action={
            <Link href={`${api.base}/${app.id}/deployments`} className="font-medium text-[var(--text-muted)] hover:text-[var(--text)]">
              All {app.deployment_count} →
            </Link>
          }
          flush
          bodyClassName="flex flex-col"
        >
          {app.deployments.length === 0 ? (
            <PanelEmpty icon={<HistoryIcon className="h-6 w-6" />} title="No deployments yet">
              Each build becomes a version you can return to.
            </PanelEmpty>
          ) : (
            <>
              <div className="divide-y divide-[var(--hairline)] border-b border-[var(--hairline)]">
                {app.deployments.slice(0, 12).map((d) => (
                  <DeploymentRow key={d.id} deployment={d} isCurrent={d.id === app.current?.id} compact />
                ))}
              </div>
              {/* A short history leaves room: use it to say how history grows,
                  rather than leaving a hole beside a full activity feed. */}
              {app.deployments.length < 4 && (
                <PanelEmpty grow icon={<UndoIcon className="h-5 w-5" />} title="Every deploy is a version you can return to">
                  {api.mode === "owner"
                    ? "Redeploy or push a commit and it appears here. A broken release is one click from the version before it — no rebuild."
                    : "Each build the owner makes appears here, and any that built can be restored in one click."}
                </PanelEmpty>
              )}
            </>
          )}
        </Panel>

        <Panel
          title="Activity"
          icon={<HistoryIcon className="h-4 w-4" />}
          hint={appIsBusy(app) ? "Updating live." : "Everything that happened to this app."}
          action={<Link href={`${api.base}/${app.id}/activity`} className="font-medium text-[var(--text-muted)] hover:text-[var(--text)]">All →</Link>}
          flush
        >
          {activity === null ? <div className="p-5"><Skeleton className="h-40" /></div> : <ActivityList items={activity.slice(0, 30)} showApp={false} flush />}
        </Panel>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wider text-[var(--text-dim)]">{label}</dt>
      <dd className="mt-1 truncate text-sm">{value}</dd>
    </div>
  );
}
