/**
 * What this account is using, and the limits it runs within.
 *
 * Limits on a shared machine are easier to live with when they are visible:
 * how many apps may run at once, what each app may use, how fast deploys may
 * come — and what each app is actually using now.
 */

"use client";

import { useEffect, useMemo, useState } from "react";

import { Meter, RankedBars, StatTile } from "@/components/charts";
import { useSession } from "@/components/Session";
import { CpuIcon, GaugeIcon } from "@/components/Icons";
import { Eyebrow, Panel, PanelEmpty, Skeleton } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { appsPulse, listApps, type App, type AppPulse } from "@/lib/apps";
import { isRunning, type Deployment } from "@/lib/deployments";
import { bytes, percent } from "@/lib/format";

export default function UsagePage() {
  const { user, meta } = useSession();
  const [apps, setApps] = useState<App[] | null>(null);
  const [pulse, setPulse] = useState<Record<string, AppPulse>>({});
  const [deployments, setDeployments] = useState<Deployment[]>([]);

  useEffect(() => {
    let active = true;
    listApps().then((a) => active && setApps(a)).catch(() => active && setApps([]));
    appsPulse().then((p) => active && setPulse(p)).catch(() => undefined);
    apiFetch<Deployment[]>("/deployments?limit=200").then((d) => active && setDeployments(d)).catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const quota = user.max_deployments ?? 3;
  const running = (apps ?? []).filter((a) => a.current && isRunning(a.current.status));
  const month = new Date().toISOString().slice(0, 7);
  const buildMinutes = useMemo(
    () =>
      deployments
        .filter((d) => d.created_at.startsWith(month) && d.build_started_at && d.build_finished_at)
        .reduce((sum, d) => sum + (new Date(d.build_finished_at!).getTime() - new Date(d.build_started_at!).getTime()) / 60000, 0),
    [deployments, month],
  );
  const totalMem = running.reduce((s, a) => s + (pulse[a.id]?.latest?.mem ?? 0), 0);
  const totalCpu = running.reduce((s, a) => s + (pulse[a.id]?.latest?.cpu ?? 0), 0);

  return (
    <div className="space-y-6">
      <div>
        <Eyebrow>Account</Eyebrow>
        <h1 className="mt-3 text-[2rem] font-semibold leading-tight">Usage &amp; limits</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[var(--text-muted)]">
          This platform runs every student&apos;s apps on one shared machine, so each account runs within limits an administrator sets.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="plate flex flex-col justify-between gap-3 px-5 py-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">Apps running</p>
          <p className="text-[28px] font-semibold leading-none">{apps ? running.length : "—"}<span className="text-base font-normal text-[var(--text-dim)]"> / {quota}</span></p>
          <Meter value={running.length} max={quota} />
        </div>
        <StatTile label="Memory in use" value={bytes(totalMem)} hint={`across ${running.length} running app${running.length === 1 ? "" : "s"}`} />
        <StatTile label="CPU in use" value={percent(totalCpu)} hint="of one core, summed" />
        <StatTile label="Build minutes" value={buildMinutes.toFixed(1)} hint="this month" />
      </div>

      <div className="grid gap-4 lg:h-[26rem] lg:grid-cols-2">
        <Panel title="Memory by app" icon={<CpuIcon className="h-4 w-4" />} hint="Live, sampled every few seconds."
          footer={running.length > 0 && meta?.app_memory_limit ? <>Each app may use up to {meta.app_memory_limit}.</> : undefined}>
          {apps === null ? <Skeleton className="h-32" /> : running.length === 0 ? (
            <PanelEmpty icon={<CpuIcon className="h-6 w-6" />} title="Nothing is running right now">
              Start or deploy an app and its memory use shows up here within a few seconds.
            </PanelEmpty>
          ) : (
            <RankedBars format={(v) => bytes(v)}
              rows={running.map((a) => ({ label: a.name, value: pulse[a.id]?.latest?.mem ?? 0 }))
                .sort((x, y) => y.value - x.value)} />
          )}
        </Panel>
        <Panel title="Limits" icon={<GaugeIcon className="h-4 w-4" />} hint="What each app may use, and how fast deploys may come." flush>
          <dl className="divide-y divide-[var(--hairline)]">
            {[
              ["Apps running at once", `${quota}`, "Raise it by asking an administrator."],
              ["Memory per app", meta?.app_memory_limit ?? "—", "An app that needs more is stopped by the kernel, not slowed."],
              ["CPU per app", meta ? `${meta.app_cpu_limit} core${meta.app_cpu_limit === "1.0" ? "" : "s"}` : "—", "A busy app is throttled, not stopped."],
              ["Processes per app", meta ? String(meta.app_pids_limit) : "—", "Stops a runaway fork from taking the machine."],
              ["Deploys", meta ? `${meta.rate_limit_deploy_burst} at once, then ${meta.rate_limit_deploys_per_hour} an hour` : "—", "Includes rollbacks."],
              ["Can deploy", user.can_deploy === false ? "No" : "Yes", user.deploy_block_reason ?? "Set by an administrator."],
            ].map(([k, v, hint]) => (
              <div key={k} className="flex items-start justify-between gap-6 px-5 py-3.5">
                <div>
                  <dt className="text-sm">{k}</dt>
                  <p className="mt-0.5 text-xs text-[var(--text-dim)]">{hint}</p>
                </div>
                <dd className="tabular shrink-0 text-sm font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    </div>
  );
}
