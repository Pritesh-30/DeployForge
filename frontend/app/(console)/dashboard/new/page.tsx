/**
 * The deploy wizard: connect GitHub, pick a repository, pick what inside it,
 * then build and run.
 *
 * Four explicit steps rather than one long form, because each one can fail for
 * a reason the student has to act on — GitHub not connected, repository not
 * recognized, build failed — and a wizard makes the failure land on the step
 * that caused it.
 */

"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Mono,
  Skeleton,
  Spinner,
  cx,
  relativeTime,
} from "@/components/ui";
import {
  BoxIcon,
  CheckIcon,
  DockerIcon,
  FolderIcon,
  GitHubIcon,
  RestartIcon,
  RocketIcon,
  SearchIcon,
} from "@/components/Icons";
import {
  connectedState,
  describeCandidate,
  frameworkName,
  getAuthorizeUrl,
  getConnectionStatus,
  listRepos,
  repoRecency,
  scanRepo,
  selectTarget,
  type Candidate,
  type ConnectionStatus,
  type GitHubRepo,
  type ScanResult,
  saveEnvVars,
  type EnvVarInput,
} from "@/lib/github";
import { buildRepository } from "@/lib/deployments";

export default function NewDeploymentPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Wizard />
    </Suspense>
  );
}

/** KEY=value lines, as in a .env file. Comments and blank lines are skipped. */
function parseEnv(text: string): EnvVarInput[] {
  const out: EnvVarInput[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out.push({ key, value, is_secret: /SECRET|TOKEN|PASSWORD|KEY|PRIVATE/i.test(key) });
  }
  return out;
}

type Step = 1 | 2 | 3;

function Wizard() {
  const router = useRouter();
  const params = useSearchParams();

  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [connectError, setConnectError] = useState("");
  const [repos, setRepos] = useState<GitHubRepo[] | null>(null);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState<string | null>(null);
  // Which directories are ticked. Local until "Build and deploy" is pressed,
  // so browsing the options no longer writes anything to the database.
  const [picked, setPicked] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [envText, setEnvText] = useState("");
  const [showEnv, setShowEnv] = useState(false);
  const envVars = useMemo(() => parseEnv(envText), [envText]);

  // The OAuth callback returns here with the outcome in the query string.
  const callbackError = params.get("github") === "error" ? params.get("reason") : null;

  const loadConnection = useCallback(async () => {
    try {
      const status = await getConnectionStatus();
      setConnection(status);
      if (status.connected) {
        setRepos(await listRepos());
      }
    } catch (err) {
      setConnectError(
        err instanceof Error ? err.message : "Could not check your GitHub connection.",
      );
      setConnection({
        connected: false,
        github_username: null,
        github_user_id: null,
        scopes: null,
        connected_at: null,
      });
    }
  }, []);

  useEffect(() => {
    // The loader is async: every setState inside it runs after an await, not
    // during this effect. The rule cannot see through the call, so it is
    // silenced here rather than contorting the fetch to satisfy a heuristic.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadConnection();
  }, [loadConnection]);

  /**
   * Re-read the repository list from GitHub.
   *
   * Nothing is cached server-side, but the list is fetched once when this page
   * mounts — so a repository created or forked while the page was already open
   * will not be there until someone asks again. This is that ask.
   */
  async function refreshRepos() {
    setRefreshing(true);
    setError("");
    try {
      setRepos(await listRepos());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not refresh the list.",
      );
    } finally {
      setRefreshing(false);
    }
  }

  async function connect() {
    setConnectError("");
    try {
      const { authorize_url } = await getAuthorizeUrl();
      window.location.href = authorize_url;
    } catch (err) {
      setConnectError(
        err instanceof Error ? err.message : "Could not start the GitHub flow.",
      );
    }
  }

  async function pickRepo(repo: GitHubRepo) {
    setScanning(repo.full_name);
    setError("");
    setScan(null);
    setPicked([]);
    try {
      setScan(await scanRepo(repo.full_name));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not scan that repository.");
    } finally {
      setScanning(null);
    }
  }

  function toggle(candidate: Candidate) {
    setError("");
    setPicked((current) =>
      current.includes(candidate.path)
        ? current.filter((p) => p !== candidate.path)
        : [...current, candidate.path],
    );
  }

  async function build() {
    if (!scan || picked.length === 0) return;
    setWorking(true);
    setError("");
    try {
      const target = await selectTarget(scan.scan_token, picked);
      // Variables go in before the first build, so it can use them.
      if (envVars.length) await saveEnvVars(target.repository_id, envVars);
      const { deployment_id } = await buildRepository(target.repository_id);
      // The build runs in the background; its own page shows the log.
      router.push(`/deployments/${deployment_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the build.");
      setWorking(false);
    }
  }

  const step: Step = !connection?.connected ? 1 : !scan ? 2 : 3;

  // Which ticked directory receives public traffic. Mirrors the backend's
  // choice so the wizard promises what the platform will actually do.
  const WEB_NAMES = ["frontend", "web", "client", "ui", "www", "site", "app", "dashboard"];
  const webService =
    picked.find((p) => WEB_NAMES.includes(p.toLowerCase())) ?? picked[0] ?? "";
  const chosen =
    picked.length === 1
      ? scan?.candidates.find((c) => c.path === picked[0])
      : undefined;

  const filtered = useMemo(() => {
    if (!repos) return null;
    const q = query.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) =>
        r.full_name.toLowerCase().includes(q) ||
        (r.language ?? "").toLowerCase().includes(q),
    );
  }, [repos, query]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Deploy a new app</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Connect GitHub, choose a repository, and DeployForge works out how to
          build and run it.
        </p>
      </div>

      <Steps current={step} />

      {callbackError && (
        <Alert title="GitHub did not complete the connection">{callbackError}</Alert>
      )}
      {error && <Alert>{error}</Alert>}

      {/* --- Step 1: connect ------------------------------------------- */}
      <StepCard
        number={1}
        title="Connect GitHub"
        done={!!connection?.connected}
        description="DeployForge needs access to list your repositories and to add the workflow that builds and deploys them."
      >
        {connection === null ? (
          <Skeleton className="h-10 w-48" />
        ) : connection.connected ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone="ok">
                <CheckIcon className="h-3 w-3" />
                Connected as {connection.github_username}
              </Badge>
              <span className="text-xs text-[var(--text-dim)]">
                since {relativeTime(connection.connected_at)}
              </span>
            </div>
            {connection.needs_reconnect && (
              <div className="space-y-3">
                <Alert title="GitHub needs to grant two more permissions">
                  Apps are now built by GitHub Actions in your own repository.
                  DeployForge needs permission to add its workflow file there
                  and to read the images it builds.
                </Alert>
                <Button variant="primary" onClick={connect}>
                  <GitHubIcon className="h-4 w-4" />
                  Reconnect GitHub
                </Button>
                {connectError && <Alert>{connectError}</Alert>}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <Button variant="primary" onClick={connect}>
              <GitHubIcon className="h-4 w-4" />
              Authorize GitHub
            </Button>
            {connectError && <Alert>{connectError}</Alert>}
            <p className="text-xs text-[var(--text-dim)]">
              The token is exchanged and encrypted on the server — it never
              reaches your browser.
            </p>
          </div>
        )}
      </StepCard>

      {/* --- Step 2: repository ---------------------------------------- */}
      {connection?.connected && (
        <StepCard
          number={2}
          title="Choose a repository"
          done={!!scan}
          description="Read live from GitHub. Nothing is stored until you pick one."
        >
          {repos === null ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : repos.length === 0 ? (
            <EmptyState title="No repositories found">
              This GitHub account has no repositories DeployForge can see.
            </EmptyState>
          ) : (
            <div className="space-y-3">
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-dim)]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${repos.length} repositories…`}
                  className="w-full rounded-full border border-[var(--hairline-strong)] bg-[var(--surface-2)] py-2.5 pl-10 pr-4 text-sm shadow-[var(--bevel)] placeholder:text-[var(--text-dim)] transition-[border-color,background-color] duration-[var(--t-hover)] focus:border-[var(--accent-line)] focus:bg-[var(--surface-3)] focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-between gap-3 text-xs text-[var(--text-dim)]">
                <span>Newest first — forks count from when you forked them.</span>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={refreshing}
                  onClick={refreshRepos}
                  title="Fetch the list from GitHub again"
                >
                  <RestartIcon className="h-3.5 w-3.5" />
                  Refresh
                </Button>
              </div>

              <div className="max-h-96 space-y-2 overflow-auto pr-1">
                {filtered?.map((repo) => {
                  const deployed = repo.connected;
                  const state = connectedState(repo.deployment_status);
                  const recency = repoRecency(repo);
                  return (
                    <div
                      key={repo.github_repo_id}
                      className={cx(
                        "flex w-full items-center justify-between gap-3 rounded-[var(--r-sm)] border px-4 py-3 transition-colors",
                        scan?.full_name === repo.full_name
                          ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                          : deployed
                            ? "border-[var(--hairline)] bg-[var(--surface-2)]/50"
                            : "border-[var(--hairline)] bg-[var(--surface-2)] hover:border-[var(--hairline-strong)] hover:bg-[var(--surface-3)]",
                      )}
                    >
                      <button
                        onClick={() => pickRepo(repo)}
                        disabled={scanning !== null}
                        className="min-w-0 flex-1 text-left disabled:cursor-not-allowed"
                      >
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {repo.full_name}
                          </span>
                          {repo.private && <Badge>Private</Badge>}
                          {repo.fork && <Badge>Fork</Badge>}
                          {deployed && (
                            <Badge tone={state.tone}>{state.label}</Badge>
                          )}
                        </span>
                        <span className="mt-0.5 flex items-center gap-2 text-xs text-[var(--text-dim)]">
                          {repo.language && <span>{repo.language}</span>}
                          <span>
                            {recency.label} {relativeTime(recency.iso)}
                          </span>
                          {deployed && (
                            <span>
                              {repo.connected_paths
                                .map((path) => path || "whole repository")
                                .join(", ")}{" "}
                              connected
                            </span>
                          )}
                        </span>
                      </button>

                      <span className="flex shrink-0 items-center gap-3">
                        {deployed && repo.deployment_id && (
                          <Link
                            href={`/deployments/${repo.deployment_id}`}
                            className="text-xs text-[var(--accent)] hover:underline"
                          >
                            View
                          </Link>
                        )}
                        {scanning === repo.full_name ? (
                          <Spinner />
                        ) : (
                          <span className="text-xs text-[var(--text-dim)]">
                            {deployed ? "Scan again" : "Scan"}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
                {filtered?.length === 0 && (
                  <p className="py-6 text-center text-sm text-[var(--text-dim)]">
                    No repository matches “{query}”.
                  </p>
                )}
              </div>
            </div>
          )}
        </StepCard>
      )}

      {/* --- Step 3: target + build ------------------------------------ */}
      {scan && (
        <StepCard
          number={3}
          title="Choose what to deploy"
          done={picked.length > 0}
          description={
            scan.candidates.length > 1
              ? "Tick one directory, or several to run them together on a shared network."
              : "What was found in this repository."
          }
        >
          <div className="grid gap-5 lg:grid-cols-[1fr_21rem]">
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--text-dim)]">
                <span className="font-medium text-[var(--text-muted)]">{scan.full_name}</span>
                <span>{scan.default_branch}</span>
                {scan.commit_sha && <Mono>{scan.commit_sha.slice(0, 7)}</Mono>}
                <span>{scan.file_count.toLocaleString()} files</span>
                <span>{scan.candidates.filter((c) => c.type !== "unknown").length} deployable target{scan.candidates.filter((c) => c.type !== "unknown").length === 1 ? "" : "s"}</span>
              </div>
            <div className="space-y-3">
              {scan.candidates.map((candidate) => {
                const active = picked.includes(candidate.path);
                const taken = candidate.already_connected;
                const takenState = connectedState(candidate.deployment_status);
                // The root candidate contains the others, so it cannot be part
                // of a combination — it would build the same code twice.
                const isRoot = candidate.path === "";
                const blockedByRoot =
                  picked.length > 0 && (isRoot ? !active : picked.includes(""));
                const deployable =
                  candidate.type !== "unknown" && !taken && !blockedByRoot;
                return (
                  <button
                    key={candidate.path || "__root__"}
                    onClick={() => deployable && toggle(candidate)}
                    disabled={!deployable || working}
                    className={cx(
                      "flex w-full items-center justify-between gap-3 rounded-[var(--r-sm)] border px-4 py-3 text-left transition-colors",
                      active
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--hairline)] bg-[var(--surface-2)]",
                      deployable
                        ? "hover:border-[var(--hairline-strong)] hover:bg-[var(--surface-3)]"
                        : "cursor-not-allowed opacity-50",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      {/* A tick box, because more than one may be chosen. */}
                      <span
                        aria-hidden
                        className={cx(
                          "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[6px] border",
                          "transition-colors duration-[var(--t-hover)]",
                          active
                            ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg-deep)]"
                            : "border-[var(--hairline-strong)]",
                        )}
                      >
                        {active && <CheckIcon className="h-3 w-3" />}
                      </span>
                      <span className="text-[var(--text-dim)]">
                        {candidate.type === "docker" ? (
                          <DockerIcon className="h-5 w-5" />
                        ) : candidate.path ? (
                          <FolderIcon className="h-5 w-5" />
                        ) : (
                          <BoxIcon className="h-5 w-5" />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {candidate.label}
                        </span>
                        <span className="text-xs text-[var(--text-dim)]">
                          {taken
                            ? `Already connected — ${takenState.label.toLowerCase()}. Manage it from Apps.`
                            : blockedByRoot
                              ? isRoot
                                ? "Cannot be combined with a directory inside it"
                                : "Cannot be combined with the whole repository"
                              : describeCandidate(candidate)}
                          {!taken &&
                            candidate.evidence.length > 0 &&
                            ` · ${candidate.evidence.slice(0, 3).join(", ")}`}
                        </span>
                      </span>
                    </span>
                    {taken ? (
                      <Badge tone={takenState.tone}>{takenState.label}</Badge>
                    ) : active && picked.length > 1 ? (
                      <Badge tone="accent">
                        {candidate.path === webService ? "Public" : "Internal"}
                      </Badge>
                    ) : null}
                  </button>
                );
              })}
            </div>
            </div>

            {/* --- The plan ------------------------------------------------- */}
            <aside className="lg:sticky lg:top-6 lg:self-start">
              <div className="rounded-[var(--r)] border border-[var(--hairline-strong)] bg-[var(--surface-2)] p-5">
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">Deployment plan</p>
                {picked.length === 0 ? (
                  <p className="mt-3 text-sm text-[var(--text-muted)]">Tick a target to see how it will be built and run.</p>
                ) : (
                  <>
                    <p className="mt-3 text-sm font-medium">
                      {picked.length > 1
                        ? `${picked.length} services, one private network`
                        : chosen?.type === "docker"
                          ? "Built from your Docker configuration"
                          : `Buildpacks · ${frameworkName(chosen?.framework ?? null)}`}
                    </p>
                    <ol className="mt-4 space-y-2.5 text-xs text-[var(--text-muted)]">
                      {[
                        "Download the commit from GitHub",
                        picked.length > 1 ? "Build each service on its own terms" : chosen?.type === "docker" ? "Build with your Dockerfile / Compose file" : "Detect the runtime and build with buildpacks",
                        "Store the image as a version you can roll back to",
                        "Run it isolated, with memory and CPU limits",
                        "Route its own address to it",
                      ].map((step, i) => (
                        <li key={i} className="flex gap-2.5">
                          <span className="tabular flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[var(--hairline-strong)] text-[9px]">{i + 1}</span>
                          {step}
                        </li>
                      ))}
                    </ol>
                    {picked.length > 1 && (
                      <p className="mt-4 rounded-[var(--r-xs)] bg-[var(--surface-3)] px-3 py-2 text-xs text-[var(--text-muted)]">
                        <span className="text-[var(--accent)]">{webService || "root"}</span> gets the public address; the others are reachable by name
                        {" "}({picked.filter((p) => p !== webService).map((p) => `${(p || "app").toUpperCase()}_URL`).join(", ")}).
                      </p>
                    )}

                    <div className="mt-4 border-t border-[var(--hairline)] pt-4">
                      <button onClick={() => setShowEnv((v) => !v)} className="flex w-full items-center justify-between text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)]">
                        <span>Environment variables {envVars.length > 0 && <span className="text-[var(--accent)]">· {envVars.length}</span>}</span>
                        <span>{showEnv ? "Hide" : "Add"}</span>
                      </button>
                      {showEnv && (
                        <>
                          <textarea value={envText} onChange={(e) => setEnvText(e.target.value)} rows={5} spellCheck={false}
                            placeholder={"DATABASE_URL=postgres://...\nNEXT_PUBLIC_API_URL=https://..."}
                            className="thin-scroll mt-2 w-full resize-y rounded-[var(--r-xs)] border border-[var(--hairline-strong)] bg-[var(--surface)] p-2.5 font-[family-name:var(--font-jetbrains-mono)] text-[11.5px] outline-none focus:border-[var(--accent-line)]" />
                          <p className="mt-1.5 text-[11px] text-[var(--text-dim)]">
                            Paste a .env file. Encrypted at rest; names containing SECRET, TOKEN, PASSWORD or KEY are stored as secrets.
                          </p>
                        </>
                      )}
                    </div>

                    <Button variant="primary" size="lg" className="mt-5 w-full" loading={working} onClick={build}
                      trailing={<RocketIcon className="h-3.5 w-3.5" />}>
                      Deploy
                    </Button>
                    <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-dim)]">
                      You will be taken to the build, where the log streams live. A first buildpack build downloads a large builder image and takes longer.
                    </p>
                  </>
                )}
              </div>
            </aside>
          </div>

          {scan.candidates.length > 0 &&
            scan.candidates.every((c) => c.already_connected) && (
              <Alert tone="ok" title="Everything here is already deployed">
                Every deployable target in this repository is connected to your
                account. Manage them from Apps.
              </Alert>
            )}

          {scan.candidates.every((c) => c.type === "unknown") && (
            <Alert tone="warn" title="Nothing deployable was found">
              No Dockerfile, and no recognized framework markers such as
              package.json, requirements.txt or go.mod. Add a Dockerfile to the
              directory you want to deploy, then scan again.
            </Alert>
          )}
        </StepCard>
      )}

      <p className="text-center text-sm text-[var(--text-dim)]">
        <Link href="/apps" className="hover:text-[var(--text)]">
          Back to apps
        </Link>
      </p>
    </div>
  );
}

/* --- Chrome ------------------------------------------------------------- */

function Steps({ current }: { current: Step }) {
  const labels = ["Connect GitHub", "Choose repository", "Choose target"];
  return (
    <ol className="flex items-center gap-2">
      {labels.map((label, i) => {
        const n = (i + 1) as Step;
        const state = n < current ? "done" : n === current ? "active" : "todo";
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={cx(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                state === "done" && "bg-[var(--ok-soft)] text-[var(--ok)]",
                state === "active" &&
                  "bg-[var(--solid)] text-[var(--solid-text)]",
                state === "todo" &&
                  "border border-[var(--hairline-strong)] text-[var(--text-dim)]",
              )}
            >
              {state === "done" ? <CheckIcon className="h-3.5 w-3.5" /> : n}
            </span>
            <span
              className={cx(
                "hidden text-xs font-medium sm:block",
                state === "todo" ? "text-[var(--text-dim)]" : "text-[var(--text)]",
              )}
            >
              {label}
            </span>
            {i < labels.length - 1 && (
              <span className="h-px flex-1 bg-[var(--border-strong)]" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StepCard({
  number,
  title,
  description,
  done,
  children,
}: {
  number: number;
  title: string;
  description: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-6">
      <div className="mb-4 flex items-start gap-3">
        <span
          className={cx(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
            done
              ? "bg-[var(--ok-soft)] text-[var(--ok)]"
              : "bg-[var(--accent-soft)] text-[var(--accent)]",
          )}
        >
          {done ? <CheckIcon className="h-3.5 w-3.5" /> : number}
        </span>
        <div>
          <h2 className="font-semibold tracking-tight">{title}</h2>
          <p className="mt-0.5 text-sm text-[var(--text-muted)]">{description}</p>
        </div>
      </div>
      {children}
    </Card>
  );
}
