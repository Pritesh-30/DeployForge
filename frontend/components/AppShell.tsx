/**
 * The frame around every signed-in page.
 *
 * Navigation is built from the account's role rather than filtered in the
 * view: an administrator runs the platform and does not deploy on it, so the
 * deploy flow is not a link they see greyed out — it is not part of their
 * product at all. Two roles, two applications, one shell.
 *
 * Grouped, because a flat list of ten links reads as a list; "Workspace" and
 * "Account" read as a place.
 */

"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useMemo } from "react";

import CommandPalette, { type PaletteItem } from "@/components/CommandPalette";
import type { Meta } from "@/components/Session";
import { Badge, cx } from "@/components/ui";
import {
  BoxIcon,
  ChartIcon,
  GaugeIcon,
  GearIcon,
  HistoryIcon,
  HomeIcon,
  LogoMark,
  PlusIcon,
  PulseIcon,
  QueueIcon,
  RocketIcon,
  ScrollIcon,
  SearchIcon,
  ServerIcon,
  ShieldIcon,
  UsersIcon,
} from "@/components/Icons";
import { clearToken, type User } from "@/lib/auth";

type NavItem = { href: string; label: string; icon: ReactNode; exact?: boolean };
type NavGroup = { title: string; items: NavItem[] };

const STUDENT_NAV: NavGroup[] = [
  {
    title: "Workspace",
    items: [
      { href: "/dashboard", label: "Overview", icon: <HomeIcon />, exact: true },
      { href: "/apps", label: "Apps", icon: <BoxIcon /> },
      { href: "/deployments", label: "Deployments", icon: <HistoryIcon /> },
      { href: "/activity", label: "Activity", icon: <PulseIcon /> },
    ],
  },
  {
    title: "Account",
    items: [
      { href: "/usage", label: "Usage & limits", icon: <GaugeIcon /> },
      { href: "/settings", label: "Settings", icon: <GearIcon /> },
    ],
  },
];

const ADMIN_NAV: NavGroup[] = [
  {
    title: "Platform",
    items: [
      { href: "/admin", label: "Overview", icon: <ChartIcon />, exact: true },
      { href: "/admin/apps", label: "Apps", icon: <BoxIcon /> },
      { href: "/admin/students", label: "Students", icon: <UsersIcon /> },
      { href: "/admin/queue", label: "Build queue", icon: <QueueIcon /> },
    ],
  },
  {
    title: "Operations",
    items: [
      { href: "/admin/infrastructure", label: "Infrastructure", icon: <ServerIcon /> },
      { href: "/admin/audit", label: "Audit log", icon: <ScrollIcon /> },
    ],
  },
];

export default function AppShell({
  user,
  meta,
  children,
}: {
  user: User;
  meta: Meta | null;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const isAdmin = user.role === "admin";
  const groups = isAdmin ? ADMIN_NAV : STUDENT_NAV;
  const flat = groups.flatMap((g) => g.items);

  // `groups` is one of two module constants, so this is computed once per role.
  const palettePages = useMemo<PaletteItem[]>(
    () => [
      ...groups.flatMap((g) => g.items).map((i) => ({
        id: i.href, label: i.label, href: i.href, icon: i.icon, group: "Pages",
      })),
      ...(isAdmin
        ? []
        : [{ id: "new", label: "Deploy a new app", href: "/dashboard/new", icon: <RocketIcon />, group: "Actions" }]),
    ],
    [groups, isAdmin],
  );

  function logOut() {
    clearToken();
    router.push("/login");
  }

  function isActive(item: NavItem) {
    if (item.exact) return pathname === item.href;
    return pathname === item.href || pathname.startsWith(item.href + "/");
  }

  function openPalette() {
    window.dispatchEvent(new Event("open-command-palette"));
  }

  return (
    <div className="flex min-h-screen bg-[var(--bg-deep)]">
      <CommandPalette pages={palettePages} admin={isAdmin} />

      {/* --- Sidebar ---------------------------------------------------- */}
      <aside className="sticky top-0 hidden h-screen w-[16.5rem] shrink-0 flex-col p-3 lg:flex">
        <div className="plate flex h-full flex-col rounded-[var(--r-lg)]">
          <Link href={isAdmin ? "/admin" : "/dashboard"}
            className="flex h-[4.25rem] items-center gap-3 border-b border-[var(--hairline)] px-5">
            <LogoMark className="h-9 w-9" />
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold leading-tight">DeployForge</p>
              <p className="text-[11px] leading-tight text-[var(--text-dim)]">
                {isAdmin ? "Platform administration" : "Deployment platform"}
              </p>
            </div>
          </Link>

          <div className="space-y-2 px-3 pt-3">
            {!isAdmin && (
              <Link href="/dashboard/new"
                className="flex items-center justify-center gap-2 rounded-full bg-[var(--solid)] px-4 py-2 text-sm font-medium text-[var(--solid-text)] shadow-[var(--shadow-sm)] transition-[filter,transform] duration-[var(--t-hover)] hover:brightness-105 active:scale-[0.98]">
                <PlusIcon className="h-4 w-4" />
                New app
              </Link>
            )}
            <button onClick={openPalette}
              className="flex w-full items-center gap-2.5 rounded-[var(--r-sm)] border border-[var(--hairline)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text-dim)] transition-colors duration-[var(--t-hover)] hover:border-[var(--hairline-strong)] hover:text-[var(--text-muted)]">
              <SearchIcon className="h-3.5 w-3.5" />
              <span className="flex-1 text-left">Search…</span>
              <kbd className="rounded border border-[var(--hairline-strong)] px-1.5 text-[10px]">Ctrl K</kbd>
            </button>
          </div>

          <nav className="thin-scroll flex-1 space-y-5 overflow-y-auto p-3 pt-5">
            {groups.map((group) => (
              <div key={group.title}>
                <p className="mb-1.5 px-3 text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--text-dim)]">
                  {group.title}
                </p>
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const active = isActive(item);
                    return (
                      <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}
                        className={cx(
                          "group relative flex items-center gap-3 rounded-[var(--r-sm)] px-3 py-2 text-sm font-medium",
                          "transition-[color,background-color] duration-[var(--t-hover)] ease-[var(--ease-out)]",
                          active
                            ? "bg-[var(--surface-2)] text-[var(--text)]"
                            : "text-[var(--text-muted)] hover:bg-[var(--surface-2)]/60 hover:text-[var(--text)]",
                        )}>
                        <span aria-hidden className={cx(
                          "absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-[var(--accent)]",
                          "transition-opacity duration-[var(--t-hover)]",
                          active ? "opacity-100" : "opacity-0",
                        )} />
                        <span className={active ? "text-[var(--accent)]" : undefined}>{item.icon}</span>
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          <div className="space-y-2 p-3">
            {meta && (
              <div className="flex items-center justify-between px-1 text-[10.5px] text-[var(--text-dim)]">
                <span className="inline-flex items-center gap-1.5">
                  <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-[var(--ok)]" />
                  {meta.build_backend === "actions" ? "Builds on GitHub Actions" : "Builds on this server"}
                </span>
                <span className="tabular">v{meta.version}</span>
              </div>
            )}
            <div className="rounded-[var(--r-sm)] border border-[var(--hairline)] bg-[var(--surface-2)] px-3.5 py-3 shadow-[var(--bevel)]">
              <p className="truncate text-sm font-medium" title={user.email}>{user.email}</p>
              <div className="mt-2 flex items-center justify-between gap-2">
                {isAdmin ? (
                  <Badge tone="accent"><ShieldIcon className="h-3 w-3" />Administrator</Badge>
                ) : (
                  <Badge>Student</Badge>
                )}
                <button onClick={logOut}
                  className="text-xs text-[var(--text-dim)] transition-colors duration-[var(--t-hover)] hover:text-[var(--danger)]">
                  Log out
                </button>
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* --- Content ---------------------------------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="glass sticky top-0 z-20 flex h-16 items-center justify-between gap-4 px-4 lg:hidden">
          <Link href={isAdmin ? "/admin" : "/dashboard"} className="flex items-center gap-2.5 font-semibold">
            <LogoMark className="h-8 w-8" />
            DeployForge
          </Link>
          <div className="flex items-center gap-3">
            <button onClick={openPalette} aria-label="Search" className="text-[var(--text-muted)]">
              <SearchIcon className="h-4 w-4" />
            </button>
            <button onClick={logOut} className="text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--danger)]">
              Log out
            </button>
          </div>
        </header>

        <nav className="sticky top-16 z-10 flex gap-1.5 overflow-x-auto border-b border-[var(--hairline)] bg-[var(--bg)] px-3 py-2.5 lg:hidden">
          {flat.map((item) => {
            const active = isActive(item);
            return (
              <Link key={item.href} href={item.href}
                className={cx(
                  "flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-medium",
                  "transition-colors duration-[var(--t-hover)]",
                  active
                    ? "border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "border-[var(--hairline)] text-[var(--text-muted)]",
                )}>
                {item.icon}
                {item.label}
              </Link>
            );
          })}
        </nav>

        <main className="flex-1 px-4 py-8 sm:px-8 lg:py-10 lg:pl-3 lg:pr-8">
          <div className="mx-auto w-full max-w-[76rem]">{children}</div>
        </main>
      </div>
    </div>
  );
}
