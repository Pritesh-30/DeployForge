/**
 * ⌘K — go anywhere by typing.
 *
 * Every page, every app, and the actions worth a shortcut, ranked by fuzzy
 * match. A platform with twenty pages and a student's twelve apps is faster to
 * type through than to click through, and this is where power users live.
 */

"use client";

import { useRouter } from "next/navigation";
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ArrowRight, BoxIcon, SearchIcon } from "@/components/Icons";
import { cx } from "@/components/ui";
import { adminApps } from "@/lib/admin";
import { listApps, type App } from "@/lib/apps";
import { fuzzyFilter } from "@/lib/fuzzy";

export type PaletteItem = {
  id: string;
  label: string;
  hint?: string;
  href: string;
  icon?: ReactNode;
  group: string;
};

function Highlight({ text, positions }: { text: string; positions: number[] }) {
  const set = new Set(positions);
  return (
    <>
      {[...text].map((ch, i) =>
        set.has(i) ? (
          <span key={i} className="text-[var(--accent)]">{ch}</span>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}

export default function CommandPalette({
  pages,
  admin,
}: {
  pages: PaletteItem[];
  admin: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [apps, setApps] = useState<App[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command-palette", onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    // Apps are fetched when the palette opens, so it never shows a stale list.
    (admin ? adminApps() : listApps()).then(setApps).catch(() => undefined);
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, admin]);

  const items = useMemo<PaletteItem[]>(
    () => [
      ...pages,
      ...apps.map((a) => ({
        id: `app-${a.id}`,
        label: a.target_label,
        hint: admin ? a.owner_email ?? undefined : a.current?.status ?? "not deployed",
        href: admin ? `/admin/apps/${a.id}` : `/apps/${a.id}`,
        icon: <BoxIcon />,
        group: "Apps",
      })),
    ],
    [pages, apps, admin],
  );

  const results = useMemo(
    () => fuzzyFilter(items, query, (i) => `${i.label} ${i.hint ?? ""}`, 12),
    [items, query],
  );

  const go = useCallback(
    (item: PaletteItem) => {
      setOpen(false);
      setQuery("");
      router.push(item.href);
    },
    [router],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[oklch(0%_0_0/0.55)] px-4 pt-[12vh] backdrop-blur-[2px]"
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-label="Go to"
        className="w-full max-w-xl overflow-hidden rounded-[var(--r)] border border-[var(--hairline-strong)] bg-[var(--surface-2)] shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--hairline)] px-4">
          <SearchIcon className="h-4 w-4 text-[var(--text-dim)]" />
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(results.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter" && results[index]) {
                go(results[index].item);
              }
            }}
            placeholder="Go to a page or an app…"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--text-dim)]"
          />
          <kbd className="rounded border border-[var(--hairline-strong)] px-1.5 py-0.5 text-[10px] text-[var(--text-dim)]">esc</kbd>
        </div>
        <ul className="thin-scroll max-h-[50vh] overflow-y-auto p-1.5">
          {results.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-[var(--text-dim)]">Nothing matches.</li>
          )}
          {results.map(({ item, match }, i) => {
            const labelLen = item.label.length;
            return (
              <li key={item.id}>
                <button
                  onClick={() => go(item)}
                  onMouseEnter={() => setIndex(i)}
                  className={cx(
                    "flex w-full items-center gap-3 rounded-[var(--r-xs)] px-3 py-2.5 text-left text-sm",
                    i === index ? "bg-[var(--surface-3)]" : "",
                  )}
                >
                  <span className="text-[var(--text-dim)]">{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate">
                    <Highlight text={item.label} positions={match.positions.filter((p) => p < labelLen)} />
                  </span>
                  {item.hint && <span className="shrink-0 text-xs text-[var(--text-dim)]">{item.hint}</span>}
                  <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--text-dim)]">{item.group}</span>
                  {i === index && <ArrowRight className="h-3.5 w-3.5 text-[var(--text-dim)]" />}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
