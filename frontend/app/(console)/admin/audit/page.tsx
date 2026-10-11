/**
 * Every administrator action, newest first: who did what, to whose app or
 * account, and why when they said.
 *
 * On a machine shared by a class, "who stopped my app?" deserves an answer
 * that does not depend on anyone's memory. Entries are append-only.
 */

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { ScrollIcon } from "@/components/Icons";
import { Badge, EmptyState, Eyebrow, Skeleton, cx, relativeTime } from "@/components/ui";
import { getAudit, type AuditEntry } from "@/lib/admin";
import { dateTime } from "@/lib/format";

const GROUPS: { key: string; label: string }[] = [
  { key: "", label: "Everything" },
  { key: "app.", label: "Apps" },
  { key: "user.", label: "Accounts" },
  { key: "queue.", label: "Queue" },
  { key: "deployment.", label: "Deployments" },
];

const TONE: Record<string, "danger" | "warn" | "ok" | "info" | "neutral"> = {
  "app.suspend": "danger", "app.delete": "danger", "deployment.delete": "danger", "user.disable": "danger",
  "user.block_deploy": "warn", "app.stop": "warn", "queue.cancel": "warn",
  "app.resume": "ok", "app.start": "ok", "user.enable": "ok", "user.allow_deploy": "ok",
  "app.redeploy": "info", "app.restart": "info", "app.rollback": "info", "user.quota": "info", "user.role": "info",
};

function describe(e: AuditEntry): string {
  const verbs: Record<string, string> = {
    "app.start": "started", "app.stop": "stopped", "app.restart": "restarted", "app.redeploy": "redeployed",
    "app.rollback": "rolled back", "app.suspend": "suspended", "app.resume": "lifted the suspension on",
    "app.delete": "deleted", "deployment.delete": "deleted a deployment of", "queue.cancel": "removed from the queue",
    "user.quota": "changed the quota of", "user.block_deploy": "blocked deploys for", "user.allow_deploy": "restored deploys for",
    "user.disable": "disabled", "user.enable": "enabled", "user.role": "changed the role of", "user.update": "updated",
  };
  return verbs[e.action] ?? e.action;
}

function targetHref(e: AuditEntry): string | null {
  if (e.target_type === "app" && e.action !== "app.delete" && e.target_id) return `/admin/apps/${e.target_id}`;
  if (e.target_type === "user" && e.target_id) return `/admin/students/${e.target_id}`;
  return null;
}

export default function AuditPage() {
  const [group, setGroup] = useState("");
  const [data, setData] = useState<{ events: AuditEntry[]; counts: Record<string, number> } | null>(null);

  useEffect(() => {
    let active = true;
    getAudit(group || undefined, 300).then((d) => active && setData(d)).catch(() => active && setData({ events: [], counts: {} }));
    return () => {
      active = false;
    };
  }, [group]);

  const totals = useMemo(() => {
    const c = data?.counts ?? {};
    const out: Record<string, number> = { "": 0 };
    for (const [action, n] of Object.entries(c)) {
      out[""] += n;
      for (const g of GROUPS.slice(1)) if (action.startsWith(g.key)) out[g.key] = (out[g.key] ?? 0) + n;
    }
    return out;
  }, [data]);

  return (
    <div className="space-y-8">
      <div>
        <Eyebrow>Operations</Eyebrow>
        <h1 className="mt-3 text-[2rem] font-semibold leading-tight">Audit log</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[var(--text-muted)]">
          Every action an administrator took on someone else&apos;s app or account. Students see the actions on their own apps in their activity feed.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {GROUPS.map((g) => (
          <button key={g.key} onClick={() => setGroup(g.key)}
            className={cx("rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              group === g.key ? "border-[var(--hairline-strong)] bg-[var(--surface-2)] text-[var(--text)]" : "border-[var(--hairline)] text-[var(--text-dim)] hover:text-[var(--text-muted)]")}>
            {g.label}<span className="tabular ml-1.5 text-[var(--text-dim)]">{totals[g.key] ?? 0}</span>
          </button>
        ))}
      </div>

      {data === null ? <Skeleton className="h-96" /> : data.events.length === 0 ? (
        <EmptyState icon={<ScrollIcon className="h-8 w-8" />} title="Nothing recorded yet">
          Starting, stopping, suspending or redeploying a student&apos;s app, or changing an account, is recorded here.
        </EmptyState>
      ) : (
        <ol className="plate divide-y divide-[var(--hairline)] overflow-hidden">
          {data.events.map((e) => {
            const href = targetHref(e);
            const detail = e.detail ? Object.entries(e.detail).filter(([k]) => k !== "deployment") : [];
            return (
              <li key={e.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-5 py-3.5">
                <Badge tone={TONE[e.action] ?? "neutral"} className="mt-0.5">{e.action}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-medium">{e.actor_email}</span>{" "}
                    <span className="text-[var(--text-muted)]">{describe(e)}</span>{" "}
                    {href ? <Link href={href} className="font-medium hover:text-[var(--accent)]">{e.target_label}</Link> : <span className="font-medium">{e.target_label}</span>}
                  </p>
                  {detail.length > 0 && (
                    <p className="mt-0.5 text-xs text-[var(--text-dim)]">
                      {detail.map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`).join(" · ")}
                    </p>
                  )}
                </div>
                <time className="shrink-0 text-xs text-[var(--text-dim)]" title={dateTime(e.created_at)}>{relativeTime(e.created_at)}</time>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
