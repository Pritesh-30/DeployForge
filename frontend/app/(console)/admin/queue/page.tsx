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
import { CheckIcon, CpuIcon, QueueIcon } from "@/components/Icons";
import { useSession } from "@/components/Session";
import { Alert, Badge, Button, Eyebrow, Panel, PanelEmpty, SectionTitle, Skeleton, Spinner, cx, relativeTime } from "@/components/ui";
import { cancelJob, getQueue, setConcurrency, type Concurrency, type QueueJob, type QueueView } from "@/lib/admin";
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
  // Slots above a just-lowered limit still show while they finish their build.
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

          <Panel
            title="Build slots"
            icon={<CpuIcon className="h-4 w-4" />}
            hint={`${q.concurrency} build${q.concurrency === 1 ? "" : "s"} run at once. The rest wait in their lanes below.`}
            action={<ConcurrencyControl q={q} onChange={(c) => setQ((prev) => prev && { ...prev, ...c })} />}
            footer={<ConcurrencyAdvice q={q} />}
          >
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {slots.map((job, i) => (
                <div key={i} className={cx(
                  "flex items-center gap-3 rounded-[var(--r-sm)] border px-3.5 py-3",
                  job ? "border-[var(--info)]/30 bg-[var(--info-soft)]/40" : "border-dashed border-[var(--hairline-strong)]",
                  i >= q.concurrency && "opacity-60",
                )}>
                  <span className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                    job ? "border-[var(--info)]/40 bg-[var(--info-soft)] text-[var(--info)]" : "border-[var(--hairline)] text-[var(--text-dim)]")}>
                    {job ? <Spinner /> : i + 1}
                  </span>
                  {job ? (
                    <div className="min-w-0 flex-1">
                      <JobLink job={job} />
                      <p className="truncate text-xs text-[var(--text-dim)]">
                        {job.tenant_email} · {job.started_at ? seconds((now - job.started_at) / 1000) : "—"}
                        {job.attempts > 1 && ` · attempt ${job.attempts}/${job.max_attempts}`}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-[var(--text-dim)]">{i >= q.concurrency ? "Finishing, then closing" : "Free"}</p>
                  )}
                </div>
              ))}
            </div>
          </Panel>

          <div className="grid gap-4 lg:h-[24rem] lg:grid-cols-2">
            <Panel title="Lanes" hint="One per student with builds waiting, in the order the scheduler visits them." flush
              action={<Badge>{q.ring.length} student{q.ring.length === 1 ? "" : "s"}</Badge>}>
              {q.ring.length === 0 ? (
                <PanelEmpty icon={<QueueIcon className="h-6 w-6" />} title="Nothing is waiting">
                  When more builds are asked for than there are slots, each student gets a lane here and the scheduler takes one from each in turn.
                </PanelEmpty>
              ) : (
                <ol className="divide-y divide-[var(--hairline)]">
                  {q.ring.map((lane, i) => (
                    <li key={lane.tenant} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate text-sm font-medium"><span className="tabular mr-2 text-[var(--text-dim)]">{i + 1}.</span>{lane.email ?? lane.tenant}</p>
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
            </Panel>

            <Panel title="Up next" hint="Exactly the order the next free slot will take them in." flush
              action={<Badge>{q.order.length}</Badge>}>
              {q.order.length === 0 && q.delayed.length === 0 ? (
                <PanelEmpty icon={<CheckIcon className="h-6 w-6 text-[var(--ok)]" />} title="Every build has a slot">
                  A new build starts the moment it is asked for.
                </PanelEmpty>
              ) : (
                <>
                  <ol className="divide-y divide-[var(--hairline)]">
                    {q.order.map((id, i) => {
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
                  {q.delayed.length > 0 && (
                    <>
                      <p className="sticky top-0 border-y border-[var(--hairline)] bg-[var(--surface)] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--warn)]">
                        Backing off before a retry
                      </p>
                      <ul className="divide-y divide-[var(--hairline)]">
                        {q.delayed.map((job) => (
                          <li key={job.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                            <span className="min-w-0 flex-1 truncate">{job.label || job.id}</span>
                            <span className="tabular text-xs text-[var(--warn)]">in {job.run_at ? seconds(Math.max(0, (job.run_at - now) / 1000)) : "—"}</span>
                            <span className="max-w-[40%] truncate text-xs text-[var(--text-dim)]" title={job.error}>{job.error}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </Panel>
          </div>

          <section>
            <SectionTitle>Recently finished</SectionTitle>
            <div className="plate thin-scroll table-frame">
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

/**
 * "Builds at once", adjustable while the server runs. The worker reads the
 * limit every couple of seconds; lowering it never interrupts a build.
 */
function ConcurrencyControl({ q, onChange }: { q: QueueView; onChange: (c: Concurrency) => void }) {
  const [busy, setBusy] = useState(false);

  async function change(value: number | null) {
    setBusy(true);
    try {
      const c = await setConcurrency(value);
      onChange(c);
      toast(value === null ? `Back to the default: ${c.concurrency} at once.` : `${c.concurrency} build${c.concurrency === 1 ? "" : "s"} now run at once.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not change the limit.", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-xs text-[var(--text-dim)] sm:inline">Builds at once</span>
      <div className="inline-flex items-center rounded-[var(--r-sm)] border border-[var(--hairline-strong)]">
        <button type="button" aria-label="Fewer builds at once" disabled={busy || q.concurrency <= 1}
          onClick={() => change(q.concurrency - 1)}
          className="h-8 w-8 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] disabled:opacity-40">−</button>
        <span className="tabular w-8 text-center text-sm font-semibold" aria-live="polite">{q.concurrency}</span>
        <button type="button" aria-label="More builds at once" disabled={busy || q.concurrency >= q.concurrency_max}
          onClick={() => change(q.concurrency + 1)}
          className="h-8 w-8 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] disabled:opacity-40">+</button>
      </div>
      {q.concurrency !== q.concurrency_default && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => change(null)}>Reset</Button>
      )}
    </div>
  );
}

function ConcurrencyAdvice({ q }: { q: QueueView }) {
  // A build mostly needs one core for the compiler plus headroom for the
  // apps already running, so about one build per two cores keeps each fast.
  const suggested = Math.max(1, Math.min(q.concurrency_max, Math.floor(q.cpus / 2)));
  if (q.concurrency > q.cpus) {
    return <span className="text-[var(--warn)]">More builds than this machine has cores ({q.cpus}): each will be slower, and running apps compete with them for CPU.</span>;
  }
  return (
    <span>
      This machine has {q.cpus} core{q.cpus === 1 ? "" : "s"}; about {suggested} at once keeps each build fast and leaves room for running apps.
      {" "}Changes apply within seconds and survive a restart. Lowering the limit lets running builds finish.
    </span>
  );
}
