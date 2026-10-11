"use client";

import { useApp } from "@/components/app/AppFrame";
import EnvVarEditor from "@/components/EnvVarEditor";
import { KeyIcon } from "@/components/Icons";

/** Environment variables: per app, encrypted at rest, injected at build and run. */
export default function AppEnvironment() {
  const { app } = useApp();
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div className="plate p-6">
        <EnvVarEditor repositoryId={app.id} />
      </div>
      <aside className="space-y-4 text-sm leading-relaxed text-[var(--text-muted)]">
        <div className="plate p-5">
          <p className="mb-2 inline-flex items-center gap-2 font-medium text-[var(--text)]">
            <KeyIcon className="h-4 w-4 text-[var(--accent)]" />
            How variables reach your app
          </p>
          <ul className="list-disc space-y-1.5 pl-4">
            <li>Encrypted at rest with a key only this server holds.</li>
            <li>Injected when the app is built and every time it starts.</li>
            <li>Masked in build logs, including on GitHub Actions.</li>
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
          <p className="mt-3 text-xs text-[var(--text-dim)]">Restart the app after changing variables.</p>
        </div>
      </aside>
    </div>
  );
}
