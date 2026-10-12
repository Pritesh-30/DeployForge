/**
 * One deployment, in full: where it got to, why it stopped there, and the
 * logs that say so.
 *
 * This is where people arrive when something did not work, so the page is
 * ordered by what they need: the pipeline shows which stage failed at a
 * glance, the explanation comes next (from the known-failure table, or from
 * Claude on request), and the logs follow, live while the build runs.
 */

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { ConfirmDialog, toast } from "@/components/Feedback";
import {
  AlertIcon,
  ArrowLeft,
  CheckIcon,
  CommitIcon,
  ExternalIcon,
  GitHubIcon,
  HistoryIcon,
  PlayIcon,
  RestartIcon,
  SparklesIcon,
  StopIcon,
  TrashIcon,
  UndoIcon,
} from "@/components/Icons";
import LogViewer from "@/components/LogViewer";
import { useSession } from "@/components/Session";
import { useLive } from "@/lib/live";
import StatusBadge from "@/components/StatusBadge";
import Timeline from "@/components/Timeline";
import { Alert, Badge, Button, Mono, Panel, Skeleton, Spinner, cx, duration, relativeTime } from "@/components/ui";
import type { AppApi } from "@/lib/appApi";
import {
  deleteDeployment,
  isBusy,
  isRunning,
  methodMeta,
  restartDeployment,
  startDeployment,
  stopDeployment,
  type AiDiagnosis,
  type CiProgress,
  type Deployment,
  type DeploymentEvent,
} from "@/lib/deployments";
import { dateTime } from "@/lib/format";

const STAGES = [
  { key: "queue", label: "Queued", ci: "Waiting" },
  { key: "download", label: "Source", ci: "Workflow" },
  { key: "build", label: "Build on this server", ci: "Build on GitHub Actions" },
  { key: "push", label: "Store image", ci: "Copy to registry" },
  { key: "start", label: "Start", ci: "Start" },
] as const;

/**
 * What the active stage is doing, in a sentence. "Building" is where nearly
 * all the time goes: dependencies are installed and the app compiled. Once
 * an image exists, starting it and routing a domain to it takes seconds.
 */
function stageNote(d: Deployment, ci: boolean): string | null {
  switch (d.status) {
    case "queued":
      return ci ? "Waiting for GitHub Actions to pick up the workflow run." : null;
    case "building":
      return ci
        ? "GitHub Actions is installing dependencies and building the image in the repository's own runner. This server only waits; it pulls the finished image next."
        : "This server is installing dependencies and compiling the app into an image. This is the slow part — starting the finished image takes seconds.";
    case "pushing":
      return ci ? "Copying the finished image from GitHub's registry into ours, so every version can be run again later." : "Storing the image in the registry, so this version can be run again later without rebuilding.";
    case "starting":
      return "Starting the container and routing its domain to it. Waiting for the app to answer before calling it live.";
    default:
      return null;
  }
}

type StageState = "done" | "active" | "failed" | "pending" | "skipped";

/** Where the deployment got to, stage by stage, from its status and events. */
function pipeline(d: Deployment, events: DeploymentEvent[]): Record<string, StageState> {
  const seen = new Set(events.map((e) => e.stage));
  const failedStage = [...events].reverse().find((e) => e.level === "error")?.stage;
  const order = ["queue", "download", "build", "push", "start"];
  const reached =
    d.status === "queued" ? 0
      : d.status === "building" ? (seen.has("build") ? 2 : 1)
      : d.status === "pushing" ? 3
      : d.status === "starting" ? 4
      : d.status === "built" || d.status === "stopped" ? 4
      : isRunning(d.status) ? 5
      : d.status === "failed" ? Math.max(1, order.indexOf(failedStage ?? "build"))
      : 0;

  const out: Record<string, StageState> = {};
  order.forEach((stage, i) => {
    if (d.status === "failed" && i === reached) out[stage] = "failed";
    else if (i < reached) out[stage] = "done";
    else if (i === reached && isBusy(d.status)) out[stage] = "active";
    else if ((d.status === "built" || d.status === "stopped") && stage === "start") out[stage] = d.runtime_started_at ? "done" : "pending";
    else out[stage] = "pending";
  });
  if (d.build_method === "compose" && !seen.has("push")) out.push = out.push === "done" ? "skipped" : out.push;
  return out;
}

export default function DeploymentDetail({ id, api }: { id: string; api: AppApi }) {
  const router = useRouter();
  const { meta } = useSession();
  const [d, setD] = useState<Deployment | null>(null);
  const [events, setEvents] = useState<DeploymentEvent[]>([]);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"build" | "runtime">("build");
  const [pending, setPending] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<AiDiagnosis | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [progress, setProgress] = useState<CiProgress | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const [dep, ev] = await Promise.all([api.deployment(id), api.events(id)]);
      setD(dep);
      setEvents(ev);
      if (dep.ai_diagnosis) setDiagnosis(dep.ai_diagnosis);
      return dep;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this deployment.");
      return null;
    }
  }, [api, id]);

  useLive(() => void load(), (c) => c.deployment_id === id);

  useEffect(() => {
    let active = true;
    async function tick() {
      const dep = await load();
      if (!active) return;
      timer.current = setTimeout(tick, dep && isBusy(dep.status) ? 2500 : 15000);
    }
    tick();
    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  // A build on GitHub Actions: follow its steps while it runs, and read them
  // once when it has finished so the page shows how it went.
  const ciDeployment = d && (d.ci_trigger != null || d.ci_run_url) ? d.id : null;
  const ciBusy = !!d && isBusy(d.status);
  useEffect(() => {
    if (!ciDeployment) return;
    let active = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const next = await api.ciProgress(ciDeployment!);
        if (!active) return;
        setProgress(next);
      } catch {
        // Progress is a nicety; the pipeline still shows the stage.
      }
      if (active && ciBusy) t = setTimeout(poll, 3000);
    }
    poll();
    return () => {
      active = false;
      if (t) clearTimeout(t);
    };
  }, [api, ciDeployment, ciBusy]);

  useEffect(() => {
    if (d && isRunning(d.status)) {
      const frame = requestAnimationFrame(() => setTab((t) => (t === "build" && d.status !== "failed" ? "runtime" : t)));
      return () => cancelAnimationFrame(frame);
    }
  }, [d]);

  async function act(name: string, fn: () => Promise<unknown>, message: string) {
    setPending(name);
    try {
      await fn();
      toast(message);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Something went wrong.", "danger");
    } finally {
      setPending(null);
    }
  }

  async function explain(refresh = false) {
    setPending("diagnose");
    try {
      setDiagnosis(await api.diagnose(id, refresh));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not get an explanation.", "danger");
    } finally {
      setPending(null);
    }
  }

  if (!d) {
    return error ? <Alert>{error}</Alert> : (
      <div className="space-y-5"><Skeleton className="h-6 w-56" /><Skeleton className="h-36" /><Skeleton className="h-96" /></div>
    );
  }

  const stages = pipeline(d, events);
  const method = methodMeta(d);
  const appHref = `${api.base}/${d.repository_id}`;
  const owner = api.mode === "owner";
  // Only builds sent to GitHub Actions carry a trigger.
  const ci = d.ci_trigger != null || !!d.ci_run_url;
  const note = stageNote(d, ci);
  // Built, but the start failed (a stack that would not come up, a port
  // clash): the image is fine, so starting again needs no rebuild.
  const failedAtStart = d.status === "failed" && !!d.build_finished_at && (!!d.image_ref || !!d.compose_project);
  const canStart = !d.suspended_by_admin && !isBusy(d.status) && !isRunning(d.status)
    && (d.status === "built" || d.status === "stopped" || failedAtStart) && (!!d.image_ref || !!d.compose_project);

  return (
    <div className="space-y-6">
      <Link href={appHref} className="inline-flex items-center gap-2 text-sm text-[var(--text-dim)] transition-colors hover:text-[var(--text)]">
        <ArrowLeft className="h-3.5 w-3.5" />{d.target_label}
      </Link>

      {/* --- Header ------------------------------------------------------- */}
      <header className="plate p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[1.5rem] font-semibold leading-tight">Deployment <Mono className="text-[1.1rem] text-[var(--text)]">{d.id.slice(0, 8)}</Mono></h1>
              <StatusBadge status={d.status} />
              {d.suspended_by_admin && <Badge tone="danger">Suspended</Badge>}
              {d.ci_trigger === "push" && <Badge>push</Badge>}
              {d.reused_from_id && (
                <Link href={api.deploymentHref(d.reused_from_id)} title="Same commit and settings as this earlier build, so its image was reused instead of building again.">
                  <Badge tone="info">Instant · reused {d.reused_from_id.slice(0, 8)}</Badge>
                </Link>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-[var(--text-muted)]">
              {d.commit_sha && (
                <a href={`https://github.com/${d.full_name}/commit/${d.commit_sha}`} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1.5 hover:text-[var(--text)]">
                  <CommitIcon className="h-3.5 w-3.5 text-[var(--text-dim)]" /><Mono>{d.commit_sha.slice(0, 7)}</Mono>
                </a>
              )}
              <span>{method.label} · {method.detail}</span>
              <span title={dateTime(d.created_at)}>Created {relativeTime(d.created_at)}</span>
              {d.build_started_at && <span>Build {duration(d.build_started_at, d.build_finished_at ?? new Date().toISOString())}</span>}
              {d.user_email && api.mode === "admin" && <span>Owner {d.user_email}</span>}
              {d.ci_run_url && (
                <a href={d.ci_run_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-[var(--text)]">
                  <GitHubIcon className="h-3.5 w-3.5" />Actions run<ExternalIcon className="h-3 w-3" />
                </a>
              )}
            </div>
            {isRunning(d.status) && d.url && (
              <a href={d.url} target="_blank" rel="noreferrer"
                className="mt-4 inline-flex items-center gap-2 rounded-full border border-[var(--ok)]/25 bg-[var(--ok-soft)] px-4 py-1.5 font-[family-name:var(--font-jetbrains-mono)] text-[13px] text-[var(--ok)]">
                {d.url.replace(/^https?:\/\//, "")}<ExternalIcon className="h-3.5 w-3.5" />
              </a>
            )}
          </div>

          {owner && (
            <div className="flex shrink-0 flex-wrap gap-2">
              {canStart && (
                <Button variant="primary" loading={pending === "start"} disabled={!!pending}
                  onClick={() => act("start", () => startDeployment(d.id), "Started.")}>
                  {failedAtStart ? <><RestartIcon className="h-3.5 w-3.5" />Try starting again</>
                    : d.runtime_started_at ? <><UndoIcon className="h-3.5 w-3.5" />Run this version</> : <><PlayIcon className="h-3 w-3" />Start</>}
                </Button>
              )}
              {isRunning(d.status) && (
                <>
                  <Button loading={pending === "restart"} disabled={!!pending} onClick={() => act("restart", () => restartDeployment(d.id), "Restarted.")}>
                    <RestartIcon className="h-3.5 w-3.5" />Restart
                  </Button>
                  <Button loading={pending === "stop"} disabled={!!pending} onClick={() => act("stop", () => stopDeployment(d.id), "Stopped.")}>
                    <StopIcon className="h-3 w-3" />Stop
                  </Button>
                </>
              )}
              {!isBusy(d.status) && !d.suspended_by_admin && (
                <Button variant="ghost" onClick={() => setConfirmDelete(true)} disabled={!!pending} title="Delete this deployment">
                  <TrashIcon className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )}
        </div>

        {/* --- Pipeline ------------------------------------------------------ */}
        <ol className="mt-6 grid grid-cols-5 gap-2">
          {STAGES.map((s) => {
            const st = stages[s.key];
            // While GitHub builds, its own steps fill the build stage's bar.
            const steps = ci && s.key === "build" && progress && progress.total > 0 ? progress.steps : null;
            return (
              <li key={s.key} className="min-w-0">
                {steps ? (
                  <div className="flex h-1 gap-0.5" aria-label={`${progress!.completed} of ${progress!.total} steps done`}>
                    {steps.map((step) => (
                      <span key={step.number} title={step.name} className={cx(
                        "h-1 flex-1 rounded-full",
                        step.conclusion === "failure" || step.conclusion === "cancelled" ? "bg-[var(--danger)]"
                          : step.status === "completed" ? "bg-[var(--ok)]"
                          : step.status === "in_progress" ? "shimmer bg-[var(--info)]"
                          : "bg-[var(--surface-3)]",
                      )} />
                    ))}
                  </div>
                ) : (
                <div className={cx(
                  "h-1 rounded-full",
                  st === "done" && "bg-[var(--ok)]",
                  st === "active" && "shimmer bg-[var(--info)]",
                  st === "failed" && "bg-[var(--danger)]",
                  (st === "pending" || st === "skipped") && "bg-[var(--surface-3)]",
                )} />
                )}
                <p className={cx(
                  "mt-2 flex items-center gap-1.5 truncate text-xs",
                  st === "failed" ? "text-[var(--danger)]" : st === "pending" || st === "skipped" ? "text-[var(--text-dim)]" : "text-[var(--text-muted)]",
                )}>
                  {st === "done" && <CheckIcon className="h-3 w-3 text-[var(--ok)]" />}
                  {st === "active" && <Spinner className="h-3 w-3" />}
                  {ci ? s.ci : s.label}{st === "skipped" ? " · n/a" : ""}
                  {steps && <span className="tabular text-[var(--text-dim)]">· {progress!.completed}/{progress!.total}</span>}
                </p>
              </li>
            );
          })}
        </ol>

        {note && <p className="mt-4 text-sm text-[var(--text-muted)]">{note}</p>}
        {ci && progress && progress.steps.length > 0 && <CiSteps progress={progress} live={ciBusy} />}
        {ci && progress?.error && <p className="mt-3 text-xs text-[var(--text-dim)]">Could not read the run&apos;s steps from GitHub: {progress.error}</p>}
        {d.status === "queued" && d.queue_position != null && (
          <p className="mt-4 text-sm text-[var(--info)]">
            {d.queue_position === 0 ? "Next to build." : `${d.queue_position} build${d.queue_position === 1 ? "" : "s"} ahead of this one`} · {d.queue_size} waiting in total. The queue takes one build from each student in turn, so nobody waits behind someone else&apos;s ten pushes.
          </p>
        )}
      </header>

      {d.suspended_by_admin && (
        <Alert tone="danger" title="Suspended by an administrator">{d.suspension_reason ?? "This app cannot be started until an administrator resumes it."}</Alert>
      )}

      {/* --- What went wrong ------------------------------------------------- */}
      {d.status === "failed" && (
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-[var(--r)] border border-[var(--danger)]/25 bg-[var(--danger-soft)] p-5">
            <p className="text-[13px] font-semibold text-[var(--danger)]">What failed</p>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text)]">{d.error_message ?? "The build failed. The log below says where."}</p>
          </div>
          <div className="plate p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="inline-flex items-center gap-2 text-[13px] font-semibold">
                <SparklesIcon className="h-4 w-4 text-[var(--accent)]" />AI diagnosis
              </p>
              {diagnosis && (
                <Badge tone={diagnosis.confidence === "high" ? "ok" : diagnosis.confidence === "medium" ? "warn" : "neutral"}>
                  {diagnosis.confidence} confidence
                </Badge>
              )}
            </div>
            {diagnosis ? (
              <dl className="mt-3 space-y-3 text-sm leading-relaxed">
                <div><dt className="text-xs text-[var(--text-dim)]">Summary</dt><dd>{diagnosis.summary}</dd></div>
                <div><dt className="text-xs text-[var(--text-dim)]">Cause</dt><dd className="text-[var(--text-muted)]">{diagnosis.cause}</dd></div>
                <div><dt className="text-xs text-[var(--text-dim)]">Fix</dt><dd className="whitespace-pre-line">{diagnosis.fix}</dd></div>
                <p className="text-[11px] text-[var(--text-dim)]">
                  {diagnosis.model} · {diagnosis.created_at ? relativeTime(diagnosis.created_at) : ""} ·{" "}
                  <button className="underline hover:text-[var(--text-muted)]" onClick={() => explain(true)} disabled={pending === "diagnose"}>ask again</button>
                </p>
              </dl>
            ) : meta?.ai_diagnosis ? (
              <div className="mt-3">
                <p className="text-sm text-[var(--text-muted)]">Claude reads the end of the log with what the platform knows about this app, and explains the cause and the fix.</p>
                <Button className="mt-4" size="sm" variant="primary" loading={pending === "diagnose"} onClick={() => explain()}>
                  <SparklesIcon className="h-3.5 w-3.5" />Explain this failure
                </Button>
              </div>
            ) : (
              <p className="mt-3 text-sm text-[var(--text-dim)]">Not enabled on this server. An administrator can turn it on with an Anthropic API key.</p>
            )}
          </div>
        </section>
      )}

      {/* --- Logs + timeline --------------------------------------------------
          On wide screens the timeline sits beside the log at exactly its
          height (absolutely filled, so a long timeline cannot stretch the
          row) and scrolls inside itself. */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="min-w-0 space-y-3">
          <div className="flex items-center gap-3">
            <div className="inline-flex rounded-full border border-[var(--hairline)] bg-[var(--surface)] p-1">
              {(["build", "runtime"] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)} disabled={t === "runtime" && !d.container_name}
                  className={cx("rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-40",
                    tab === t ? "bg-[var(--solid)] text-[var(--solid-text)]" : "text-[var(--text-muted)] hover:text-[var(--text)]")}>
                  {t === "build" ? "Build log" : "Runtime log"}
                </button>
              ))}
            </div>
            <p className="truncate text-xs text-[var(--text-dim)]">
              {tab === "build" ? "How the image was made — or why it could not be." : "What the running app printed — or printed as it died."}
            </p>
          </div>
          {tab === "build" ? (
            <LogViewer key={`b-${d.id}`} kind="build" streamPath={api.buildLogStream(d.id).replace(/\?offset=\d+$/, "")}
              filename={`build-${d.id.slice(0, 8)}.log`} emptyText={d.status === "queued" ? "Waiting for a build slot…" : "No build output."} />
          ) : (
            <LogViewer key={`r-${d.id}`} kind="runtime" streamPath={d.container_name ? api.runtimeLogStream(d.id) : null}
              filename={`runtime-${d.id.slice(0, 8)}.log`} emptyText="The app has not printed anything." />
          )}
        </section>

        <div className="relative min-w-0">
          <Panel title="Timeline" icon={<HistoryIcon className="h-4 w-4" />}
            hint={`${events.length} event${events.length === 1 ? "" : "s"}${isBusy(d.status) ? " · live" : ""}`}
            className="max-xl:max-h-[28rem] xl:absolute xl:inset-0">
            <Timeline events={events} />
          </Panel>
        </div>
      </div>

      <ConfirmDialog open={confirmDelete} title="Delete this deployment?" confirmLabel="Delete" danger
        busy={pending === "delete"} onCancel={() => setConfirmDelete(false)}
        onConfirm={() => act("delete", async () => {
          await deleteDeployment(d.id);
          router.push(appHref);
        }, "Deployment deleted.")}>
        Removes this build from the app&apos;s history and stops it if it is running. The app and its other deployments are untouched.
      </ConfirmDialog>
    </div>
  );
}

/** The workflow run's steps, as GitHub reports them, with how long each took. */
function CiSteps({ progress, live }: { progress: CiProgress; live: boolean }) {
  return (
    <ol className="mt-4 flex flex-wrap gap-1.5" aria-label="GitHub Actions steps">
      {progress.steps.map((step) => {
        const failed = step.conclusion === "failure" || step.conclusion === "cancelled";
        const running = step.status === "in_progress";
        const done = step.status === "completed" && !failed;
        const skipped = step.conclusion === "skipped";
        // Finished steps only: a running one shows a spinner, not a clock.
        const seconds = step.started_at && step.completed_at
          ? (new Date(step.completed_at).getTime() - new Date(step.started_at).getTime()) / 1000
          : null;
        return (
          <li key={step.number} className={cx(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
            failed ? "border-[var(--danger)]/30 bg-[var(--danger-soft)] text-[var(--danger)]"
              : running ? "border-[var(--info)]/30 bg-[var(--info-soft)] text-[var(--info)]"
              : done && !skipped ? "border-[var(--hairline)] text-[var(--text-muted)]"
              : "border-[var(--hairline)] text-[var(--text-dim)]",
          )}>
            {failed ? <AlertIcon className="h-3 w-3" /> : running ? <Spinner className="h-3 w-3" /> : done && !skipped ? <CheckIcon className="h-3 w-3 text-[var(--ok)]" /> : <span className="h-1.5 w-1.5 rounded-full bg-[var(--surface-3)]" />}
            {step.name}
            {seconds != null && seconds >= 1 && !skipped && <span className="tabular text-[var(--text-dim)]">{Math.round(seconds)}s</span>}
          </li>
        );
      })}
      {live && progress.status === "queued" && <li className="text-xs text-[var(--text-dim)]">Waiting for a GitHub runner…</li>}
    </ol>
  );
}
