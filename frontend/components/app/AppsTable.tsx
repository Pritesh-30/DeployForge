/**
 * Apps as a table: one row each, with what is worth knowing at a glance —
 * state, address, what it is using right now and over the last hour, when it
 * last deployed — and the controls to act on it without opening it.
 *
 * Shared by the student's list and the administrator's, which adds the owner
 * column and acts through the admin endpoints.
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Sparkline } from "@/components/charts";
import { toast } from "@/components/Feedback";
import { ExternalIcon, PlayIcon, RestartIcon, SearchIcon, StopIcon } from "@/components/Icons";
import { Badge, Button, Dot, EmptyState, Skeleton, cx, relativeTime } from "@/components/ui";
import { adminRestartApp, adminStartApp, adminStopApp } from "@/lib/admin";
import { appKind, appIsBusy, appState, type App, type AppPulse } from "@/lib/apps";
import { isRunning, restartDeployment, startDeployment, stopDeployment } from "@/lib/deployments";
import { bytes, percent, share } from "@/lib/format";
import { fuzzyMatch } from "@/lib/fuzzy";

type Filter = "all" | "running" | "failed" | "stopped" | "building";
type Sort = "recent" | "name" | "cpu" | "memory";

export default function AppsTable({
  load,
  loadPulse,
  admin = false,
  empty,
}: {
  load: () => Promise<App[]>;
  loadPulse: () => Promise<Record<string, AppPulse>>;
  admin?: boolean;
  empty?: React.ReactNode;
}) {
  const [apps, setApps] = useState<App[] | null>(null);
  const [pulse, setPulse] = useState<Record<string, AppPulse>>({});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [pending, setPending] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await load();
      setApps(rows);
      return rows;
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not load apps.", "danger");
      return [];
    }
  }, [load]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      const rows = await refresh();
      loadPulse().then((p) => active && setPulse(p)).catch(() => undefined);
      if (active) timer = setTimeout(tick, rows.some(appIsBusy) ? 4000 : 20000);
    }
    tick();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [refresh, loadPulse]);

  async function act(app: App, name: "start" | "stop" | "restart") {
    setPending(`${app.id}:${name}`);
    try {
      if (admin) {
        await { start: adminStartApp, stop: adminStopApp, restart: adminRestartApp }[name](app.id);
      } else if (app.current) {
        await { start: startDeployment, stop: stopDeployment, restart: restartDeployment }[name](app.current.id);
      }
      toast(`${app.name}: ${name === "start" ? "started" : name === "stop" ? "stopped" : "restarted"}.`);
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Something went wrong.", "danger");
    } finally {
      setPending(null);
    }
  }

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, running: 0, failed: 0, stopped: 0, building: 0 };
    for (const a of apps ?? []) {
      c.all++;
      const s = appState(a).label;
      if (s === "Running") c.running++;
      else if (s === "Failed" || s === "Suspended") c.failed++;
      else if (appIsBusy(a)) c.building++;
      else c.stopped++;
    }
    return c;
  }, [apps]);

  const rows = useMemo(() => {
    let list = (apps ?? []).filter((a) => {
      const s = appState(a).label;
      if (filter === "running") return s === "Running";
      if (filter === "failed") return s === "Failed" || s === "Suspended";
      if (filter === "building") return appIsBusy(a);
      if (filter === "stopped") return !["Running", "Failed", "Suspended"].includes(s) && !appIsBusy(a);
      return true;
    });
    if (query.trim()) {
      list = list
        .map((a) => ({ a, m: fuzzyMatch(query, `${a.target_label} ${a.owner_email ?? ""} ${a.detected_framework ?? ""}`) }))
        .filter((x) => x.m)
        .sort((x, y) => y.m!.score - x.m!.score)
        .map((x) => x.a);
    } else {
      const cpu = (a: App) => pulse[a.id]?.latest?.cpu ?? -1;
      const mem = (a: App) => pulse[a.id]?.latest?.mem ?? -1;
      list = [...list].sort((x, y) =>
        sort === "name" ? x.target_label.localeCompare(y.target_label)
          : sort === "cpu" ? cpu(y) - cpu(x)
          : sort === "memory" ? mem(y) - mem(x)
          : (y.last_deployed_at ?? y.created_at).localeCompare(x.last_deployed_at ?? x.created_at),
      );
    }
    return list;
  }, [apps, filter, query, sort, pulse]);

  if (apps === null) {
    return <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}</div>;
  }
  if (apps.length === 0) return <>{empty}</>;

  const base = admin ? "/admin/apps" : "/apps";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-60 flex-1 items-center gap-2 rounded-full border border-[var(--hairline-strong)] bg-[var(--surface)] px-3.5 py-2 sm:max-w-sm">
          <SearchIcon className="h-3.5 w-3.5 text-[var(--text-dim)]" />
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={admin ? "Search apps, owners, frameworks…" : "Search apps…"}
            className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--text-dim)]" />
        </label>
        <div className="flex flex-wrap gap-1.5">
          {(["all", "running", "building", "failed", "stopped"] as Filter[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={cx(
                "rounded-full border px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                filter === f ? "border-[var(--hairline-strong)] bg-[var(--surface-2)] text-[var(--text)]" : "border-[var(--hairline)] text-[var(--text-dim)] hover:text-[var(--text-muted)]",
              )}>
              {f === "failed" ? "Failing" : f}<span className="tabular ml-1.5 text-[var(--text-dim)]">{counts[f]}</span>
            </button>
          ))}
        </div>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} disabled={!!query.trim()}
          className="ml-auto rounded-full border border-[var(--hairline)] bg-[var(--surface)] px-3 py-1.5 text-xs outline-none disabled:opacity-50">
          <option value="recent">Recently deployed</option>
          <option value="name">Name</option>
          <option value="cpu">CPU now</option>
          <option value="memory">Memory now</option>
        </select>
      </div>

      <div className="plate thin-scroll overflow-x-auto">
        <table className="w-full min-w-[56rem] text-sm">
          <thead>
            <tr className="border-b border-[var(--hairline)] text-left text-[11px] uppercase tracking-[0.12em] text-[var(--text-dim)]">
              <th className="px-4 py-3 font-medium">App</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">CPU · 1h</th>
              <th className="px-4 py-3 text-right font-medium">Memory</th>
              <th className="px-4 py-3 text-right font-medium">Uptime</th>
              <th className="px-4 py-3 font-medium">Deployed</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--hairline)]">
            {rows.map((a) => {
              const s = appState(a);
              const p = pulse[a.id];
              const live = a.current && isRunning(a.current.status) ? a.current : null;
              const canStart = !live && !appIsBusy(a) && !a.current?.suspended_by_admin
                && (a.current?.status === "built" || a.current?.status === "stopped");
              return (
                <tr key={a.id} className="group transition-colors hover:bg-[oklch(100%_0_0/0.02)]">
                  <td className="max-w-[22rem] px-4 py-3">
                    <Link href={`${base}/${a.id}`} className="block truncate font-medium hover:text-[var(--accent)]">{a.target_label}</Link>
                    <p className="mt-0.5 flex items-center gap-2 truncate text-xs text-[var(--text-dim)]">
                      {admin && a.owner_email && <span className="text-[var(--text-muted)]">{a.owner_email}</span>}
                      <span>{appKind(a)}</span>
                      {live?.url && (
                        <a href={live.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[var(--ok)] hover:underline">
                          {live.url.replace(/^https?:\/\//, "").split(".")[0]}<ExternalIcon className="h-3 w-3" />
                        </a>
                      )}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={s.tone}><Dot tone={s.tone} pulse={s.live} />{s.label}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Sparkline points={p?.cpu ?? []} width={84} height={24} label={`CPU of ${a.name}`} />
                      <span className="tabular w-12 text-xs text-[var(--text-muted)]">{live && p?.latest ? percent(p.latest.cpu) : "—"}</span>
                    </div>
                  </td>
                  <td className="tabular px-4 py-3 text-right text-xs text-[var(--text-muted)]">{live && p?.latest ? bytes(p.latest.mem) : "—"}</td>
                  <td className={cx("tabular px-4 py-3 text-right text-xs",
                    p?.uptime == null ? "text-[var(--text-dim)]" : p.uptime >= 0.99 ? "text-[var(--ok)]" : p.uptime >= 0.9 ? "text-[var(--warn)]" : "text-[var(--danger)]")}>
                    {p?.uptime == null ? "—" : share(p.uptime, 1)}
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--text-muted)]">
                    {a.last_deployed_at ? relativeTime(a.last_deployed_at) : "never"}
                    <span className="text-[var(--text-dim)]"> · {a.deployment_count} build{a.deployment_count === 1 ? "" : "s"}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1.5 opacity-80 transition-opacity group-hover:opacity-100">
                      {live ? (
                        <>
                          <Button size="sm" variant="ghost" title="Restart" aria-label={`Restart ${a.name}`}
                            loading={pending === `${a.id}:restart`} disabled={!!pending} onClick={() => act(a, "restart")}>
                            <RestartIcon className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" title="Stop" aria-label={`Stop ${a.name}`}
                            loading={pending === `${a.id}:stop`} disabled={!!pending} onClick={() => act(a, "stop")}>
                            <StopIcon className="h-3 w-3" />
                          </Button>
                        </>
                      ) : canStart ? (
                        <Button size="sm" variant="ghost" title="Start" loading={pending === `${a.id}:start`} disabled={!!pending}
                          onClick={() => act(a, "start")}>
                          <PlayIcon className="h-3 w-3" />Start
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-[var(--text-dim)]">No apps match.</div>
        )}
      </div>
    </div>
  );
}

export function NoApps({ action }: { action?: React.ReactNode }) {
  return (
    <EmptyState title="No apps yet" action={action}>
      Connect a GitHub repository and DeployForge works out how to build it — from its Dockerfile or Compose file, or with
      buildpacks when it has neither — then runs it at its own address.
    </EmptyState>
  );
}
