/**
 * The signed-in session, resolved once for the whole console.
 *
 * Every console page used to wrap itself in its own auth check, so each click
 * in the sidebar unmounted the shell, asked the server who was logged in
 * again, and flashed a skeleton. Now the console's layout resolves the user
 * once, keeps the shell mounted across navigation, and pages read the user
 * from context.
 *
 * Which half of the console someone may be in is decided here, by path:
 * administrators run the platform under /admin and do not deploy, students
 * deploy everywhere else. Typing the other half's URL redirects rather than
 * rendering a page that would only fail.
 *
 * This is convenience, not security — the API enforces every rule itself.
 */

"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";

import AppShell from "@/components/AppShell";
import { Toaster } from "@/components/Feedback";
import { Skeleton } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { getCurrentUser, homeFor, type User } from "@/lib/auth";

export type Meta = {
  version: string;
  build_backend: "local" | "actions" | string;
  app_domain: string;
  https: boolean;
  ai_diagnosis: boolean;
  metrics: boolean;
  metrics_interval_seconds: number;
  build_concurrency: number;
  rate_limit_deploys_per_hour: number;
  rate_limit_deploy_burst: number;
  app_memory_limit: string;
  app_cpu_limit: string;
  app_pids_limit: number;
  metrics_retention_hours: number;
};

type SessionValue = {
  user: User;
  meta: Meta | null;
  refresh: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside the console layout");
  return value;
}

export function ConsoleSession({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);

  const refresh = useCallback(async () => {
    const u = await getCurrentUser();
    if (!u) {
      router.replace("/login");
      return;
    }
    setUser(u);
  }, [router]);

  useEffect(() => {
    let active = true;
    getCurrentUser().then((u) => {
      if (!active) return;
      if (!u) router.replace("/login");
      else setUser(u);
    });
    apiFetch<Meta>("/meta").then((m) => active && setMeta(m)).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [router]);

  const isAdminPath = pathname.startsWith("/admin");
  const misplaced = !!user && (user.role === "admin") !== isAdminPath;

  useEffect(() => {
    if (user && misplaced) router.replace(homeFor(user));
  }, [user, misplaced, router]);

  if (!user || misplaced) {
    return (
      <div className="flex min-h-screen bg-[var(--bg-deep)]">
        <div className="hidden w-[17rem] shrink-0 p-3 lg:block">
          <div className="plate h-full rounded-[var(--r-lg)]" />
        </div>
        <div className="flex-1 px-8 py-10">
          <div className="mx-auto w-full max-w-6xl space-y-6">
            <Skeleton className="h-9 w-56" />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}
            </div>
            <Skeleton className="h-64" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <SessionContext.Provider value={{ user, meta, refresh }}>
      <AppShell user={user} meta={meta}>{children}</AppShell>
      <Toaster />
    </SessionContext.Provider>
  );
}
