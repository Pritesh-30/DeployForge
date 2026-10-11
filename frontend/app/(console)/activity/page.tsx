"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useLive } from "@/lib/live";

import { ActivityList } from "@/components/app/ActivityList";
import { RankedBars } from "@/components/charts";
import { HistoryIcon } from "@/components/Icons";
import { Eyebrow, Panel, PanelEmpty, Skeleton, WORKSPACE_HEIGHT, cx } from "@/components/ui";
import { myActivity, type Activity } from "@/lib/apps";

type Level = "all" | "error" | "warning" | "success";

const LEVELS: { key: Level; label: string; dot: string }[] = [
  { key: "all", label: "All", dot: "bg-[var(--text-dim)]" },
  { key: "error", label: "Errors", dot: "bg-[var(--danger)]" },
  { key: "warning", label: "Warnings", dot: "bg-[var(--warn)]" },
  { key: "success", label: "Successes", dot: "bg-[var(--ok)]" },
];

/** The story of every app, newest first: builds, starts, failures, admin actions. */
export default function ActivityPage() {
  const [items, setItems] = useState<Activity[] | null>(null);
  const [level, setLevel] = useState<Level>("all");

  // Re-read the moment the server reports a change (lib/live.ts).
  const [liveTick, setLiveTick] = useState(0);
  useLive(() => setLiveTick((n) => n + 1));

  useEffect(() => {
    let active = true;
    const load = () => myActivity(200).then((a) => active && setItems(a)).catch(() => active && setItems([]));
    load();
    const t = setInterval(load, 15000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [liveTick]);

  const shown = useMemo(() => (items ?? []).filter((a) => level === "all" || a.level === level), [items, level]);
  const counts = useMemo(() => {
    const c: Record<Level, number> = { all: 0, error: 0, warning: 0, success: 0 };
    for (const a of items ?? []) {
      c.all += 1;
      if (a.level in c) c[a.level as Level] += 1;
    }
    return c;
  }, [items]);
  const byApp = useMemo(() => {
    const m = new Map<string, { label: string; count: number; errors: number }>();
    for (const a of items ?? []) {
      const row = m.get(a.app_id) ?? { label: a.app_label, count: 0, errors: 0 };
      row.count += 1;
      if (a.level === "error") row.errors += 1;
      m.set(a.app_id, row);
    }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8);
  }, [items]);

  return (
    <div className="space-y-6">
      <div>
        <Eyebrow>Workspace</Eyebrow>
        <h1 className="mt-3 text-[2rem] font-semibold leading-tight">Activity</h1>
        <p className="mt-1.5 text-sm text-[var(--text-muted)]">Everything that happened to your apps, including anything an administrator did.</p>
      </div>

      {items === null ? <Skeleton className={WORKSPACE_HEIGHT} /> : (
        <div className="grid gap-4 xl:h-[calc(100dvh-15rem)] xl:min-h-[30rem] xl:grid-cols-[minmax(0,1fr)_18rem]">
          <Panel
            title={LEVELS.find((l) => l.key === level)?.label ?? "All"}
            icon={<HistoryIcon className="h-4 w-4" />}
            hint={`${shown.length} of the last ${counts.all} events · updates every 15 seconds`}
            action={
              <div className="flex gap-1">
                {LEVELS.map((l) => (
                  <button key={l.key} onClick={() => setLevel(l.key)}
                    className={cx("rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                      level === l.key ? "border-[var(--hairline-strong)] bg-[var(--surface-2)] text-[var(--text)]" : "border-transparent text-[var(--text-dim)] hover:text-[var(--text-muted)]")}>
                    {l.label}
                  </button>
                ))}
              </div>
            }
            flush
            className="max-xl:max-h-[calc(100dvh-14rem)]"
          >
            <ActivityList items={shown} hrefFor={(a) => `/apps/${a.app_id}`} deploymentHref={(id) => `/deployments/${id}`} flush />
          </Panel>

          <div className="grid gap-4 max-xl:sm:grid-cols-2 xl:grid-rows-[auto_minmax(0,1fr)]">
            <Panel title="By outcome">
              <ul className="space-y-1">
                {LEVELS.map((l) => (
                  <li key={l.key}>
                    <button onClick={() => setLevel(l.key)}
                      className={cx("flex w-full items-center gap-2.5 rounded-[var(--r-sm)] px-2 py-1.5 text-sm transition-colors",
                        level === l.key ? "bg-[var(--surface-2)] text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--surface-2)]")}>
                      <span className={cx("h-2 w-2 rounded-full", l.dot)} />
                      <span className="flex-1 text-left">{l.label}</span>
                      <span className="tabular text-xs">{counts[l.key]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel title="Busiest apps" hint="Events per app in this list.">
              {byApp.length === 0 ? <PanelEmpty title="No apps yet" /> : (
                <RankedBars
                  rows={byApp.map(([id, r]) => ({
                    label: <Link href={`/apps/${id}`} className="hover:text-[var(--accent)]">{r.label}</Link>,
                    value: r.count,
                    hint: r.errors ? <span className="text-[var(--danger)]">· {r.errors} errors</span> : undefined,
                  }))}
                />
              )}
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
