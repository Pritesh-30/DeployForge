/**
 * The build queue, live.
 *
 * The scheduler takes one build from each student in turn, so the order
 * builds run in is not the order they arrived in. This page shows that order
 * explicitly — the lanes, and the sequence the next builds will be taken in —
 * because an administrator asked "why is mine not building?" should be able
 * to answer from one screen.
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { toast } from "@/components/Feedback";
import { QueueIcon } from "@/components/Icons";
import { useSession } from "@/components/Session";
import { Alert, Badge, Button, Eyebrow, SectionTitle, Skeleton, Spinner, cx, relativeTime } from "@/components/ui";
import { cancelJob, getQueue, type QueueJob, type QueueView } from "@/lib/admin";
import { seconds } from "@/lib/format";

const STATE_TONE: Record<QueueJob["state"], "ok" | "danger" | "info" | "warn" | "neutral"> = {
  done: "ok", failed: "danger", cancelled: "neutral", running: "info", pending: "neutral", delayed: "warn",
};

export default function QueuePage() {
  const { meta } = useSession();
  const [q, setQ] = useState<QueueView | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setQ(await getQueue());
      setError("");
      setNow(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the queue.");
    }
  }, []);

  useEffect(() => {
    let active = true;
    const tick = () =>
      getQueue()
        .then((view) => {
          if (!active) return;
          setQ(view);
          setError("");
          setNow(Date.now());
        })
        .catch((e) => active && setError(e instanceof Error ? e.message : "Could not read the queue."));
    tick();
    const t = setInterval(tick, 2500);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      active = false;
      clearInterval(t);
      clearInterval(clock);
    };
  }, []);

  async function cancel(job: QueueJob) {
    try {
      await cancelJob(job.id);
      toast(`Removed ${job.label || job.id} from the queue.`);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not cancel.", "danger");
    }
  }

  const allPending = q ? Object.values(q.pending).flat() : [];
  const byId = new Map(allPending.map((j) => [j.id, j]));
  const slots = q ? Array.from({ length: Math.max(q.concurrency, q.running.length) }, (_, i) => q.running[i] ?? null) : [];

  return (
    <div className="space-y-8">
      <div>
        <Eyebrow>Platform</Eyebrow>
        <h1 className="mt-3 text-[2rem] font-semibold leading-tight">Build queue</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[var(--text-muted)]">
          Builds wait in one lane per student, and the scheduler takes one from each lane in turn — so a student with ten
          pushes cannot make everyone else wait for all ten. A build interrupted by a restart goes back to the front of its lane.
        </p>
      </div>

      {meta?.build_backend === "actions" && (
        <Alert tone="info" title="Builds run on GitHub Actions">
          This server sends builds to each student&apos;s GitHub Actions rather than building them itself, so this queue stays empty.
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}

      {!q ? <Skeleton className="h-80" /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {[
              ["Building", `${q.running.length} / ${q.concurrency}`],
              ["Waiting", allPending.length],
              ["Retrying", q.delayed.length],
              ["Completed", q.stats.done ?? 0],
              ["Failed", q.stats.failed ?? 0],
              ["Retried · reclaimed", `${q.stats.retried ?? 0} · ${q.stats.reclaimed ?? 0}`],
            ].map(([label, value]) => (
              <div key={String(label)} className="plate px-4 py-3">
                <p className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">{label}</p>
                <p className="tabular mt-1.5 text-xl font-semibold">{value}</p>
              </div>
            ))}
          </div>

          <section>
            <SectionTitle hint={`${q.concurrency} build${q.concurrency === 1 ? "" : "s"} run at once on this machine.`}>Build slots</SectionTitle>
            <div className="grid gap-3 md:grid-cols-2">
              {slots.map((job, i) => (
                <div key={i} className={cx("plate flex items-center gap-4 px-4 py-3.5", job && "border-[var(--info)]/30")}>
                  <span className={cx("flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                    job ? "border-[var(--info)]/40 bg-[var(--info-soft)] text-[var(--info)]" : "border-[var(--hairline)] text-[var(--text-dim)]")}>
                    {job ? <Spinner /> : i + 1}
                  </span>
                  {job ? (
                    <div className="min-w-0 flex-1">
                      <JobLink job={job} />
                      <p className="text-xs text-[var(--text-dim)]">
                        {job.tenant_email} · attempt {job.attempts}/{job.max_attempts} · {job.started_at ? seconds((now - job.started_at) / 1000) : "—"} so far
                      </p>
                    </div>
                  ) : <p className="text-sm text-[var(--text-dim)]">Idle</p>}
                </div>
              ))}
            </div>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <SectionTitle hint="One lane per student with builds waiting, in the order the scheduler visits them.">Lanes</SectionTitle>
              {q.ring.length === 0 ? (
                <div className="plate flex items-center gap-3 px-5 py-6 text-sm text-[var(--text-dim)]"><QueueIcon className="h-4 w-4" />Nothing is waiting.</div>
              ) : (
                <ol className="space-y-2">
                  {q.ring.map((lane, i) => (
                    <li key={lane.tenant} className="plate px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium"><span className="tabular mr-2 text-[var(--text-dim)]">{i + 1}.</span>{lane.email ?? lane.tenant}</p>
                        <Badge>{lane.waiting} waiting</Badge>
                      </div>
                      <ul className="mt-2.5 flex flex-wrap gap-1.5">
                        {(q.pending[lane.tenant] ?? []).map((job) => (
                          <li key={job.id} className="group inline-flex items-center gap-1.5 rounded-full border border-[var(--hairline-strong)] bg-[var(--surface-2)] py-0.5 pl-2.5 pr-1 text-xs">
                            {job.label || job.id}
                            {job.attempts > 0 && <span className="text-[var(--warn)]">retry</span>}
                            <button onClick={() => cancel(job)} title="Remove from queue"
                              className="rounded-full px-1.5 text-[var(--text-dim)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]">×</button>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section>
              <SectionTitle hint="Exactly the order the next free slot will take them in.">Up next</SectionTitle>
              {q.order.length === 0 ? (
                <p className="plate px-5 py-6 text-sm text-[var(--text-dim)]">Empty.</p>
              ) : (
                <ol className="plate divide-y divide-[var(--hairline)] overflow-hidden">
                  {q.order.slice(0, 15).map((id, i) => {
                    const job = byId.get(id);
                    return (
                      <li key={id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                        <span className="tabular w-6 text-right text-xs text-[var(--text-dim)]">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate">{job?.label || id}</span>
                        <span className="truncate text-xs text-[var(--text-dim)]">{job?.tenant_email}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
              {q.delayed.length > 0 && (
                <div className="mt-4 space-y-2">
                  <p className="text-xs font-medium text-[var(--warn)]">Backing off before a retry</p>
                  {q.delayed.map((job) => (
                    <div key={job.id} className="plate flex items-center gap-3 px-4 py-2.5 text-sm">
                      <span className="min-w-0 flex-1 truncate">{job.label || job.id}</span>
                      <span className="tabular text-xs text-[var(--warn)]">in {job.run_at ? seconds(Math.max(0, (job.run_at - now) / 1000)) : "—"}</span>
                      <span className="truncate text-xs text-[var(--text-dim)]" title={job.error}>{job.error}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          <section>
            <SectionTitle>Recently finished</SectionTitle>
            <div className="plate thin-scroll overflow-x-auto">
              <table className="w-full min-w-[48rem] text-sm">
                <thead>
                  <tr className="border-b border-[var(--hairline)] text-left text-[11px] uppercase tracking-[0.12em] text-[var(--text-dim)]">
                    <th className="px-4 py-3 font-medium">Build</th>
                    <th className="px-4 py-3 font-medium">Student</th>
                    <th className="px-4 py-3 font-medium">Result</th>
                    <th className="px-4 py-3 text-right font-medium">Attempts</th>
                    <th className="px-4 py-3 text-right font-medium">Waited</th>
                    <th className="px-4 py-3 text-right font-medium">Ran</th>
                    <th className="px-4 py-3 font-medium">Finished</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--hairline)]">
                  {q.recent.map((job) => (
                    <tr key={job.id + (job.finished_at ?? "")}>
                      <td className="max-w-[16rem] px-4 py-2.5"><JobLink job={job} /></td>
                      <td className="px-4 py-2.5 text-xs text-[var(--text-muted)]">{job.tenant_email}</td>
                      <td className="px-4 py-2.5"><Badge tone={STATE_TONE[job.state]}>{job.state}</Badge></td>
                      <td className="tabular px-4 py-2.5 text-right text-xs">{job.attempts}</td>
                      <td className="tabular px-4 py-2.5 text-right text-xs text-[var(--text-muted)]">
                        {job.started_at && job.enqueued_at ? seconds((job.started_at - job.enqueued_at) / 1000) : "—"}
                      </td>
                      <td className="tabular px-4 py-2.5 text-right text-xs text-[var(--text-muted)]">
                        {job.finished_at && job.started_at ? seconds((job.finished_at - job.started_at) / 1000) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-[var(--text-muted)]">
                        {job.finished_at ? relativeTime(new Date(job.finished_at).toISOString()) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {q.recent.length === 0 && <p className="px-4 py-8 text-center text-sm text-[var(--text-dim)]">No builds have finished yet.</p>}
            </div>
          </section>
          <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={load}>Refresh</Button></div>
        </>
      )}
    </div>
  );
}

function JobLink({ job }: { job: QueueJob }) {
  const dep = job.payload?.deployment_id;
  const label = job.label || job.id;
  return dep ? (
    <Link href={`/admin/deployments/${dep}`} className="block truncate text-sm font-medium hover:text-[var(--accent)]">{label}</Link>
  ) : <span className="block truncate text-sm font-medium">{label}</span>;
}
