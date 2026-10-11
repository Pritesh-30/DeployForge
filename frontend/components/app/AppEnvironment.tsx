"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useApp } from "@/components/app/AppFrame";
import EnvVarEditor from "@/components/EnvVarEditor";
import { toast } from "@/components/Feedback";
import { AlertIcon, CheckIcon, KeyIcon, RocketIcon } from "@/components/Icons";
import { Button, Spinner, cx } from "@/components/ui";
import { applyEnvironment, environmentStatus, type EnvState } from "@/lib/apps";

/**
 * Environment variables: per app, encrypted at rest, injected at build and run.
 *
 * Saving is not the end of it — the running app has to pick the change up.
 * After every save this tab asks the server what that takes and does the
 * cheap part itself: a variable read at start is applied by restarting the
 * container (seconds), with no button to remember. A variable baked into the
 * build (NEXT_PUBLIC_*, VITE_* … on a buildpack build) needs a redeploy, which
 * is offered rather than started, because it takes minutes. The strip at the
 * top always says which of these is true right now.
 */
export default function AppEnvironment() {
  const { app, api, reload } = useApp();
  const router = useRouter();
  const [state, setState] = useState<EnvState | null>(null);
  const [applying, setApplying] = useState<"restart" | "redeploy" | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await environmentStatus(app.id);
      setState(next);
      return next;
    } catch {
      return null;
    }
  }, [app.id]);

  useEffect(() => {
    let active = true;
    environmentStatus(app.id).then((s) => active && setState(s)).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [app.id]);

  async function apply(kind: "restart" | "redeploy") {
    setApplying(kind);
    try {
      const result = await applyEnvironment(app.id);
      setState(result);
      if (result.action === "restarted") {
        toast("Saved and in effect — the app restarted with the new values.");
      } else if (result.action === "redeploying" && result.build_deployment_id) {
        toast("Redeploying with the new values. It goes live by itself when the build finishes.", "info");
        router.push(api.deploymentHref(result.build_deployment_id));
      }
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not apply the variables.", "danger");
      await refresh();
    } finally {
      setApplying(null);
    }
  }

  async function onSaved() {
    const next = await refresh();
    if (!next) return toast("Saved.");
    switch (next.state) {
      case "not_running":
        return toast("Saved. The app is not running; it uses these values the next time it starts.", "info");
      case "in_effect":
        return toast("Saved. The running app already has these values.");
      case "restart":
        // Cheap and safe: do it rather than ask.
        return apply("restart");
      case "rebuild":
        return toast(
          `Saved. ${next.build_time.join(", ")} ${next.build_time.length === 1 ? "is" : "are"} built into the app, so a redeploy is needed for ${next.build_time.length === 1 ? "it" : "them"} to take effect.`,
          "info",
          { label: "Redeploy now", onClick: () => apply("redeploy") },
        );
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div className="plate overflow-hidden">
        <EnvStatus state={state} applying={applying} onApply={apply} />
        <div className="p-6">
          <EnvVarEditor repositoryId={app.id} onSaved={onSaved} />
        </div>
      </div>
      <aside className="space-y-4 text-sm leading-relaxed text-[var(--text-muted)]">
        <div className="plate p-5">
          <p className="mb-2 inline-flex items-center gap-2 font-medium text-[var(--text)]">
            <KeyIcon className="h-4 w-4 text-[var(--accent)]" />
            How variables reach your app
          </p>
          <ul className="list-disc space-y-1.5 pl-4">
            <li>Encrypted at rest with a key only this server holds.</li>
            <li>Given to the app every time it starts — saving restarts it for you.</li>
            <li>On a buildpack build, also seen while building: values like <code>NEXT_PUBLIC_*</code> need a redeploy.</li>
            <li>A secret&apos;s value is never sent back to the browser.</li>
          </ul>
        </div>
        <div className="plate p-5">
          <p className="mb-2 font-medium text-[var(--text)]">Set by the platform</p>
          <p><code className="text-[var(--text)]">PORT</code> — listen on it, not a fixed number.</p>
          {app.is_multi_service && (
            <p className="mt-1.5">
              <code className="text-[var(--text)]">&lt;SERVICE&gt;_URL</code> — each service&apos;s address inside the stack,
              e.g. <code>BACKEND_URL</code>. Your own value wins if you set one.
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}

function EnvStatus({ state, applying, onApply }: {
  state: EnvState | null;
  applying: "restart" | "redeploy" | null;
  onApply: (kind: "restart" | "redeploy") => void;
}) {
  if (!state) return <div className="h-12 border-b border-[var(--hairline)]" />;

  const pending = state.state === "restart" || state.state === "rebuild";
  const tone = applying ? "info" : pending ? "warn" : state.state === "in_effect" ? "ok" : "neutral";
  const keys = state.changed.slice(0, 4).join(", ") + (state.changed.length > 4 ? ` +${state.changed.length - 4}` : "");

  return (
    <div className={cx(
      "flex flex-wrap items-center gap-3 border-b px-6 py-3 text-sm",
      tone === "ok" && "border-[var(--ok)]/20 bg-[var(--ok-soft)] text-[var(--ok)]",
      tone === "warn" && "border-[var(--warn)]/25 bg-[var(--warn-soft)] text-[var(--warn)]",
      tone === "info" && "border-[var(--info)]/25 bg-[var(--info-soft)] text-[var(--info)]",
      tone === "neutral" && "border-[var(--hairline)] text-[var(--text-muted)]",
    )} aria-live="polite">
      {applying ? <Spinner /> : pending ? <AlertIcon className="h-4 w-4 shrink-0" /> : <CheckIcon className="h-4 w-4 shrink-0" />}
      <p className="min-w-0 flex-1">
        {applying === "restart" ? "Restarting the app with the new values…"
          : applying === "redeploy" ? "Starting a redeploy…"
          : state.state === "in_effect" ? "The running app has exactly these values."
          : state.state === "not_running" ? "The app is not running. These values are used the next time it starts."
          : state.state === "restart" ? <>Not in effect yet: <code>{keys}</code>. A restart applies {state.changed.length === 1 ? "it" : "them"} in seconds.</>
          : <>Built into the app: <code>{state.build_time.join(", ")}</code>. A redeploy is needed for {state.build_time.length === 1 ? "it" : "them"} to take effect.</>}
      </p>
      {!applying && state.state === "restart" && (
        <Button size="sm" onClick={() => onApply("restart")}>Apply now</Button>
      )}
      {!applying && state.state === "rebuild" && (
        <Button size="sm" variant="primary" onClick={() => onApply("redeploy")}><RocketIcon className="h-3.5 w-3.5" />Redeploy</Button>
      )}
    </div>
  );
}
