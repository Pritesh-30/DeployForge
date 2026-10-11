/**
 * Admin-only calls: who is on the platform, what they are running, and the
 * levers for controlling it.
 */

import { apiFetch } from "@/lib/api";
import type { Activity, App, AppDetail, AppMetrics, AppPulse, Point, Window } from "@/lib/apps";
import type { AiDiagnosis, BuildLogs, Deployment, DeploymentEvent } from "@/lib/deployments";
import type { User, UserRole } from "@/lib/auth";

export type UserWithDeployments = {
  id: string;
  email: string;
  role: UserRole;
  is_active: boolean;
  created_at: string;
  deployment_count: number;
  repository_count: number;
  running_count: number;
  max_deployments: number;
  can_deploy: boolean;
  deploy_block_reason: string | null;
  github_username: string | null;
  deployments: Deployment[];
};

export type PlatformAnalytics = {
  users: number;
  admins: number;
  active_users: number;
  blocked_users: number;
  github_connections: number;
  repositories: number;
  deployments: number;
  running: number;
  stopped: number;
  failed: number;
  suspended: number;
  by_method: Record<string, number>;
  by_framework: Record<string, number>;
  by_status: Record<string, number>;
  daily: { date: string; count: number }[];
  top_users: { email: string; deployments: number; running: number }[];
  build_seconds_median: number | null;
  build_seconds_max: number | null;
  success_rate: number | null;
};

export type PlatformStatus = {
  docker: boolean;
  registry: boolean;
  router: boolean;
  buildpacks: boolean;
  detail: Record<string, string>;
};

export function getOverview(): Promise<UserWithDeployments[]> {
  return apiFetch<UserWithDeployments[]>("/admin/overview");
}

export function getAnalytics(): Promise<PlatformAnalytics> {
  return apiFetch<PlatformAnalytics>("/admin/analytics");
}

export function getPlatformStatus(): Promise<PlatformStatus> {
  return apiFetch<PlatformStatus>("/admin/platform/status");
}

export function getAllDeployments(): Promise<Deployment[]> {
  return apiFetch<Deployment[]>("/admin/deployments");
}

export function suspendDeployment(
  id: string,
  reason?: string,
): Promise<Deployment> {
  return apiFetch<Deployment>(`/admin/deployments/${id}/suspend`, {
    method: "POST",
    body: JSON.stringify({ reason: reason ?? null }),
  });
}

export function resumeDeployment(id: string): Promise<Deployment> {
  return apiFetch<Deployment>(`/admin/deployments/${id}/resume`, {
    method: "POST",
  });
}

export function adminDeleteDeployment(id: string): Promise<null> {
  return apiFetch<null>(`/admin/deployments/${id}`, { method: "DELETE" });
}

export type UserChanges = {
  is_active?: boolean;
  max_deployments?: number;
  role?: UserRole;
  can_deploy?: boolean;
  deploy_block_reason?: string | null;
};

export function updateUser(id: string, changes: UserChanges): Promise<User> {
  return apiFetch<User>(`/admin/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(changes),
  });
}

/** "2m 04s" — build durations read better than a raw second count. */
export function formatSeconds(seconds: number | null): string {
  if (seconds === null || Number.isNaN(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

/* -------------------------------------------------------------------------
 * The control room: every app, the queue, the machine, the audit log.
 * ---------------------------------------------------------------------- */


export type PlatformStatusFull = PlatformStatus & {
  redis: boolean;
  builds_running: number;
  builds_waiting: number;
  build_backend: string;
};

export const getPlatformStatusFull = () => apiFetch<PlatformStatusFull>("/admin/platform/status");

export const adminApps = () => apiFetch<App[]>("/admin/apps");
export const adminApp = (id: string) => apiFetch<AppDetail>(`/admin/apps/${id}`);
export const adminAppsPulse = () => apiFetch<Record<string, AppPulse>>("/admin/apps/metrics/overview");
export const adminAppMetrics = (id: string, window: Window) =>
  apiFetch<AppMetrics>(`/admin/apps/${id}/metrics?window=${window}`);
export const adminAppActivity = (id: string) => apiFetch<Activity[]>(`/admin/apps/${id}/activity`);

const post = <T,>(path: string, body?: unknown) =>
  apiFetch<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const adminStartApp = (id: string) => post<AppDetail>(`/admin/apps/${id}/start`);
export const adminStopApp = (id: string) => post<AppDetail>(`/admin/apps/${id}/stop`);
export const adminRestartApp = (id: string) => post<AppDetail>(`/admin/apps/${id}/restart`);
export const adminRedeployApp = (id: string) => post<{ deployment_id: string }>(`/admin/apps/${id}/redeploy`);
export const adminSuspendApp = (id: string, reason?: string) =>
  post<AppDetail>(`/admin/apps/${id}/suspend`, { reason: reason || null });
export const adminResumeApp = (id: string) => post<AppDetail>(`/admin/apps/${id}/resume`);
export const adminDeleteApp = (id: string) => apiFetch<null>(`/admin/apps/${id}`, { method: "DELETE" });

export const adminDeployment = (id: string) => apiFetch<Deployment>(`/admin/deployments/${id}/detail`);
export const adminBuildLogs = (id: string) => apiFetch<BuildLogs>(`/admin/deployments/${id}/logs`);
export const adminEvents = (id: string) => apiFetch<DeploymentEvent[]>(`/admin/deployments/${id}/events`);
export const adminDiagnose = (id: string, refresh = false) =>
  post<AiDiagnosis>(`/admin/deployments/${id}/diagnose${refresh ? "?refresh=true" : ""}`);

export type QueueJob = {
  id: string;
  kind: string;
  tenant: string;
  tenant_email: string | null;
  label: string;
  state: "pending" | "running" | "delayed" | "done" | "failed" | "cancelled";
  attempts: number;
  max_attempts: number;
  enqueued_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  run_at: number | null;
  worker: string;
  error: string;
  payload: { deployment_id?: string };
};

export type QueueView = {
  ring: { tenant: string; email: string | null; waiting: number }[];
  pending: Record<string, QueueJob[]>;
  order: string[];
  running: QueueJob[];
  delayed: QueueJob[];
  recent: QueueJob[];
  stats: Record<string, number>;
  concurrency: number;
};

export const getQueue = () => apiFetch<QueueView>("/admin/queue");
export const cancelJob = (id: string) => post<{ state: string }>(`/admin/queue/${encodeURIComponent(id)}/cancel`);

export type HostMetrics = {
  window: Window;
  samples: number;
  series: { cpu: Point[]; mem: Point[]; apps: Point[]; builds: Point[]; containers: Point[] };
  latest: (Record<string, number> & { ts: number }) | null;
};

export const getHostMetrics = (window: Window) => apiFetch<HostMetrics>(`/admin/platform/metrics?window=${window}`);

export type ContainerRow = {
  name: string;
  image: string;
  status: string;
  created: string;
  platform: boolean;
  app: { app_id: string; app: string; owner: string; deployment_id: string } | null;
  cpu: number | null;
  mem: number | null;
  mem_limit: number | null;
  net_rx: number | null;
  net_tx: number | null;
  pids: number | null;
};

export type ContainersView = {
  host: {
    cpus: number | null;
    mem_total: number | null;
    os: string | null;
    kernel: string | null;
    docker: string | null;
    containers_running: number | null;
    images: number | null;
  };
  containers: ContainerRow[];
};

export const getContainers = () => apiFetch<ContainersView>("/admin/platform/containers");
export const getDisk = () =>
  apiFetch<{ Type: string; TotalCount: string; Active: string; Size: string; Reclaimable: string }[]>(
    "/admin/platform/disk",
  );

export type AuditEntry = {
  id: string;
  actor_email: string;
  actor_role: string;
  action: string;
  target_type: string;
  target_id: string | null;
  target_label: string | null;
  subject_user_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
};

export const getAudit = (action?: string, limit = 200) =>
  apiFetch<{ events: AuditEntry[]; counts: Record<string, number> }>(
    `/admin/audit?limit=${limit}${action ? `&action=${encodeURIComponent(action)}` : ""}`,
  );

export type UserDetail = {
  user: User;
  github_username: string | null;
  apps: App[];
  activity: Activity[];
  audit: AuditEntry[];
  usage: { apps: number; running: number; builds: number; failed: number; build_minutes: number; quota: number };
};

export const getUserDetail = (id: string) => apiFetch<UserDetail>(`/admin/users/${id}`);
