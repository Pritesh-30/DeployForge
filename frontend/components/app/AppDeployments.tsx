/**
 * Every build of the app, filterable, each one openable, the successful ones
 * restorable — and, for the owner, each one comparable with the deployment
 * before it.
 */

"use client";

import { useMemo, useState } from "react";

import { useApp } from "@/components/app/AppFrame";
import { Changes } from "@/components/app/Changes";
import { DeploymentRow, canRollBackTo } from "@/components/app/DeploymentRow";
import { Button, EmptyState, cx } from "@/components/ui";
import { HistoryIcon } from "@/components/Icons";

type Filter = "all" | "restorable" | "failed";

export default function AppDeployments() {
  const { app, api } = useApp();
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);

  const currentId = app.current?.id;
  const rows =
    filter === "failed" ? app.deployments.filter((d) => d.status === "failed")
      : filter === "restorable" ? app.deployments.filter((d) => canRollBackTo(d) || d.id === currentId)
      : app.deployments;

  // The deployment before each one with a commit, to compare against.
  const previousSha = useMemo(() => {
    const map = new Map<string, string>();
    const withSha = app.deployments.filter((d) => d.commit_sha);
    withSha.forEach((d, i) => {
      const before = withSha.slice(i + 1).find((p) => p.commit_sha !== d.commit_sha);
      if (before?.commit_sha) map.set(d.id, before.commit_sha);
    });
    return map;
  }, [app.deployments]);

  const counts = {
    all: app.deployments.length,
    restorable: app.deployments.filter((d) => canRollBackTo(d)).length,
    failed: app.deployments.filter((d) => d.status === "failed").length,
  };

  if (app.deployments.length === 0) {
    return (
      <EmptyState icon={<HistoryIcon className="h-8 w-8" />} title="No deployments yet">
        Press Redeploy to build this app for the first time.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {(["all", "restorable", "failed"] as Filter[]).map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={cx(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter === f ? "border-[var(--hairline-strong)] bg-[var(--surface-2)] text-[var(--text)]" : "border-[var(--hairline)] text-[var(--text-dim)] hover:text-[var(--text-muted)]",
            )}>
            {f === "all" ? "All" : f === "restorable" ? "Can roll back" : "Failed"}
            <span className="tabular ml-1.5 text-[var(--text-dim)]">{counts[f]}</span>
          </button>
        ))}
        <p className="ml-auto text-xs text-[var(--text-dim)]">
          {app.stats.success_rate != null && `${Math.round(app.stats.success_rate * 100)}% of builds succeed`}
        </p>
      </div>

      <div className="plate divide-y divide-[var(--hairline)] overflow-hidden">
        {rows.map((d) => {
          const base = previousSha.get(d.id);
          const canCompare = api.mode === "owner" && !!base && !!d.commit_sha;
          return (
            <div key={d.id}>
              <DeploymentRow
                deployment={d}
                isCurrent={d.id === app.current?.id}
                extra={canCompare ? (
                  <Button size="sm" variant="ghost" onClick={() => setOpen(open === d.id ? null : d.id)}
                    className={open === d.id ? "text-[var(--text)]" : "opacity-70 group-hover:opacity-100"}>
                    {open === d.id ? "Hide changes" : "Changes"}
                  </Button>
                ) : null}
              />
              {open === d.id && base && d.commit_sha && (
                <Changes appId={app.id} base={base} head={d.commit_sha} />
              )}
            </div>
          );
        })}
        {rows.length === 0 && <p className="px-4 py-8 text-center text-sm text-[var(--text-dim)]">No deployments match.</p>}
      </div>
    </div>
  );
}
