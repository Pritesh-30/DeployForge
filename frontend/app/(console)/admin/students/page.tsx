/**
 * Every account, with how much of the machine it is using and the levers to
 * limit it.
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { QuotaStepper, StudentActions } from "@/components/admin/StudentControls";
import { Meter } from "@/components/charts";
import { GitHubIcon, SearchIcon } from "@/components/Icons";
import { useSession } from "@/components/Session";
import { Badge, Eyebrow, Skeleton, cx, relativeTime } from "@/components/ui";
import { getOverview, type UserWithDeployments } from "@/lib/admin";
import { fuzzyMatch } from "@/lib/fuzzy";

type Filter = "all" | "active" | "blocked" | "disabled" | "admins";

export default function StudentsPage() {
  const { user: me } = useSession();
  const [rows, setRows] = useState<UserWithDeployments[] | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(() => getOverview().then(setRows).catch(() => setRows([])), []);
  useEffect(() => {
    load();
  }, [load]);

  const shown = useMemo(() => {
    let list = (rows ?? []).filter((u) => {
      if (filter === "admins") return u.role === "admin";
      if (filter === "active") return u.is_active && u.can_deploy && u.role !== "admin";
      if (filter === "blocked") return !u.can_deploy;
      if (filter === "disabled") return !u.is_active;
      return true;
    });
    if (query.trim()) {
      list = list.map((u) => ({ u, m: fuzzyMatch(query, `${u.email} ${u.github_username ?? ""}`) }))
        .filter((x) => x.m).sort((a, b) => b.m!.score - a.m!.score).map((x) => x.u);
    }
    return list;
  }, [rows, query, filter]);

  return (
    <div className="space-y-8">
      <div>
        <Eyebrow>Platform</Eyebrow>
        <h1 className="mt-3 text-[2rem] font-semibold leading-tight">Students</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[var(--text-muted)]">
          Every account. Raise or lower how many apps someone may run, block their deploys while leaving them signed in, or disable the account.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-60 flex-1 items-center gap-2 rounded-full border border-[var(--hairline-strong)] bg-[var(--surface)] px-3.5 py-2 sm:max-w-sm">
          <SearchIcon className="h-3.5 w-3.5 text-[var(--text-dim)]" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Email or GitHub name…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--text-dim)]" />
        </label>
        {(["all", "active", "blocked", "disabled", "admins"] as Filter[]).map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={cx("rounded-full border px-3 py-1.5 text-xs font-medium capitalize transition-colors",
              filter === f ? "border-[var(--hairline-strong)] bg-[var(--surface-2)] text-[var(--text)]" : "border-[var(--hairline)] text-[var(--text-dim)] hover:text-[var(--text-muted)]")}>
            {f}
          </button>
        ))}
      </div>

      {rows === null ? (
        <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : (
        <div className="plate thin-scroll table-frame">
          <table className="w-full min-w-[60rem] text-sm">
            <thead>
              <tr className="border-b border-[var(--hairline)] text-left text-[11px] uppercase tracking-[0.12em] text-[var(--text-dim)]">
                <th className="px-4 py-3 font-medium">Account</th>
                <th className="px-4 py-3 font-medium">State</th>
                <th className="px-4 py-3 font-medium">Running</th>
                <th className="px-4 py-3 font-medium">Quota</th>
                <th className="px-4 py-3 text-right font-medium">Apps · builds</th>
                <th className="px-4 py-3 font-medium">Joined</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--hairline)]">
              {shown.map((u) => {
                return (
                  <tr key={u.id} className="hover:bg-[oklch(100%_0_0/0.02)]">
                    <td className="max-w-[18rem] px-4 py-3">
                      <Link href={`/admin/students/${u.id}`} className="block truncate font-medium hover:text-[var(--accent)]">{u.email}</Link>
                      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--text-dim)]">
                        <GitHubIcon className="h-3 w-3" />{u.github_username ?? "not connected"}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        {u.role === "admin" && <Badge tone="accent">Admin</Badge>}
                        {!u.is_active ? <Badge tone="danger">Disabled</Badge> : !u.can_deploy ? <Badge tone="warn">Deploys blocked</Badge> : u.role !== "admin" && <Badge tone="ok">Active</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {u.role === "admin" ? <span className="text-xs text-[var(--text-dim)]">—</span> : (
                        <div className="w-28">
                          <p className="tabular mb-1.5 text-xs text-[var(--text-muted)]">{u.running_count} of {u.max_deployments}</p>
                          <Meter value={u.running_count} max={Math.max(1, u.max_deployments)} />
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">{u.role !== "admin" && <QuotaStepper user={u} onChanged={load} />}</td>
                    <td className="tabular px-4 py-3 text-right text-xs text-[var(--text-muted)]">{u.repository_count} · {u.deployment_count}</td>
                    <td className="px-4 py-3 text-xs text-[var(--text-muted)]">{relativeTime(u.created_at)}</td>
                    <td className="px-4 py-3">{u.role !== "admin" && <StudentActions user={u} self={u.id === me.id} onChanged={load} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {shown.length === 0 && <p className="px-4 py-10 text-center text-sm text-[var(--text-dim)]">No accounts match.</p>}
        </div>
      )}
    </div>
  );
}
