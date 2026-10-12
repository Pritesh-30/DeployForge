/**
 * The student's home: are my apps up, how are my builds going, what
 * happened lately, and how much of my allowance am I using.
 */

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useLive } from "@/lib/live";

import { ActivityList } from "@/components/app/ActivityList";
import { ChartPanel, Meter, Sparkline, StackedBars, StatTile } from "@/components/charts";
import { ArrowRight, BoxIcon, ExternalIcon, GlobeIcon, PlusIcon, RocketIcon } from "@/components/Icons";
import { useSession } from "@/components/Session";
import { Alert, Badge, Button, Dot, EmptyState, Eyebrow, Panel, SectionTitle, Skeleton, relativeTime } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { appKind, appState, appsPulse, listApps, myActivity, type Activity, type App, type AppPulse } from "@/lib/apps";
import { isRunning, type Deployment } from "@/lib/deployments";
import { percent, seconds, share } from "@/lib/format";

const DAYS = 14;

function lastDays(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const day = new Date(d);
    day.setDate(d.getDate() - i);
    out.push(day.toISOString().slice(0, 10));
  }
  return out;
}

export default function DashboardPage() {
  const { user } = useSession();
  const [apps, setApps] = useState<App[] | null>(null);
  const [pulse, setPulse] = useState<Record<string, AppPulse>>({});
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [activity, setActivity] = useState<Activity[] | null>(null);

  // Re-read the moment the server reports a change (lib/live.ts).
  const [liveTick, setLiveTick] = useState(0);
  useLive(() => setLiveTick((n) => n + 1));

  useEffect(() => {
    let active = true;
    const load = () => {
      listApps().then((a) => active && setApps(a)).catch(() => active && setApps([]));
      appsPulse().then((p) => active && setPulse(p)).catch(() => undefined);
      apiFetch<Deployment[]>("/deployments?limit=200").then((d) => active && setDeployments(d)).catch(() => undefined);
      myActivity(40).then((a) => active && setActivity(a)).catch(() => active && setActivity([]));
    };
    load();
    const t = setInterval(load, 20_000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [liveTick]);

  const stats = useMemo(() => {
    const days = lastDays(DAYS);
    const ok = new Map(days.map((d) => [d, 0]));
    const bad = new Map(days.map((d) => [d, 0]));
    const durations: number[] = [];
    let finished = 0;
    let succeeded = 0;
    for (const d of deployments) {
      if (d.status === "analyzed") continue;
      const day = d.created_at.slice(0, 10);
      const success = ["built", "running", "live", "stopped", "starting"].includes(d.status);
      if (success || d.status === "failed") {
        finished++;
        if (success) succeeded++;
        if (ok.has(day)) (success ? ok : bad).set(day, (success ? ok : bad).get(day)! + 1);
      }
      if (success && d.build_started_at && d.build_finished_at) {
        durations.push((new Date(d.build_finished_at).getTime() - new Date(d.build_started_at).getTime()) / 1000);
      }
    }
    durations.sort((a, b) => a - b);
    const week = days.slice(-7);
    const windowOk = days.reduce((n, d) => n + (ok.get(d) ?? 0), 0);
    const windowBad = days.reduce((n, d) => n + (bad.get(d) ?? 0), 0);
    return {
      windowTotal: windowOk + windowBad,
      windowRate: windowOk + windowBad ? windowOk / (windowOk + windowBad) : null,
      days,
      ok: days.map((d) => ok.get(d) ?? 0),
      bad: days.map((d) => bad.get(d) ?? 0),
      rate: finished ? succeeded / finished : null,
      median: durations.length ? durations[Math.floor(durations.length / 2)] : null,
      thisWeek: week.reduce((n, d) => n + (ok.get(d) ?? 0) + (bad.get(d) ?? 0), 0),
      trend: days.map((d) => (ok.get(d) ?? 0) + (bad.get(d) ?? 0)),
    };
  }, [deployments]);

  const running = (apps ?? []).filter((a) => a.current && isRunning(a.current.status)).length;
  const failing = (apps ?? []).filter((a) => appState(a).tone === "danger").length;
  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  })();

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>Workspace</Eyebrow>
          <h1 className="mt-3 text-[2rem] font-semibold leading-tight">{greeting}</h1>
          <p className="mt-1.5 text-sm text-[var(--text-muted)]">
            {apps === null ? "Loading your apps…" : apps.length === 0 ? "Deploy your first app to get started." :
              `${running} of your ${apps.length} app${apps.length === 1 ? " is" : "s are"} live${failing ? ` · ${failing} need${failing === 1 ? "s" : ""} attention` : ""}.`}
          </p>
        </div>
        {user.can_deploy !== false && (
          <Link href="/dashboard/new">
            <Button variant="primary" trailing={<ArrowRight className="h-3 w-3" />}><RocketIcon className="h-4 w-4" />Deploy an app</Button>
          </Link>
        )}
      </div>

      {user.can_deploy === false && (
        <Alert tone="warn" title="Deploying is turned off for your account">
          {user.deploy_block_reason ?? "An administrator has revoked your permission to deploy."} Your apps keep running and you can still see everything here.
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="plate flex flex-col justify-between gap-3 px-5 py-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">Live apps</p>
          <div>
            <p className="text-[28px] font-semibold leading-none">{apps ? running : "—"}<span className="text-base font-normal text-[var(--text-dim)]"> / {user.max_deployments ?? 3}</span></p>
            <p className="mt-2 text-xs text-[var(--text-dim)]">running at once, of your limit</p>
          </div>
          <Meter value={running} max={user.max_deployments ?? 3} />
        </div>
        <StatTile label="Deployments · 7 days" value={stats.thisWeek} trend={stats.trend} hint="builds started" />
        <StatTile label="Build success" value={stats.rate == null ? "—" : share(stats.rate)}
          tone={stats.rate == null ? undefined : stats.rate >= 0.8 ? "ok" : stats.rate >= 0.5 ? "warn" : "danger"}
          hint="of finished builds, all time" />
        <StatTile label="Median build" value={seconds(stats.median)} hint="from source to image" />
      </div>

      {/* --- Apps ---------------------------------------------------------- */}
      <section>
        <SectionTitle action={<Link href="/apps" className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)]">All apps →</Link>}>
          Your apps
        </SectionTitle>
        {apps === null ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-40" />)}</div>
        ) : apps.length === 0 ? (
          <EmptyState icon={<BoxIcon className="h-8 w-8" />} title="Nothing deployed yet"
            action={<Link href="/dashboard/new"><Button variant="primary" size="lg"><PlusIcon className="h-4 w-4" />Deploy your first app</Button></Link>}>
            Connect GitHub, pick a repository, and DeployForge works out how to build it and gives it an address.
          </EmptyState>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {apps.slice(0, 6).map((a, i) => <AppTile key={a.id} app={a} pulse={pulse[a.id]} index={i} />)}
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:h-[24rem] lg:grid-cols-[1.25fr_1fr]">
        <ChartPanel title="Builds · last 14 days" value={stats.windowTotal}
          caption={stats.windowRate == null ? "none in this window" : `${share(stats.windowRate)} succeeded`}
          footer={<><span>Median build {seconds(stats.median)}</span><span>{stats.rate == null ? "" : `${share(stats.rate)} succeed, all time`}</span></>}>
          <StackedBars days={stats.days}
            parts={[
              { key: "ok", label: "Succeeded", color: "var(--ok)", values: stats.ok },
              { key: "bad", label: "Failed", color: "var(--danger)", values: stats.bad },
            ]} />
        </ChartPanel>
        <Panel title="Recent activity" hint="Across every app you own."
          action={<Link href="/activity" className="font-medium text-[var(--text-muted)] hover:text-[var(--text)]">All →</Link>}
          flush>
          {activity === null ? <div className="p-5"><Skeleton className="h-40" /></div> : (
            <ActivityList items={activity} hrefFor={(a) => `/apps/${a.app_id}`} flush />
          )}
        </Panel>
      </div>
    </div>
  );
}

function AppTile({ app, pulse, index }: { app: App; pulse?: AppPulse; index: number }) {
  const s = appState(app);
  const live = app.current && isRunning(app.current.status) ? app.current : null;
  return (
    <Link href={`/apps/${app.id}`}
      className="plate rise group flex flex-col gap-4 p-5 transition-[transform,border-color] duration-[var(--t-hover)] ease-[var(--ease-out)] hover:-translate-y-0.5 hover:border-[var(--hairline-strong)]"
      style={{ "--delay": `${index * 60}ms` } as React.CSSProperties}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold group-hover:text-[var(--accent)]">{app.name}</p>
          <p className="truncate text-xs text-[var(--text-dim)]">{app.full_name}{app.deploy_path ? ` · ${app.deploy_path}/` : ""}</p>
        </div>
        <Badge tone={s.tone}><Dot tone={s.tone} pulse={s.live} />{s.label}</Badge>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="space-y-1 text-xs text-[var(--text-dim)]">
          <p>{appKind(app)} · {app.default_branch}</p>
          <p>{app.last_deployed_at ? `Deployed ${relativeTime(app.last_deployed_at)}` : "Never deployed"}</p>
        </div>
        <div className="text-right">
          <Sparkline points={pulse?.cpu ?? []} width={90} height={26} label="CPU, last hour" />
          <p className="tabular mt-1 text-[11px] text-[var(--text-dim)]">
            {live && pulse?.latest ? `${percent(pulse.latest.cpu)} CPU` : "—"}
            {pulse?.uptime != null && ` · ${share(pulse.uptime)} up`}
          </p>
        </div>
      </div>
      {live?.url && (
        <span className="inline-flex items-center gap-1.5 truncate font-[family-name:var(--font-jetbrains-mono)] text-xs text-[var(--ok)]">
          <GlobeIcon className="h-3.5 w-3.5 shrink-0" />{live.url.replace(/^https?:\/\//, "")}<ExternalIcon className="h-3 w-3 shrink-0 opacity-60" />
        </span>
      )}
      {app.current?.status === "failed" && app.current.error_message && (
        <p className="line-clamp-2 text-xs text-[var(--danger)]">{app.current.error_message}</p>
      )}
    </Link>
  );
}
