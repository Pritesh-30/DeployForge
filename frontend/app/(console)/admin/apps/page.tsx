"use client";

import AppsTable, { NoApps } from "@/components/app/AppsTable";
import { Eyebrow } from "@/components/ui";
import { adminApps, adminAppsPulse } from "@/lib/admin";

/** Every app on the platform, whoever owns it, with the controls to run it. */
export default function AdminAppsPage() {
  return (
    <div className="space-y-8">
      <div>
        <Eyebrow>Platform</Eyebrow>
        <h1 className="mt-3 text-[2rem] font-semibold leading-tight">Apps</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[var(--text-muted)]">
          Every student&apos;s app on this machine. Start, stop or restart one from here; open it to redeploy, roll back,
          read its logs or suspend it. Everything you do is recorded in the audit log.
        </p>
      </div>
      <AppsTable load={adminApps} loadPulse={adminAppsPulse} admin empty={<NoApps />} />
    </div>
  );
}
