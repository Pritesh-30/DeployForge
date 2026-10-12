/**
 * Every build across every app, newest first — the place to answer "what
 * did I deploy on Tuesday, and did it work?" without opening each app.
 */

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useLive } from "@/lib/live";

import StatusBadge from "@/components/StatusBadge";
import { ChevronRight, HistoryIcon, SearchIcon } from "@/components/Icons";
import { Badge, EmptyState, Eyebrow, Mono, Skeleton, cx, duration, relativeTime } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { isBusy, isRunning, type Deployment } from "@/lib/deployments";
import { dateTime } from "@/lib/format";

type Filter = "all" | "live" | "failed" | "in-progress";

export default function DeploymentsPage() {
  const [rows, setRows] = useState<Deployment[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  // Re-read the moment the server reports a change (lib/live.ts).
  const [liveTick, setLiveTick] = useState(0);
  useLive(() => setLiveTick((n) => n + 1));

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const d = await apiFetch<Deployment[]>("/deployments?limit=200");
        if (!active) return;
        setRows(d.filter((x) => x.status !== "analyzed"));
        timer = setTimeout(load, d.some((x) => isBusy(x.status)) ? 4000 : 20000);
      } catch {
        if (active) setRows([]);
      }
    }
    load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [liveTick]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter((d) => {
      if (filter === "live" && !isRunning(d.status)) return false;
      if (filter === "failed" && d.status !== "failed") return false;
      if (filter === "in-progress" && !isBusy(d.status)) return false;
      if (q && !`${d.target_label} ${d.commit_sha ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, filter, query]);

  return (
    <div className="space-y-8">
      <div>
        <Eyebrow>Workspace</Eyebrow>
        <h1 className="mt-3 text-[2rem] font-semibold leading-tight">Deployments</h1>
        <p className="mt-1.5 text-sm text-[var(--text-muted)]">Every build of every app, newest first.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-60 flex-1 items-center gap-2 rounded-full border border-[var(--hairline-strong)] bg-[var(--surface)] px-3.5 py-2 sm:max-w-sm">
          <SearchIcon className="h-3.5 w-3.5 text-[var(--text-dim)]" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="App or commit…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--text-dim)]" />
        </label>
        {(["all", "live", "in-progress", "failed"] as Filter[]).map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={cx("rounded-full border px-3 py-1.5 text-xs font-medium capitalize transition-colors",
              filter === f ? "border-[var(--hairline-strong)] bg-[var(--surface-2)] text-[var(--text)]" : "border-[var(--hairline)] text-[var(--text-dim)] hover:text-[var(--text-muted)]")}>
            {f.replace("-", " ")}
          </button>
        ))}
      </div>

      {rows === null ? (
        <div className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<HistoryIcon className="h-8 w-8" />} title="No deployments yet">
          Each time an app is built, it shows up here.
        </EmptyState>
      ) : (
        <div className="plate thin-scroll table-frame">
          <table className="w-full min-w-[48rem] text-sm">
            <thead>
              <tr className="border-b border-[var(--hairline)] text-left text-[11px] uppercase tracking-[0.12em] text-[var(--text-dim)]">
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">App</th>
                <th className="px-4 py-3 font-medium">Commit</th>
                <th className="px-4 py-3 font-medium">Method</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 text-right font-medium">Build</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--hairline)]">
              {shown.map((d) => (
                <tr key={d.id} className="group hover:bg-[oklch(100%_0_0/0.02)]">
                  <td className="px-4 py-3"><StatusBadge status={d.status} /></td>
                  <td className="max-w-[18rem] px-4 py-3">
                    <Link href={`/apps/${d.repository_id}`} className="block truncate font-medium hover:text-[var(--accent)]">{d.target_label}</Link>
                    {d.status === "failed" && d.error_message && <p className="truncate text-xs text-[var(--danger)]" title={d.error_message}>{d.error_message}</p>}
                  </td>
                  <td className="px-4 py-3"><Mono>{d.commit_sha?.slice(0, 7) ?? "—"}</Mono>{d.ci_trigger === "push" && <Badge className="ml-2">push</Badge>}</td>
                  <td className="px-4 py-3 text-xs text-[var(--text-muted)]">{d.build_method ?? "—"}</td>
                  <td className="px-4 py-3 text-xs text-[var(--text-muted)]" title={dateTime(d.created_at)}>{relativeTime(d.created_at)}</td>
                  <td className="tabular px-4 py-3 text-right text-xs text-[var(--text-muted)]">{duration(d.build_started_at, d.build_finished_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/deployments/${d.id}`} aria-label="Open deployment"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]">
                      <ChevronRight className="h-4 w-4" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <p className="px-4 py-10 text-center text-sm text-[var(--text-dim)]">No deployments match.</p>}
        </div>
      )}
    </div>
  );
}
