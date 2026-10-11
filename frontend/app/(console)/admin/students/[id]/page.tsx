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
import { Meter, StatTile } from "@/components/charts";
import { ArrowLeft, ExternalIcon, GitHubIcon } from "@/components/Icons";
import { useSession } from "@/components/Session";
import { Alert, Badge, Dot, SectionTitle, Skeleton, relativeTime } from "@/components/ui";
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
    <div className="space-y-8">
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

      <section>
        <SectionTitle hint="Open one to run, redeploy, roll back, read its logs or suspend it.">Apps</SectionTitle>
        {data.apps.length === 0 ? (
          <p className="text-sm text-[var(--text-dim)]">No apps yet.</p>
        ) : (
          <ul className="plate divide-y divide-[var(--hairline)] overflow-hidden">
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
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <SectionTitle>Recent activity</SectionTitle>
          <ActivityList items={data.activity.slice(0, 12)} hrefFor={(a) => `/admin/apps/${a.app_id}`} />
        </section>
        <section>
          <SectionTitle hint="Every administrator action on this account or its apps.">Administrator actions</SectionTitle>
          {data.audit.length === 0 ? (
            <p className="rounded-[var(--r)] border border-dashed border-[var(--hairline-strong)] px-4 py-10 text-center text-sm text-[var(--text-dim)]">None.</p>
          ) : (
            <ol className="plate divide-y divide-[var(--hairline)] overflow-hidden">
              {data.audit.map((e) => (
                <li key={e.id} className="px-4 py-3 text-sm">
                  <p><span className="font-medium">{e.action}</span> <span className="text-[var(--text-muted)]">{e.target_label}</span></p>
                  <p className="mt-0.5 text-xs text-[var(--text-dim)]">by {e.actor_email} · {relativeTime(e.created_at)}
                    {e.detail && Object.keys(e.detail).length > 0 && <> · {Object.entries(e.detail).map(([k, v]) => `${k}: ${String(v)}`).join(", ")}</>}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
