/**
 * The levers an administrator holds over an account, kept apart because they
 * answer different problems:
 *
 *   quota          how many apps may run at once
 *   deploy rights  the account works, but cannot build or start anything
 *   account        cannot sign in at all
 *
 * Each change is recorded in the audit log by the API.
 */

"use client";

import { useState } from "react";

import { ConfirmDialog, toast } from "@/components/Feedback";
import { BanIcon, CheckIcon, ShieldIcon } from "@/components/Icons";
import { Button } from "@/components/ui";
import { updateUser, type UserChanges } from "@/lib/admin";
import type { User } from "@/lib/auth";

export function QuotaStepper({ user, onChanged }: { user: User; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const quota = user.max_deployments ?? 3;

  async function set(value: number) {
    setBusy(true);
    try {
      await updateUser(user.id, { max_deployments: value });
      toast(`${user.email} may now run ${value} app${value === 1 ? "" : "s"} at once.`);
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not change the quota.", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-flex items-center overflow-hidden rounded-full border border-[var(--hairline-strong)]" aria-label="Apps that may run at once">
      <button disabled={busy || quota <= 0} onClick={() => set(quota - 1)}
        className="px-2.5 py-1 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-3)] disabled:opacity-40">−</button>
      <span className="tabular min-w-8 text-center text-sm font-semibold">{quota}</span>
      <button disabled={busy || quota >= 50} onClick={() => set(quota + 1)}
        className="px-2.5 py-1 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-3)] disabled:opacity-40">+</button>
    </div>
  );
}

export function StudentActions({ user, self, onChanged }: { user: User; self: boolean; onChanged: () => void }) {
  const [dialog, setDialog] = useState<null | "block" | "disable" | "admin">(null);
  const [busy, setBusy] = useState(false);

  async function change(changes: UserChanges, message: string) {
    setBusy(true);
    try {
      await updateUser(user.id, changes);
      toast(message);
      setDialog(null);
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not change the account.", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {user.can_deploy === false ? (
        <Button size="sm" onClick={() => change({ can_deploy: true }, "Deploy rights restored.")} loading={busy} disabled={self}>
          <CheckIcon className="h-3 w-3" />Allow deploys
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setDialog("block")} disabled={self || busy}>
          <BanIcon className="h-3.5 w-3.5" />Block deploys
        </Button>
      )}
      {user.is_active ? (
        <Button size="sm" variant="ghost" onClick={() => setDialog("disable")} disabled={self || busy}>Disable</Button>
      ) : (
        <Button size="sm" onClick={() => change({ is_active: true }, "Account enabled.")} loading={busy}>Enable</Button>
      )}

      <ConfirmDialog open={dialog === "block"} title={`Block deploys for ${user.email}?`} confirmLabel="Block deploys" danger
        reasonLabel="Reason, shown to the student" busy={busy} onCancel={() => setDialog(null)}
        onConfirm={(reason) => change({ can_deploy: false, deploy_block_reason: reason || null }, "Deploys blocked.")}>
        They can still sign in and see their apps, and running apps keep running. They cannot build, start or roll back anything.
      </ConfirmDialog>
      <ConfirmDialog open={dialog === "disable"} title={`Disable ${user.email}?`} confirmLabel="Disable account" danger
        busy={busy} onCancel={() => setDialog(null)}
        onConfirm={() => change({ is_active: false }, "Account disabled.")}>
        They will not be able to sign in. Their apps are not stopped — suspend those separately if you need to.
      </ConfirmDialog>
    </div>
  );
}

export function MakeAdmin({ user, onChanged }: { user: User; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (user.role === "admin") return null;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}><ShieldIcon className="h-3.5 w-3.5" />Make administrator</Button>
      <ConfirmDialog open={open} title={`Make ${user.email} an administrator?`} confirmLabel="Make administrator" danger
        typeToConfirm={user.email} busy={busy} onCancel={() => setOpen(false)}
        onConfirm={async () => {
          setBusy(true);
          try {
            await updateUser(user.id, { role: "admin" });
            toast(`${user.email} is now an administrator.`);
            setOpen(false);
            onChanged();
          } catch (err) {
            toast(err instanceof Error ? err.message : "Could not change the role.", "danger");
          } finally {
            setBusy(false);
          }
        }}>
        Administrators control every app and account on the platform, and do not deploy apps of their own.
      </ConfirmDialog>
    </>
  );
}
