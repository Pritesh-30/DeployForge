"use client";

import Link from "next/link";

import AppsTable, { NoApps } from "@/components/app/AppsTable";
import { PlusIcon } from "@/components/Icons";
import { Button, Eyebrow } from "@/components/ui";
import { appsPulse, listApps } from "@/lib/apps";

/** Every app this student has connected, with what each is doing right now. */
export default function AppsPage() {
  const newApp = (
    <Link href="/dashboard/new">
      <Button variant="primary"><PlusIcon className="h-4 w-4" />New app</Button>
    </Link>
  );
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>Workspace</Eyebrow>
          <h1 className="mt-3 text-[2rem] font-semibold leading-tight">Apps</h1>
          <p className="mt-1.5 text-sm text-[var(--text-muted)]">Everything you have deployed, live usage included.</p>
        </div>
        {newApp}
      </div>
      <AppsTable load={listApps} loadPulse={appsPulse} empty={<NoApps action={newApp} />} />
    </div>
  );
}
