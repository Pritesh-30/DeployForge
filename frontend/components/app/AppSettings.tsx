/**
 * What the owner can change about an app after connecting it — the branch it
 * deploys from and whether a push deploys it — plus what the platform gives
 * it (its address, HTTPS) and the way to remove it.
 */

"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useApp } from "@/components/app/AppFrame";
import { ConfirmDialog, toast } from "@/components/Feedback";
import { BranchIcon, GlobeIcon, RocketIcon, TrashIcon } from "@/components/Icons";
import { useSession } from "@/components/Session";
import { Badge, Button, Mono, cx } from "@/components/ui";
import { codeSummary, updateApp } from "@/lib/apps";
import { frameworkName } from "@/lib/github";

export default function AppSettings() {
  const { app, api, act, pending, reload } = useApp();
  const { meta } = useSession();
  const router = useRouter();
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState(app.default_branch);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let active = true;
    codeSummary(app.id)
      .then((s) => active && setBranches(s.branches.map((b) => b.name)))
      .catch(() => active && setBranches([]));
    return () => {
      active = false;
    };
  }, [app.id]);

  async function save(changes: { branch?: string; auto_deploy?: boolean }, message: string) {
    setSaving(true);
    try {
      await updateApp(app.id, changes);
      toast(message);
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save.", "danger");
    } finally {
      setSaving(false);
    }
  }

  const url = app.current?.url;
  const host = url?.replace(/^https?:\/\//, "");
  const suspended = !!app.current?.suspended_by_admin;

  return (
    <div className="space-y-6">
      <Section title="Source" description="Which branch this app is built from. A change takes effect on the next deploy.">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1.5 flex items-center gap-1.5 text-xs text-[var(--text-dim)]"><BranchIcon className="h-3.5 w-3.5" />Branch</span>
            {branches && branches.length > 0 ? (
              <select value={branch} onChange={(e) => setBranch(e.target.value)}
                className="min-w-56 rounded-[var(--r-sm)] border border-[var(--hairline-strong)] bg-[var(--surface-2)] px-3 py-2 text-sm outline-none">
                {branches.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            ) : (
              <input value={branch} onChange={(e) => setBranch(e.target.value)}
                className="min-w-56 rounded-[var(--r-sm)] border border-[var(--hairline-strong)] bg-[var(--surface-2)] px-3 py-2 text-sm outline-none" />
            )}
          </label>
          <Button onClick={() => save({ branch }, `Now deploying from ${branch}.`)} loading={saving}
            disabled={branch === app.default_branch || !branch}>
            Save branch
          </Button>
        </div>
        <p className="mt-3 text-xs text-[var(--text-dim)]">
          Repository <Mono>{app.full_name}</Mono>{app.deploy_path && <> · folder <Mono>{app.deploy_path}/</Mono></>}
        </p>
      </Section>

      <Section title="Automatic deploys" description="Every push to the branch builds and deploys the app. Turn it off to push without replacing the live version — handy mid-way through a broken refactor.">
        <div className="flex items-center justify-between gap-4 rounded-[var(--r-sm)] border border-[var(--hairline)] bg-[var(--surface)] px-4 py-3">
          <div>
            <p className="text-sm font-medium">Deploy on push to {app.default_branch}</p>
            <p className="text-xs text-[var(--text-dim)]">
              {meta?.build_backend === "actions"
                ? "Pushes run the DeployForge workflow in your repository's GitHub Actions."
                : "This server builds on the Deploy button; push deploys need the GitHub Actions build backend."}
            </p>
          </div>
          <Switch on={app.auto_deploy} disabled={saving}
            onChange={(on) => save({ auto_deploy: on }, on ? "Push deploys turned on." : "Push deploys turned off.")} />
        </div>
      </Section>

      <Section title="Domain" description="Where the app answers. Assigned by the platform, stable across redeploys and rollbacks.">
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--r-sm)] border border-[var(--hairline)] bg-[var(--surface)] px-4 py-3">
          <GlobeIcon className="h-4 w-4 text-[var(--text-dim)]" />
          <Mono className="text-[13px] text-[var(--text)]">{host ?? `assigned on first start · *.${meta?.app_domain ?? "localhost"}`}</Mono>
          <span className="ml-auto flex gap-2">
            <Badge tone={meta?.https ? "ok" : "neutral"}>{meta?.https ? "HTTPS · Let's Encrypt" : "HTTP (local)"}</Badge>
            {url && <Badge tone={app.current?.status === "running" ? "ok" : "neutral"}>{app.current?.status === "running" ? "Routed" : "Not routed"}</Badge>}
          </span>
        </div>
      </Section>

      <Section title="Build" description="What the platform detected in the repository.">
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-[var(--text-dim)]">Strategy</dt><dd className="mt-1">{app.detected_type === "docker" ? "Your Dockerfile / Compose" : app.detected_type === "framework" ? "Cloud Native Buildpacks" : "—"}</dd></div>
          <div><dt className="text-xs text-[var(--text-dim)]">Framework</dt><dd className="mt-1">{frameworkName(app.detected_framework)}</dd></div>
          <div><dt className="text-xs text-[var(--text-dim)]">Built on</dt><dd className="mt-1">{meta?.build_backend === "actions" ? "GitHub Actions" : "This server's build queue"}</dd></div>
        </dl>
        <Button className="mt-4" size="sm" onClick={() => act("redeploy", async () => {
          const id = await api.redeploy(app);
          router.push(api.deploymentHref(id));
        }, "Build queued.")} loading={pending === "redeploy"} disabled={suspended}>
          <RocketIcon className="h-3.5 w-3.5" />Redeploy from {app.default_branch}
        </Button>
      </Section>

      <section className="rounded-[var(--r)] border border-[var(--danger)]/25 p-6">
        <h3 className="text-base font-semibold text-[var(--danger)]">Delete this app</h3>
        <p className="mt-1.5 max-w-2xl text-sm text-[var(--text-muted)]">
          Stops everything it runs, deletes its {app.deployment_count} deployment{app.deployment_count === 1 ? "" : "s"} and their logs, and disconnects the repository so it can be added again. The repository on GitHub is not touched.
        </p>
        <Button variant="danger" className="mt-4" onClick={() => setConfirmDelete(true)} disabled={suspended}
          title={suspended ? "A suspended app cannot be deleted" : undefined}>
          <TrashIcon className="h-3.5 w-3.5" />Delete app
        </Button>
      </section>

      <ConfirmDialog open={confirmDelete} title={`Delete ${app.name}?`} confirmLabel="Delete permanently" danger
        typeToConfirm={app.name} busy={pending === "delete"} onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          const ok = await act("delete", () => api.remove(app), `${app.name} deleted.`);
          if (ok) router.push(api.base);
        }}>
        This cannot be undone.
      </ConfirmDialog>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="plate grid gap-5 p-6 lg:grid-cols-[18rem_1fr]">
      <div>
        <h3 className="text-[15px] font-semibold">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">{description}</p>
      </div>
      <div>{children}</div>
    </section>
  );
}

function Switch({ on, onChange, disabled }: { on: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}
      className={cx(
        "relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-[var(--t-hover)] disabled:opacity-50",
        on ? "border-[var(--ok)]/40 bg-[var(--ok-soft)]" : "border-[var(--hairline-strong)] bg-[var(--surface-3)]",
      )}>
      <span className={cx(
        "absolute top-0.5 h-[18px] w-[18px] rounded-full shadow-[var(--shadow-sm)] transition-[left,background-color] duration-[var(--t-hover)] ease-[var(--ease-spring)]",
        on ? "left-[22px] bg-[var(--ok)]" : "left-0.5 bg-[var(--text-dim)]",
      )} />
    </button>
  );
}
