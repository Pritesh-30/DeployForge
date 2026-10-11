/**
 * What happened, newest first, grouped by day.
 *
 * Each entry is one deployment event — a build starting, an image stored, a
 * container exiting on boot, an administrator suspending something — so a
 * student can see the story of their app without opening each deployment.
 */

"use client";

import Link from "next/link";

import { cx, relativeTime } from "@/components/ui";
import type { Activity } from "@/lib/apps";

const LEVEL_DOT: Record<Activity["level"], string> = {
  info: "bg-[var(--text-dim)]",
  success: "bg-[var(--ok)]",
  warning: "bg-[var(--warn)]",
  error: "bg-[var(--danger)]",
};

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

export function ActivityList({
  items,
  showApp = true,
  hrefFor,
  deploymentHref,
}: {
  items: Activity[];
  showApp?: boolean;
  hrefFor?: (a: Activity) => string;
  deploymentHref?: (id: string) => string;
}) {
  if (items.length === 0) {
    return <p className="rounded-[var(--r)] border border-dashed border-[var(--hairline-strong)] px-4 py-10 text-center text-sm text-[var(--text-dim)]">Nothing has happened yet.</p>;
  }

  const groups: { day: string; items: Activity[] }[] = [];
  for (const item of items) {
    const day = dayLabel(item.created_at);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <div key={group.day}>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">{group.day}</p>
          <ol className="plate relative divide-y divide-[var(--hairline)] overflow-hidden">
            {group.items.map((a) => (
              <li key={a.id} className="flex gap-3 px-4 py-3">
                <span className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", LEVEL_DOT[a.level])} />
                <div className="min-w-0 flex-1">
                  <p className={cx(
                    "whitespace-pre-line text-sm leading-relaxed line-clamp-3",
                    a.level === "error" ? "text-[var(--danger)]" : "text-[var(--text)]",
                  )}>
                    {a.message}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-[var(--text-dim)]">
                    {showApp && (
                      hrefFor ? (
                        <Link href={hrefFor(a)} className="font-medium text-[var(--text-muted)] hover:text-[var(--text)]">{a.app_label}</Link>
                      ) : <span className="font-medium text-[var(--text-muted)]">{a.app_label}</span>
                    )}
                    <span className="capitalize">{a.stage}</span>
                    {a.actor && a.actor !== "owner" && <span>· by {a.actor === "admin" ? "an administrator" : a.actor}</span>}
                    <span>· {relativeTime(a.created_at)}</span>
                    {deploymentHref && (
                      <Link href={deploymentHref(a.deployment_id)} className="hover:text-[var(--text-muted)]">· deployment</Link>
                    )}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
