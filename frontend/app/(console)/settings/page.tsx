/**
 * The account: who is signed in, and the GitHub connection everything else
 * depends on — with what it can do, and the way to renew or remove it.
 */

"use client";

import { useEffect, useState } from "react";

import { ConfirmDialog, toast } from "@/components/Feedback";
import { CheckIcon, GitHubIcon, ShieldIcon } from "@/components/Icons";
import { useSession } from "@/components/Session";
import { Alert, Badge, Button, Eyebrow, Mono, Skeleton, relativeTime } from "@/components/ui";
import { disconnectGitHub, getAuthorizeUrl, getConnectionStatus, type ConnectionStatus } from "@/lib/github";

const SCOPES: Record<string, string> = {
  repo: "List and download your repositories, and read their code",
  workflow: "Add the DeployForge build workflow to a repository",
  "read:packages": "Pull the images your builds pushed",
  "delete:packages": "Clear images from GitHub once this server has stored them",
};

export default function SettingsPage() {
  const { user } = useSession();
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    getConnectionStatus().then(setStatus).catch(() => setStatus({ connected: false } as ConnectionStatus));
  }, []);

  async function connect() {
    setBusy(true);
    try {
      window.location.href = (await getAuthorizeUrl()).authorize_url;
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not start the GitHub connection.", "danger");
      setBusy(false);
    }
  }

  const granted = new Set((status?.scopes ?? "").split(/[,\s]+/).filter(Boolean));

  return (
    <div className="space-y-8">
      <div>
        <Eyebrow>Account</Eyebrow>
        <h1 className="mt-3 text-[2rem] font-semibold leading-tight">Settings</h1>
      </div>

      <section className="plate grid gap-5 p-6 lg:grid-cols-[18rem_1fr]">
        <div>
          <h2 className="text-[15px] font-semibold">Account</h2>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Signed in with email and password.</p>
        </div>
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-[var(--text-dim)]">Email</dt><dd className="mt-1">{user.email}</dd></div>
          <div><dt className="text-xs text-[var(--text-dim)]">Role</dt><dd className="mt-1">{user.role === "admin" ? "Administrator" : "Student"}</dd></div>
          <div><dt className="text-xs text-[var(--text-dim)]">Member since</dt><dd className="mt-1">{new Date(user.created_at).toLocaleDateString()}</dd></div>
        </dl>
      </section>

      <section className="plate grid gap-5 p-6 lg:grid-cols-[18rem_1fr]">
        <div>
          <h2 className="inline-flex items-center gap-2 text-[15px] font-semibold"><GitHubIcon className="h-4 w-4" />GitHub</h2>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            How DeployForge reads your repositories and builds them. The token is encrypted at rest and never sent to the browser.
          </p>
        </div>
        {status === null ? <Skeleton className="h-32" /> : status.connected ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone="ok"><CheckIcon className="h-3 w-3" />Connected</Badge>
              <span className="text-sm">as <Mono className="text-[var(--text)]">{status.github_username}</Mono></span>
              {status.connected_at && <span className="text-xs text-[var(--text-dim)]">since {relativeTime(status.connected_at)}</span>}
            </div>
            {status.needs_reconnect && (
              <Alert tone="warn" title="Reconnect to keep deploying">
                DeployForge now needs permissions your connection does not include. Reconnecting takes a few seconds.
              </Alert>
            )}
            <ul className="space-y-2">
              {Object.entries(SCOPES).map(([scope, what]) => (
                <li key={scope} className="flex items-start gap-3 text-sm">
                  <span className={granted.has(scope) ? "text-[var(--ok)]" : "text-[var(--text-dim)]"}>
                    {granted.has(scope) ? <CheckIcon className="mt-0.5 h-3.5 w-3.5" /> : <ShieldIcon className="mt-0.5 h-3.5 w-3.5" />}
                  </span>
                  <span>
                    <Mono className="text-[var(--text)]">{scope}</Mono> <span className="text-[var(--text-muted)]">— {what}</span>
                    {!granted.has(scope) && <span className="text-xs text-[var(--text-dim)]"> (not granted)</span>}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button onClick={connect} loading={busy}>Reconnect</Button>
              <Button variant="danger" onClick={() => setConfirm(true)}>Disconnect</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-[var(--text-muted)]">Not connected. Connect GitHub to deploy a repository.</p>
            <Button variant="primary" onClick={connect} loading={busy}><GitHubIcon className="h-4 w-4" />Connect GitHub</Button>
          </div>
        )}
      </section>

      <ConfirmDialog open={confirm} title="Disconnect GitHub?" confirmLabel="Disconnect" danger busy={busy}
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          setBusy(true);
          try {
            await disconnectGitHub();
            toast("GitHub disconnected.");
            setStatus(await getConnectionStatus());
            setConfirm(false);
          } catch (err) {
            toast(err instanceof Error ? err.message : "Could not disconnect.", "danger");
          } finally {
            setBusy(false);
          }
        }}>
        Apps that are running keep running. Redeploying, the code view and push deploys stop working until you connect again.
      </ConfirmDialog>
    </div>
  );
}
