/**
 * Everything around an app's pages: who owns it, what state it is in, how
 * to reach it, what can be done to it, and the tabs.
 *
 * The app is loaded once here and shared with the tab beneath through
 * context, so moving from Logs to Metrics does not refetch or flash. While a
 * build or a start is in flight the frame polls, and the banner says how far
 * along it is — including its place in the fair build queue, which is not
 * simply arrival order and is worth showing.
 */

"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { ConfirmDialog, toast } from "@/components/Feedback";
import { useSession } from "@/components/Session";
import { useLive } from "@/lib/live";
import {
  BranchIcon,
  ChevronDown,
  ChevronRight,
  CommitIcon,
  ExternalIcon,
  PauseIcon,
  PlayIcon,
  RestartIcon,
  RocketIcon,
  ShieldIcon,
  StopIcon,
} from "@/components/Icons";
import { Alert, Badge, Button, Dot, Mono, Skeleton, Spinner, cx, relativeTime } from "@/components/ui";
import { runnableDeployment, type AppApi } from "@/lib/appApi";
import { appState, inflightDeployment, type AppDetail } from "@/lib/apps";
import { isRunning, methodMeta, type Deployment } from "@/lib/deployments";
import { frameworkName } from "@/lib/github";

type AppContextValue = {
  app: AppDetail;
  api: AppApi;
  reload: () => Promise<AppDetail | null>;
  /** Run an action with a pending state, a toast, and a reload afterwards. */
  act: (name: string, fn: () => Promise<unknown>, success?: string) => Promise<boolean>;
  pending: string | null;
};

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside an AppFrame");
  return value;
}

const POLL_BUSY_MS = 3000;
const POLL_IDLE_MS = 20000;

export default function AppFrame({
  id,
  api,
  children,
}: {
  id: string;
  api: AppApi;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { meta } = useSession();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [current, setCurrent] = useState<Deployment | null>(null);
  const [ciStep, setCiStep] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "stop" | "suspend">(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await api.get(id);
      setApp(next);
      setError("");
      // The in-flight deployment's own record carries its queue position.
      const flight = inflightDeployment(next);
      if (flight) {
        api.deployment(flight.id).then(setCurrent).catch(() => undefined);
        // On GitHub Actions, name the step it is on.
        if (flight.ci_trigger || flight.ci_run_url) {
          api.ciProgress(flight.id)
            .then((p) => setCiStep(p.current ? `${p.current} · step ${p.completed + 1} of ${p.total}` : null))
            .catch(() => undefined);
        }
      } else {
        setCurrent(null);
        setCiStep(null);
      }
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this app.");
      return null;
    }
  }, [api, id]);

  // A push, a build step, a crash: shown the moment the server records it.
  useLive(() => void reload(), (c) => c.app_id === id);

  useEffect(() => {
    let active = true;
    async function tick() {
      const next = await reload();
      if (!active) return;
      timer.current = setTimeout(tick, next && inflightDeployment(next) ? POLL_BUSY_MS : POLL_IDLE_MS);
    }
    tick();
    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [reload]);

  const act = useCallback(
    async (name: string, fn: () => Promise<unknown>, success?: string) => {
      setPending(name);
      try {
        await fn();
        if (success) toast(success);
        await reload();
        return true;
      } catch (err) {
        toast(err instanceof Error ? err.message : "Something went wrong.", "danger");
        return false;
      } finally {
        setPending(null);
      }
    },
    [reload],
  );

  const tabs = useMemo(() => {
    const base = `${api.base}/${id}`;
    const all = [
      { href: base, label: "Overview", exact: true },
      ...(api.mode === "owner" ? [{ href: `${base}/code`, label: "Code" }] : []),
      { href: `${base}/deployments`, label: "Deployments" },
      { href: `${base}/logs`, label: "Logs" },
      { href: `${base}/metrics`, label: "Metrics" },
      { href: `${base}/activity`, label: "Activity" },
      ...(api.mode === "owner"
        ? [
            { href: `${base}/environment`, label: "Environment" },
            { href: `${base}/settings`, label: "Settings" },
          ]
        : []),
    ];
    return all;
  }, [api, id]);

  if (!app) {
    return (
      <div className="space-y-6">
        {error ? <Alert>{error}</Alert> : (
          <>
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-28" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-72" />
          </>
        )}
      </div>
    );
  }

  const state = appState(app);
  const live = app.current && isRunning(app.current.status) ? app.current : null;
  const runnable = runnableDeployment(app);
  const flight = inflightDeployment(app);
  const busy = !!flight;
  // A new version building while the old one serves, as on Vercel.
  const serving = flight && app.current && app.current.id !== flight.id && isRunning(app.current.status) ? app.current : null;
  const suspended = !!app.current?.suspended_by_admin;
  const method = app.current ? methodMeta(app.current) : null;
  const ghCommit = app.current?.commit_sha
    ? `https://github.com/${app.full_name}/commit/${app.current.commit_sha}`
    : null;

  async function redeploy(fresh = false) {
    await act("redeploy", async () => {
      const depId = await api.redeploy(app!, fresh);
      router.push(api.deploymentHref(depId));
    }, fresh
      ? "Rebuilding from scratch. It goes live by itself when the build finishes."
      : "Redeploying. If this commit was already built it is live in seconds; otherwise when the build finishes.");
  }

  return (
    <AppContext.Provider value={{ app, api, reload, act, pending }}>
      <div className="space-y-6">
        {/* --- Breadcrumb ------------------------------------------------ */}
        <nav className="flex items-center gap-1.5 text-sm text-[var(--text-dim)]">
          <Link href={api.base} className="transition-colors hover:text-[var(--text)]">Apps</Link>
          {api.mode === "admin" && app.owner_email && (
            <>
              <ChevronRight className="h-3.5 w-3.5" />
              <Link href={`/admin/students/${app.owner_id}`} className="transition-colors hover:text-[var(--text)]">
                {app.owner_email}
              </Link>
            </>
          )}
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="truncate text-[var(--text-muted)]">{app.name}</span>
        </nav>

        {/* --- Header ---------------------------------------------------- */}
        <header className="plate relative z-10 focus-within:z-30">
          <div className="flex flex-col gap-5 p-6 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="truncate text-[1.65rem] font-semibold leading-tight">{app.full_name}</h1>
                {app.deploy_path && <Badge>{app.deploy_path}/</Badge>}
                {app.is_multi_service && app.service_paths && (
                  <Badge>{app.service_paths.join(" + ")}</Badge>
                )}
                <Badge tone={state.tone}>
                  <Dot tone={state.tone} pulse={state.live} />
                  {state.label}
                </Badge>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-[var(--text-muted)]">
                {method && <span>{method.label}{app.detected_framework && !app.is_multi_service ? ` · ${frameworkName(app.detected_framework)}` : ""}</span>}
                <span className="inline-flex items-center gap-1.5">
                  <BranchIcon className="h-3.5 w-3.5 text-[var(--text-dim)]" />
                  {app.default_branch}
                </span>
                {app.current?.commit_sha && (
                  <a href={ghCommit ?? undefined} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1.5 transition-colors hover:text-[var(--text)]">
                    <CommitIcon className="h-3.5 w-3.5 text-[var(--text-dim)]" />
                    <Mono>{app.current.commit_sha.slice(0, 7)}</Mono>
                  </a>
                )}
                {app.last_deployed_at && <span>Deployed {relativeTime(app.last_deployed_at)}</span>}
                {/* Pushes only deploy when builds run in GitHub Actions; saying
                    so on a server that builds locally would promise nothing. */}
                {meta?.build_backend === "actions" && (
                  <span className={cx("inline-flex items-center gap-1.5", !app.auto_deploy && "text-[var(--warn)]")}>
                    <span className={cx("h-1.5 w-1.5 rounded-full", app.auto_deploy ? "bg-[var(--ok)]" : "bg-[var(--warn)]")} />
                    {app.auto_deploy ? "Deploys on push" : "Push deploys off"}
                  </span>
                )}
              </div>

              {live?.url && (
                <a href={live.url} target="_blank" rel="noreferrer"
                  className="group/url mt-4 inline-flex items-center gap-2 rounded-full border border-[var(--ok)]/25 bg-[var(--ok-soft)] px-4 py-1.5 font-[family-name:var(--font-jetbrains-mono)] text-[13px] font-medium text-[var(--ok)] transition-colors duration-[var(--t-hover)] hover:bg-[var(--ok)] hover:text-[var(--bg-deep)]">
                  {live.url.replace(/^https?:\/\//, "")}
                  <ExternalIcon className="h-3.5 w-3.5 opacity-60 group-hover/url:opacity-100" />
                </a>
              )}
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {api.mode === "admin" && (suspended ? (
                <Button onClick={() => act("resume", () => api.resume!(app), "Suspension lifted.")} loading={pending === "resume"}>
                  <ShieldIcon className="h-3.5 w-3.5" />Resume
                </Button>
              ) : (
                <Button variant="danger" onClick={() => setConfirm("suspend")} disabled={!!pending || app.deployment_count === 0}>
                  <PauseIcon className="h-3.5 w-3.5" />Suspend
                </Button>
              ))}
              {live ? (
                <>
                  <Button onClick={() => act("restart", () => api.restart(app), "Restarted.")}
                    loading={pending === "restart"} disabled={busy || !!pending}>
                    <RestartIcon className="h-3.5 w-3.5" />Restart
                  </Button>
                  <Button onClick={() => setConfirm("stop")} disabled={busy || !!pending}>
                    <StopIcon className="h-3 w-3" />Stop
                  </Button>
                </>
              ) : (
                runnable && !suspended && (
                  <Button variant="primary" onClick={() => act("start", () => api.start(app), "Started.")}
                    loading={pending === "start"} disabled={busy || !!pending}>
                    <PlayIcon className="h-3 w-3" />Start
                  </Button>
                )
              )}
              <RedeployButton primary={!(live || runnable)} loading={pending === "redeploy"}
                disabled={busy || !!pending || (suspended && api.mode === "owner")} onRedeploy={redeploy} />
            </div>
          </div>

          {/* --- In-flight banner ---------------------------------------- */}
          {flight && (
            <Link href={api.deploymentHref(flight.id)}
              className="flex items-center gap-3 rounded-b-[var(--r)] border-t border-[var(--hairline)] bg-[var(--info-soft)] px-6 py-3 text-sm text-[var(--info)] transition-colors hover:bg-[color-mix(in_oklch,var(--info)_18%,transparent)]">
              <Spinner />
              <span className="flex-1">
                {flight.status === "queued" ? (
                  current?.queue_position != null ? (
                    <>Queued — {current.queue_position === 0 ? "next to build" : `${current.queue_position} build${current.queue_position === 1 ? "" : "s"} ahead`} of {current.queue_size} waiting.</>
                  ) : flight.ci_trigger || flight.ci_run_url ? "Waiting for a GitHub Actions runner…" : "Queued for a build…"
                ) : flight.status === "starting" ? "Starting the new version and routing its domain…"
                  : flight.status === "pushing" ? (flight.ci_trigger ? "Copying the image GitHub built into our registry…" : "Storing the image in the registry…")
                  : flight.ci_trigger || flight.ci_run_url ? (ciStep ? `Building in GitHub Actions — ${ciStep}` : "Building in GitHub Actions — installing dependencies and compiling…")
                  : "Building on this server — installing dependencies and compiling…"}
              </span>
              {serving && (
                <span className="hidden text-xs text-[var(--text-muted)] md:inline">
                  Production keeps serving {serving.commit_sha?.slice(0, 7) ?? "the current version"} until it is ready ·
                </span>
              )}
              <span className="text-xs font-medium">Watch the log →</span>
            </Link>
          )}
        </header>

        {suspended && (
          <Alert tone="danger" title="Suspended by an administrator">
            {app.current?.suspension_reason ?? "This app has been stopped and cannot be started, redeployed or deleted until an administrator resumes it."}
          </Alert>
        )}

        {/* --- Tabs ------------------------------------------------------ */}
        {/* Sticky, so the tabs stay in reach however far a tab scrolls. The
            underline sits inside the bar: hanging it 1px below made the bar
            itself vertically scrollable, which showed as a stray scrollbar. */}
        <div className="thin-scroll sticky top-[7.25rem] z-20 -mx-1 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-[var(--hairline)] bg-[color-mix(in_oklch,var(--bg-deep)_92%,transparent)] px-1 pt-2 backdrop-blur-md lg:top-0">
          {tabs.map((tab) => {
            const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);
            return (
              <Link key={tab.href} href={tab.href}
                className={cx(
                  "relative shrink-0 px-3.5 pb-3 pt-1 text-sm font-medium transition-colors duration-[var(--t-hover)]",
                  active ? "text-[var(--text)]" : "text-[var(--text-dim)] hover:text-[var(--text-muted)]",
                )}>
                {tab.label}
                <span className={cx(
                  "absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-[var(--accent)] transition-opacity duration-[var(--t-hover)]",
                  active ? "opacity-100" : "opacity-0",
                )} />
              </Link>
            );
          })}
        </div>

        <div key={pathname} className="rise">{children}</div>
      </div>

      <ConfirmDialog
        open={confirm === "stop"}
        title={`Stop ${app.name}?`}
        confirmLabel="Stop app"
        danger
        busy={pending === "stop"}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (await act("stop", () => api.stop(app), "Stopped.")) setConfirm(null);
        }}
      >
        Its URL stops answering until it is started again. Nothing is deleted.
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === "suspend"}
        title={`Suspend ${app.name}?`}
        confirmLabel="Suspend app"
        danger
        reasonLabel="Reason, shown to the student (optional)"
        busy={pending === "suspend"}
        onCancel={() => setConfirm(null)}
        onConfirm={async (reason) => {
          if (await act("suspend", () => api.suspend!(app, reason), "App suspended.")) setConfirm(null);
        }}
      >
        It stops now, and its owner cannot start, redeploy, delete or re-add it until you resume it.
      </ConfirmDialog>
    </AppContext.Provider>
  );
}

/**
 * Redeploy, with "Rebuild from scratch" one click away. A plain redeploy of
 * a commit that was already built with the same settings reuses its image and
 * is ready in seconds; rebuilding is for a build that depends on something
 * outside the repository, like a base image tagged `latest`.
 */
function RedeployButton({ primary, loading, disabled, onRedeploy }: {
  primary: boolean;
  loading: boolean;
  disabled: boolean;
  onRedeploy: (fresh?: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-flex"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}>
      <Button variant={primary ? "primary" : "secondary"} onClick={() => onRedeploy(false)} loading={loading} disabled={disabled}
        className="rounded-r-none" title="Build the latest commit. Reuses the image if this commit was already built.">
        <RocketIcon className="h-3.5 w-3.5" />Redeploy
      </Button>
      <Button variant={primary ? "primary" : "secondary"} disabled={disabled} aria-label="More redeploy options" aria-expanded={open}
        onClick={() => setOpen((o) => !o)} className="-ml-px rounded-l-none px-2">
        <ChevronDown className="h-3.5 w-3.5" />
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1.5 w-72 overflow-hidden rounded-[var(--r)] border border-[var(--hairline-strong)] bg-[var(--surface)] p-1 shadow-xl">
          <button role="menuitem" type="button" onClick={() => { setOpen(false); onRedeploy(false); }}
            className="w-full rounded-[var(--r-sm)] px-3 py-2 text-left hover:bg-[var(--surface-2)]">
            <span className="block text-sm font-medium">Redeploy</span>
            <span className="block text-xs text-[var(--text-dim)]">Skips the build if this commit was already built — ready in seconds.</span>
          </button>
          <button role="menuitem" type="button" onClick={() => { setOpen(false); onRedeploy(true); }}
            className="w-full rounded-[var(--r-sm)] px-3 py-2 text-left hover:bg-[var(--surface-2)]">
            <span className="block text-sm font-medium">Rebuild from scratch</span>
            <span className="block text-xs text-[var(--text-dim)]">Builds again even if nothing changed. For base images or packages that moved.</span>
          </button>
        </div>
      )}
    </div>
  );
}
