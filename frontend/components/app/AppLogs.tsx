/**
 * The app's two logs, live: what the running app prints, and how a build
 * went. Kept apart deliberately — "why won't it build" and "why won't it stay
 * up" are different questions with different answers.
 */

"use client";

import { useMemo, useState } from "react";
import { Select } from "@/components/Controls";

import { useApp } from "@/components/app/AppFrame";
import LogViewer from "@/components/LogViewer";
import { cx, relativeTime } from "@/components/ui";
import { isRunning } from "@/lib/deployments";

type Source = "runtime" | "build";

export default function AppLogs() {
  const { app, api } = useApp();
  const live = app.deployments.find((d) => isRunning(d.status));
  const [source, setSource] = useState<Source>(live ? "runtime" : "build");
  const [deploymentId, setDeploymentId] = useState<string | null>(app.current?.id ?? null);

  const ran = useMemo(
    () => app.deployments.filter((d) => d.runtime_started_at || isRunning(d.status)),
    [app.deployments],
  );
  const chosen = app.deployments.find((d) => d.id === deploymentId) ?? app.current;
  const runtimeTarget = source === "runtime" ? (live ?? ran.find((d) => d.id === deploymentId) ?? ran[0]) : null;

  const path =
    source === "runtime"
      ? runtimeTarget ? api.runtimeLogStream(runtimeTarget.id) : null
      : chosen ? api.buildLogStream(chosen.id).replace(/\?offset=\d+$/, "") : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-full border border-[var(--hairline)] bg-[var(--surface)] p-1">
          {(["runtime", "build"] as Source[]).map((s) => (
            <button key={s} onClick={() => setSource(s)}
              className={cx(
                "rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors duration-[var(--t-hover)]",
                source === s ? "bg-[var(--solid)] text-[var(--solid-text)]" : "text-[var(--text-muted)] hover:text-[var(--text)]",
              )}>
              {s === "runtime" ? "Runtime" : "Build"}
            </button>
          ))}
        </div>

        <Select
          ariaLabel="Deployment"
          variant="pill"
          value={(source === "runtime" ? runtimeTarget?.id : chosen?.id) ?? ""}
          onChange={setDeploymentId}
          menuClassName="w-72"
          options={(source === "runtime" ? ran : app.deployments).map((d) => {
            const text = `${d.commit_sha?.slice(0, 7) ?? d.id.slice(0, 8)} · ${d.status}${d.id === app.current?.id ? " · current" : ""}`;
            return {
              value: d.id,
              text,
              label: <span className="font-[family-name:var(--font-jetbrains-mono)] text-xs">{text}</span>,
              hint: relativeTime(d.created_at),
            };
          })}
        />

        <p className="text-xs text-[var(--text-dim)]">
          {source === "runtime"
            ? app.current?.compose_project ? "Every service of the stack, interleaved." : "Standard output and error of the container."
            : "Download, detection, build and image push."}
        </p>
      </div>

      {path ? (
        <LogViewer key={path} streamPath={path} kind={source} height="36rem"
          filename={`${app.name}-${source}.log`}
          emptyText={source === "runtime" ? "The app has not printed anything yet." : "No build output yet."} />
      ) : (
        <p className="rounded-[var(--r)] border border-dashed border-[var(--hairline-strong)] px-4 py-16 text-center text-sm text-[var(--text-dim)]">
          {source === "runtime" ? "This app has never run, so it has no output yet." : "This app has never been built."}
        </p>
      )}
    </div>
  );
}
