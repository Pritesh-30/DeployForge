/**
 * One app view, two audiences.
 *
 * The owner's app page and an administrator's view of a student's app are the
 * same screens: status, deployments, logs, metrics, activity. What differs is
 * which endpoints answer and what each may do — an owner can browse the code
 * and edit the environment; an administrator can suspend. The screens are
 * written once against this interface, and each audience supplies its
 * implementation, rather than two copies of every page drifting apart.
 */

import { apiFetch } from "@/lib/api";
import {
  adminApp,
  adminAppActivity,
  adminAppMetrics,
  adminBuildLogs,
  adminDeleteApp,
  adminDeployment,
  adminDiagnose,
  adminEvents,
  adminRedeployApp,
  adminRestartApp,
  adminResumeApp,
  adminStartApp,
  adminStopApp,
  adminSuspendApp,
} from "@/lib/admin";
import {
  appActivity,
  appMetrics,
  deleteApp,
  getApp,
  promoteDeployment,
  redeployApp,
  type Activity,
  type AppDetail,
  type AppMetrics,
  type Window,
} from "@/lib/apps";
import {
  adminCiProgress,
  ciProgress,
  diagnoseDeployment,
  getBuildLogs,
  getDeployment,
  getEvents,
  isRunning,
  restartDeployment,
  startDeployment,
  stopDeployment,
  type AiDiagnosis,
  type CiProgress,
  type BuildLogs,
  type Deployment,
  type DeploymentEvent,
} from "@/lib/deployments";

export type AppMode = "owner" | "admin";

export type AppApi = {
  mode: AppMode;
  /** Where this audience's app pages live: /apps or /admin/apps. */
  base: string;
  deploymentHref: (deploymentId: string) => string;

  get: (id: string) => Promise<AppDetail>;
  metrics: (id: string, window: Window) => Promise<AppMetrics>;
  activity: (id: string) => Promise<Activity[]>;

  start: (app: AppDetail) => Promise<void>;
  stop: (app: AppDetail) => Promise<void>;
  restart: (app: AppDetail) => Promise<void>;
  redeploy: (app: AppDetail, fresh?: boolean) => Promise<string>;
  promote: (app: AppDetail, deploymentId: string) => Promise<void>;
  remove: (app: AppDetail) => Promise<void>;
  suspend?: (app: AppDetail, reason: string) => Promise<void>;
  resume?: (app: AppDetail) => Promise<void>;

  deployment: (id: string) => Promise<Deployment>;
  buildLog: (id: string) => Promise<BuildLogs>;
  events: (id: string) => Promise<DeploymentEvent[]>;
  diagnose: (id: string, refresh?: boolean) => Promise<AiDiagnosis>;
  ciProgress: (id: string) => Promise<CiProgress>;
  buildLogStream: (id: string, offset?: number) => string;
  runtimeLogStream: (id: string) => string;
};

/**
 * What "start this app" should start: the live deployment if there is one,
 * else the newest that built successfully — if the last build failed,
 * starting means running the version before it.
 */
export function runnableDeployment(app: AppDetail): Deployment | null {
  const live = app.deployments.find((d) => isRunning(d.status));
  if (live) return live;
  return (
    app.deployments.find(
      (d) =>
        (d.status === "built" || d.status === "stopped") &&
        (d.image_ref || (d.build_method === "compose" && d.compose_project)) &&
        !d.suspended_by_admin,
    ) ?? null
  );
}

export const ownerApi: AppApi = {
  mode: "owner",
  base: "/apps",
  deploymentHref: (id) => `/deployments/${id}`,
  get: getApp,
  metrics: appMetrics,
  activity: appActivity,
  async start(app) {
    const target = runnableDeployment(app);
    if (!target) throw new Error("This app has no successful build to start. Redeploy it.");
    if (!isRunning(target.status)) await startDeployment(target.id);
  },
  async stop(app) {
    for (const d of app.deployments.filter((d) => isRunning(d.status))) await stopDeployment(d.id);
  },
  async restart(app) {
    const live = app.deployments.find((d) => isRunning(d.status));
    if (!live) throw new Error("This app is not running.");
    await restartDeployment(live.id);
  },
  async redeploy(app, fresh) {
    return (await redeployApp(app.id, fresh)).deployment_id;
  },
  async promote(app, deploymentId) {
    await promoteDeployment(app.id, deploymentId);
  },
  async remove(app) {
    await deleteApp(app.id);
  },
  deployment: getDeployment,
  buildLog: getBuildLogs,
  events: getEvents,
  diagnose: diagnoseDeployment,
  ciProgress,
  buildLogStream: (id, offset = 0) => `/deployments/${id}/logs/stream?offset=${offset}`,
  runtimeLogStream: (id) => `/deployments/${id}/runtime-logs/stream?tail=300`,
};

export const adminApi: AppApi = {
  mode: "admin",
  base: "/admin/apps",
  deploymentHref: (id) => `/admin/deployments/${id}`,
  get: adminApp,
  metrics: adminAppMetrics,
  activity: adminAppActivity,
  async start(app) {
    await adminStartApp(app.id);
  },
  async stop(app) {
    await adminStopApp(app.id);
  },
  async restart(app) {
    await adminRestartApp(app.id);
  },
  async redeploy(app, fresh) {
    return (await adminRedeployApp(app.id, fresh)).deployment_id;
  },
  async promote(app, deploymentId) {
    // An administrator rolls back by starting that version as the owner would.
    await apiFetch(`/admin/apps/${app.id}/start?deployment=${deploymentId}`, { method: "POST" });
  },
  async remove(app) {
    await adminDeleteApp(app.id);
  },
  async suspend(app, reason) {
    await adminSuspendApp(app.id, reason);
  },
  async resume(app) {
    await adminResumeApp(app.id);
  },
  deployment: adminDeployment,
  buildLog: adminBuildLogs,
  events: adminEvents,
  diagnose: adminDiagnose,
  ciProgress: adminCiProgress,
  buildLogStream: (id, offset = 0) => `/admin/deployments/${id}/logs/stream?offset=${offset}`,
  runtimeLogStream: (id) => `/admin/deployments/${id}/runtime-logs/stream?tail=300`,
};
