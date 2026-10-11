/**
 * One student in full: their apps and what each is doing, their usage,
 * what has happened recently, and everything administrators have done to
 * their account and apps.
 */

"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { ActivityList } from "@/components/app/ActivityList";
import { MakeAdmin, QuotaStepper, StudentActions } from "@/components/admin/StudentControls";
import { Meter, RankedBars, StatTile } from "@/components/charts";
import { ArrowLeft, BoxIcon, ExternalIcon, GitHubIcon, HistoryIcon, ShieldIcon } from "@/components/Icons";
import { useSession } from "@/components/Session";
import { Alert, Badge, Dot, Panel, PanelEmpty, Skeleton, relativeTime } from "@/components/ui";
import { getUserDetail, type UserDetail } from "@/lib/admin";
import { appKind, appState } from "@/lib/apps";
import { isRunning } from "@/lib/deployments";

export default function StudentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user: me } = useSession();
  const [data, setData] = useState<UserDetail | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    getUserDetail(id).then(setData).catch((e) => setError(e instanceof Error ? e.message : "Could not load the account."));
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <Alert>{error}</Alert>;
  if (!data) return <div className="space-y-4"><Skeleton className="h-28" /><Skeleton className="h-64" /></div>;

  const u = data.user;
  const usage = data.usage;

  return (
    <div className="space-y-6">
      <Link href="/admin/students" className="inline-flex items-center gap-2 text-sm text-[var(--text-dim)] hover:text-[var(--text)]">
        <ArrowLeft className="h-3.5 w-3.5" />Students
      </Link>

      <header className="plate flex flex-col gap-5 p-6 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[1.6rem] font-semibold leading-tight">{u.email}</h1>
            {u.role === "admin" && <Badge tone="accent">Administrator</Badge>}
            {!u.is_active ? <Badge tone="danger">Disabled</Badge> : u.can_deploy === false ? <Badge tone="warn">Deploys blocked</Badge> : <Badge tone="ok">Active</Badge>}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-[var(--text-muted)]">
            <span className="inline-flex items-center gap-1.5">
              <GitHubIcon className="h-3.5 w-3.5" />
              {data.github_username ? (
                <a href={`https://github.com/${data.github_username}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-[var(--text)]">
                  {data.github_username}<ExternalIcon className="h-3 w-3" />
                </a>
              ) : "GitHub not connected"}
            </span>
            <span>Joined {relativeTime(u.created_at)}</span>
          </div>
          {u.can_deploy === false && u.deploy_block_reason && (
            <p className="mt-3 text-sm text-[var(--warn)]">Blocked: {u.deploy_block_reason}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {u.role !== "admin" && (
            <>
              <span className="text-xs text-[var(--text-dim)]">Apps at once</span>
              <QuotaStepper user={u} onChanged={load} />
              <StudentActions user={u} self={u.id === me.id} onChanged={load} />
              <MakeAdmin user={u} onChanged={load} />
            </>
          )}
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="plate flex flex-col justify-between gap-3 px-5 py-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">Running</p>
          <p className="text-[28px] font-semibold leading-none">{usage.running}<span className="text-base font-normal text-[var(--text-dim)]"> / {usage.quota}</span></p>
          <Meter value={usage.running} max={Math.max(1, usage.quota)} />
        </div>
        <StatTile label="Apps" value={usage.apps} hint="connected repositories" />
        <StatTile label="Builds" value={usage.builds} hint={`${usage.failed} failed`} tone={usage.failed > 0 ? "warn" : undefined} />
        <StatTile label="Build minutes" value={usage.build_minutes} hint="all time" />
      </div>

      <div className="grid gap-4 lg:h-[26rem] lg:grid-cols-[1.2fr_1fr]">
        <Panel title="Apps" icon={<BoxIcon className="h-4 w-4" />}
          hint="Open one to run, redeploy, roll back, read its logs or suspend it." flush
          bodyClassName="flex flex-col"
          action={<Badge>{data.apps.length}</Badge>}>
          {data.apps.length === 0 ? (
            <PanelEmpty icon={<BoxIcon className="h-6 w-6" />} title="No apps yet">
              Apps appear here once this student connects a repository and deploys it.
            </PanelEmpty>
          ) : (
            <ul className="divide-y divide-[var(--hairline)]">
              {data.apps.map((a) => {
                const s = appState(a);
                const live = a.current && isRunning(a.current.status) ? a.current : null;
                return (
                  <li key={a.id}>
                    <Link href={`/admin/apps/${a.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--surface-2)]">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{a.target_label}</p>
                        <p className="truncate text-xs text-[var(--text-dim)]">
                          {appKind(a)} · {a.deployment_count} build{a.deployment_count === 1 ? "" : "s"}
                          {live?.url && <> · <span className="text-[var(--ok)]">{live.url.replace(/^https?:\/\//, "")}</span></>}
                        </p>
                      </div>
                      <Badge tone={s.tone}><Dot tone={s.tone} pulse={s.live} />{s.label}</Badge>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {/* A short list leaves room: use it for where the builds went. */}
          {data.apps.length > 0 && data.apps.length < 6 && (
            <div className="mt-auto border-t border-[var(--hairline)] px-5 py-3">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">Builds per app</p>
              <RankedBars format={(v) => `${v} build${v === 1 ? "" : "s"}`}
                rows={[...data.apps].sort((a, b) => b.deployment_count - a.deployment_count)
                  .map((a) => ({ label: a.target_label, value: a.deployment_count }))} />
            </div>
          )}
        </Panel>
        <Panel title="Recent activity" icon={<HistoryIcon className="h-4 w-4" />} flush>
          <ActivityList items={data.activity.slice(0, 40)} hrefFor={(a) => `/admin/apps/${a.app_id}`} flush />
        </Panel>
      </div>

      <Panel title="Administrator actions" icon={<ShieldIcon className="h-4 w-4" />}
        hint="Every administrator action on this account or its apps." flush className="max-h-[22rem]">
        {data.audit.length === 0 ? (
          <PanelEmpty icon={<ShieldIcon className="h-6 w-6" />} title="No administrator has acted on this account">
            Suspensions, quota changes, restarts and redeploys made by an administrator are recorded here with who made them.
          </PanelEmpty>
        ) : (
          <ol className="divide-y divide-[var(--hairline)]">
            {data.audit.map((e) => (
              <li key={e.id} className="px-5 py-3 text-sm">
                <p><span className="font-medium">{e.action}</span> <span className="text-[var(--text-muted)]">{e.target_label}</span></p>
                <p className="mt-0.5 text-xs text-[var(--text-dim)]">by {e.actor_email} · {relativeTime(e.created_at)}
                  {e.detail && Object.keys(e.detail).length > 0 && <> · {Object.entries(e.detail).map(([k, v]) => `${k}: ${String(v)}`).join(", ")}</>}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}
