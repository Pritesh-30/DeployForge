"use client";

import { useEffect, useMemo, useState } from "react";

import { ActivityList } from "@/components/app/ActivityList";
import { Eyebrow, Skeleton, cx } from "@/components/ui";
import { myActivity, type Activity } from "@/lib/apps";

type Level = "all" | "error" | "warning" | "success";

/** The story of every app, newest first: builds, starts, failures, admin actions. */
export default function ActivityPage() {
  const [items, setItems] = useState<Activity[] | null>(null);
  const [level, setLevel] = useState<Level>("all");

  useEffect(() => {
    let active = true;
    const load = () => myActivity(200).then((a) => active && setItems(a)).catch(() => active && setItems([]));
    load();
    const t = setInterval(load, 15000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  const shown = useMemo(() => (items ?? []).filter((a) => level === "all" || a.level === level), [items, level]);

  return (
    <div className="space-y-8">
      <div>
        <Eyebrow>Workspace</Eyebrow>
        <h1 className="mt-3 text-[2rem] font-semibold leading-tight">Activity</h1>
        <p className="mt-1.5 text-sm text-[var(--text-muted)]">Everything that happened to your apps, including anything an administrator did.</p>
      </div>
      <div className="flex gap-1.5">
        {(["all", "error", "warning", "success"] as Level[]).map((l) => (
          <button key={l} onClick={() => setLevel(l)}
            className={cx("rounded-full border px-3 py-1.5 text-xs font-medium capitalize transition-colors",
              level === l ? "border-[var(--hairline-strong)] bg-[var(--surface-2)] text-[var(--text)]" : "border-[var(--hairline)] text-[var(--text-dim)] hover:text-[var(--text-muted)]")}>
            {l === "error" ? "Errors" : l === "warning" ? "Warnings" : l === "success" ? "Successes" : "All"}
          </button>
        ))}
      </div>
      {items === null ? <Skeleton className="h-96" /> : (
        <ActivityList items={shown} hrefFor={(a) => `/apps/${a.app_id}`} deploymentHref={(id) => `/deployments/${id}`} />
      )}
    </div>
  );
}
