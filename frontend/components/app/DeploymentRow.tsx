/**
 * One build in an app's history, with the actions that make sense for it:
 * open it, and — when it built successfully and is not the live one — roll
 * back to it.
 */

"use client";

import Link from "next/link";
import { useState } from "react";

import { useApp } from "@/components/app/AppFrame";
import { ConfirmDialog } from "@/components/Feedback";
import { ChevronRight, CommitIcon, UndoIcon } from "@/components/Icons";
import StatusBadge from "@/components/StatusBadge";
import { Badge, Button, Mono, cx, duration, relativeTime } from "@/components/ui";
import { isRunning, type Deployment } from "@/lib/deployments";

export function canRollBackTo(d: Deployment): boolean {
  return (
    (d.status === "built" || d.status === "stopped") &&
    !d.suspended_by_admin &&
    (!!d.image_ref || (d.build_method === "compose" && !!d.compose_project))
  );
}

export function DeploymentRow({
  deployment: d,
  isCurrent,
  compact = false,
  extra,
}: {
  deployment: Deployment;
  isCurrent: boolean;
  compact?: boolean;
  extra?: React.ReactNode;
}) {
  const { app, api, act, pending } = useApp();
  const [confirm, setConfirm] = useState(false);
  const live = isRunning(d.status);

  return (
    <div className={cx("group flex flex-wrap items-center gap-x-4 gap-y-2 px-4", compact ? "py-3" : "py-3.5")}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
        <StatusBadge status={d.status} />
        {isCurrent && live && <Badge tone="accent">Production</Badge>}
        {d.commit_sha && (
          <span className="inline-flex items-center gap-1 text-[var(--text-muted)]">
            <CommitIcon className="h-3.5 w-3.5 text-[var(--text-dim)]" />
            <Mono>{d.commit_sha.slice(0, 7)}</Mono>
          </span>
        )}
        {!compact && d.build_method && <span className="text-xs text-[var(--text-dim)]">{d.build_method}</span>}
        {!compact && d.ci_trigger === "push" && <Badge>push</Badge>}
        {d.reused_from_id && <span title="Same commit and settings as an earlier build, so its image was reused."><Badge tone="info">instant</Badge></span>}
        <span className="text-xs text-[var(--text-dim)]">{relativeTime(d.created_at)}</span>
        {d.build_started_at && d.build_finished_at && (
          <span className="tabular text-xs text-[var(--text-dim)]">· {duration(d.build_started_at, d.build_finished_at)}</span>
        )}
        {!compact && d.status === "failed" && d.error_message && (
          <p className="basis-full truncate text-xs text-[var(--danger)]" title={d.error_message}>{d.error_message}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {extra}
        {canRollBackTo(d) && !app.current?.suspended_by_admin && (
          <Button size="sm" variant="ghost" onClick={() => setConfirm(true)} disabled={!!pending}
            className="opacity-70 group-hover:opacity-100" title="Run this version again">
            <UndoIcon className="h-3.5 w-3.5" />
            Roll back
          </Button>
        )}
        <Link href={api.deploymentHref(d.id)} aria-label="Open deployment"
          className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]">
          <ChevronRight className="h-4 w-4" />
        </Link>
      </div>

      <ConfirmDialog
        open={confirm}
        title="Roll back to this deployment?"
        confirmLabel="Roll back"
        busy={pending === `promote-${d.id}`}
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          const ok = await act(`promote-${d.id}`, () => api.promote(app, d.id), "Rolled back — that version is live again.");
          if (ok) setConfirm(false);
        }}
      >
        Commit <Mono>{d.commit_sha?.slice(0, 7) ?? "unknown"}</Mono> starts from the image it built, in seconds — no rebuild.
        The version running now is stopped once this one is up.
      </ConfirmDialog>
    </div>
  );
}
