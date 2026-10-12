/**
 * Apps — the things a student owns.
 *
 * An app is a repository target they connected. A deployment is one attempt to
 * build and run it. Rebuilding gives an app another deployment, not the
 * student another app, so the list they see is a list of apps and the history
 * lives inside each one.
 */

import { apiFetch } from "@/lib/api";
import type { DetectedType, Deployment } from "@/lib/deployments";

export type DayCount = { date: string; succeeded: number; failed: number };

export type AppStats = {
  builds: number;
  succeeded: number;
  failed: number;
  success_rate: number | null;
  build_seconds_median: number | null;
  build_seconds_last: number | null;
  build_seconds_trend: number[];
  last_failure_at: string | null;
  daily: DayCount[];
};

export type App = {
  id: string;
  name: string;
  full_name: string;
  target_label: string;
  default_branch: string;
  deploy_path: string | null;
  service_paths: string[] | null;
  is_multi_service: boolean;
  detected_type: DetectedType | null;
  detected_framework: string | null;
  auto_deploy: boolean;
  created_at: string;
  updated_at: string;
  /** The running deployment, or the latest attempt. Null if never built. */
  current: Deployment | null;
  deployment_count: number;
  last_deployed_at: string | null;
  owner_id?: string | null;
  owner_email?: string | null;
};

export type AppDetail = App & {
  deployments: Deployment[];
  stats: AppStats;
};

export type Activity = {
  id: string;
  deployment_id: string;
  app_id: string;
  app_label: string;
  stage: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
  actor: string | null;
  created_at: string;
};

/* --- Metrics ------------------------------------------------------------ */

export type Point = [number, number];
export type Window = "1h" | "6h" | "24h";

export type AppMetrics = {
  window: Window;
  samples: number;
  series: {
    cpu: Point[];
    mem: Point[];
    latency: Point[];
    net_rx: Point[];
    net_tx: Point[];
  };
  summary: {
    samples: number;
    uptime: number | null;
    latency_p50: number | null;
    latency_p95: number | null;
    cpu_avg: number | null;
    cpu_max: number | null;
    mem_avg: number | null;
    mem_max: number | null;
  };
  latest: (Record<string, number> & { ts: number }) | null;
};

export type AppPulse = {
  latest: (Record<string, number> & { ts: number }) | null;
  cpu: Point[];
  mem: Point[];
  uptime: number | null;
  latency_p50: number | null;
};

/* --- Code --------------------------------------------------------------- */

export type TreeEntry = {
  path: string;
  type: "file" | "dir";
  size: number;
  sha: string | null;
  submodule?: boolean;
};

export type CodeFile = {
  path: string;
  sha: string;
  size: number;
  language: string;
  html_url: string;
  binary: boolean;
  too_large: boolean;
  content: string | null;
};

export type Commit = {
  sha: string;
  message: string;
  body: string;
  author: string | null;
  avatar_url: string | null;
  date: string | null;
  html_url: string | null;
};

export type CodeSummary = {
  repository: {
    full_name: string;
    description: string | null;
    default_branch: string;
    private: boolean;
    html_url: string;
    stars: number;
    forks: number;
    open_issues: number;
    size_kb: number;
    language: string | null;
    topics: string[];
    license: string | null;
    pushed_at: string | null;
  };
  ref: string;
  sha: string;
  deploy_path: string | null;
  service_paths: string[] | null;
  branch: string;
  branches: { name: string; sha: string; protected: boolean }[];
  languages: { name: string; bytes: number; share: number }[];
  head: Commit | null;
};

export type Comparison = {
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  commits: Commit[];
  files: { filename: string; status: string; additions: number; deletions: number; patch: string | null }[];
  additions: number;
  deletions: number;
};

/* --- Calls -------------------------------------------------------------- */

export const listApps = () => apiFetch<App[]>("/apps");
export const getApp = (id: string) => apiFetch<AppDetail>(`/apps/${id}`);
export const appsPulse = () => apiFetch<Record<string, AppPulse>>("/apps/metrics/overview");
export const myActivity = (limit = 50) => apiFetch<Activity[]>(`/apps/activity?limit=${limit}`);
export const appActivity = (id: string) => apiFetch<Activity[]>(`/apps/${id}/activity`);
export const appMetrics = (id: string, window: Window) =>
  apiFetch<AppMetrics>(`/apps/${id}/metrics?window=${window}`);

export const deleteApp = (id: string) => apiFetch<null>(`/apps/${id}`, { method: "DELETE" });

export const updateApp = (id: string, changes: { branch?: string; auto_deploy?: boolean }) =>
  apiFetch<AppDetail>(`/apps/${id}`, { method: "PATCH", body: JSON.stringify(changes) });

/** `fresh` builds even when this commit was already built with the same settings. */
export const redeployApp = (id: string, fresh = false) =>
  apiFetch<{ deployment_id: string }>(`/apps/${id}/redeploy${fresh ? "?fresh=true" : ""}`, { method: "POST" });

export const promoteDeployment = (appId: string, deploymentId: string) =>
  apiFetch<Deployment>(`/apps/${appId}/deployments/${deploymentId}/promote`, { method: "POST" });

const q = (params: Record<string, string | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : "";
};

export const codeSummary = (id: string, ref?: string) =>
  apiFetch<CodeSummary>(`/apps/${id}/code/summary${q({ ref })}`);
export const codeTree = (id: string, ref?: string) =>
  apiFetch<{ sha: string; entries: TreeEntry[]; truncated: boolean }>(`/apps/${id}/code/tree${q({ ref })}`);
export const codeFile = (id: string, path: string, ref?: string) =>
  apiFetch<CodeFile>(`/apps/${id}/code/file${q({ path, ref })}`);
export const codeReadme = (id: string, dir: string, ref?: string) =>
  apiFetch<{ path: string | null; name: string | null; content: string | null }>(
    `/apps/${id}/code/readme${q({ dir, ref })}`,
  );
export const codeCommits = (id: string, ref?: string, path?: string, page = 1) =>
  apiFetch<Commit[]>(`/apps/${id}/code/commits${q({ ref, path, page: String(page) })}`);
export const codeCompare = (id: string, base: string, head: string) =>
  apiFetch<Comparison>(`/apps/${id}/code/compare${q({ base, head })}`);

/* --- Reading an app's state --------------------------------------------- */

export type StateTone = "ok" | "warn" | "danger" | "info" | "neutral";

/** What the app is doing right now, in a word or two. */
export function appState(app: App): { label: string; tone: StateTone; live: boolean } {
  if (app.current?.suspended_by_admin) return { label: "Suspended", tone: "danger", live: false };
  if (!app.current) return { label: "Not deployed", tone: "neutral", live: false };
  switch (app.current.status) {
    case "running":
    case "live":
      return { label: "Running", tone: "ok", live: true };
    case "queued":
      return { label: "Queued", tone: "info", live: false };
    case "building":
    case "pushing":
      return { label: "Building", tone: "info", live: false };
    case "starting":
      return { label: "Starting", tone: "info", live: false };
    case "built":
      return { label: "Ready to start", tone: "info", live: false };
    case "stopped":
      return { label: "Stopped", tone: "warn", live: false };
    case "failed":
      return { label: "Failed", tone: "danger", live: false };
    default:
      return { label: "Not deployed", tone: "neutral", live: false };
  }
}

/**
 * The deployment being built or started right now, if any — which is not
 * always `current`: while a new version builds, `current` is still the one
 * serving traffic.
 */
export function inflightDeployment(app: AppDetail): Deployment | null {
  const busy = (d: Deployment) => ["queued", "building", "pushing", "starting"].includes(d.status);
  return app.deployments.find(busy) ?? (app.current && busy(app.current) ? app.current : null);
}

export function appIsBusy(app: App): boolean {
  return !!app.current && ["queued", "building", "pushing", "starting"].includes(app.current.status);
}

/**
 * What an app is, in a word: its framework when one was detected, "Docker"
 * when it brings its own Dockerfile or Compose file (and so has no detected
 * framework), and a dash rather than "Unknown" when nothing is known.
 */
export function appKind(app: Pick<App, "detected_framework" | "detected_type" | "is_multi_service">): string {
  if (app.is_multi_service) return "Multi-service";
  if (app.detected_framework) {
    const names: Record<string, string> = {
      nextjs: "Next.js", react: "React", express: "Express", node: "Node.js", django: "Django",
      fastapi: "FastAPI", flask: "Flask", python: "Python", go: "Go", ruby: "Ruby", java: "Java",
      php: "PHP", static: "Static site", vue: "Vue", svelte: "Svelte",
    };
    return names[app.detected_framework] ?? app.detected_framework;
  }
  return app.detected_type === "docker" ? "Docker" : "—";
}

/* --- Environment in effect ---------------------------------------------- */

/**
 * Whether the running app has the variables saved now:
 *   not_running — nothing runs; the next start uses them
 *   in_effect   — the running app has exactly these
 *   restart     — a restart (seconds) puts them in effect
 *   rebuild     — a value is baked into the build; only a redeploy carries it
 */
export type EnvState = {
  state: "not_running" | "in_effect" | "restart" | "rebuild";
  changed: string[];
  build_time: string[];
  deployment_id: string | null;
};

export const environmentStatus = (id: string) => apiFetch<EnvState>(`/apps/${id}/environment/status`);
export const applyEnvironment = (id: string) =>
  apiFetch<EnvState & { action: "none" | "restarted" | "redeploying"; build_deployment_id?: string }>(
    `/apps/${id}/environment/apply`, { method: "POST" },
  );
