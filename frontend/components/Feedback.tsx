/**
 * Confirmations and toasts.
 *
 * Destructive actions ask first, in the page's own visual language rather
 * than the browser's grey `confirm()`. Deleting something whose name can be
 * typed asks for the name to be typed — the one confirmation people cannot
 * click through on autopilot.
 *
 * Toasts report the outcome of an action without moving the page: "Restarted
 * todo-app", "Build queued — 2 ahead of yours". They are dispatched as window
 * events so any component can raise one without threading a context through
 * everything between it and the layout.
 */

"use client";

import { ReactNode, useEffect, useRef, useState } from "react";

import { AlertIcon, CheckIcon } from "@/components/Icons";
import { Button, cx } from "@/components/ui";

/* --- Toasts ------------------------------------------------------------- */

type Toast = { id: number; tone: "ok" | "danger" | "info"; text: string };

export function toast(text: string, tone: Toast["tone"] = "ok") {
  window.dispatchEvent(new CustomEvent("df-toast", { detail: { text, tone } }));
}

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    let next = 1;
    function onToast(e: Event) {
      const { text, tone } = (e as CustomEvent).detail as Omit<Toast, "id">;
      const id = next++;
      setItems((list) => [...list.slice(-3), { id, text, tone }]);
      setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), tone === "danger" ? 7000 : 4200);
    }
    window.addEventListener("df-toast", onToast);
    return () => window.removeEventListener("df-toast", onToast);
  }, []);

  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[min(24rem,calc(100vw-2.5rem))] flex-col gap-2" aria-live="polite">
      {items.map((t) => (
        <div key={t.id}
          className="rise pointer-events-auto flex items-start gap-3 rounded-[var(--r-sm)] border border-[var(--hairline-strong)] bg-[var(--surface-3)] px-4 py-3 text-sm shadow-[var(--shadow-lg)]">
          <span className={cx(
            "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
            t.tone === "ok" && "bg-[var(--ok-soft)] text-[var(--ok)]",
            t.tone === "danger" && "bg-[var(--danger-soft)] text-[var(--danger)]",
            t.tone === "info" && "bg-[var(--info-soft)] text-[var(--info)]",
          )}>
            {t.tone === "danger" ? <AlertIcon className="h-3 w-3" /> : <CheckIcon className="h-3 w-3" />}
          </span>
          <p className="leading-relaxed">{t.text}</p>
        </div>
      ))}
    </div>
  );
}

/* --- Confirmation ------------------------------------------------------- */

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  typeToConfirm,
  reasonLabel,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Ask for this exact text before the button enables. */
  typeToConfirm?: string;
  /** Ask for an optional reason, passed to onConfirm. */
  reasonLabel?: string;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const first = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      setTyped("");
      setReason("");
      (first.current ?? confirmRef.current)?.focus();
    });
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onCancel]);

  if (!open) return null;
  const blocked = typeToConfirm != null && typed !== typeToConfirm;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[oklch(0%_0_0/0.6)] px-4 backdrop-blur-[2px]"
      onClick={onCancel}>
      <div role="alertdialog" aria-modal="true" aria-label={title}
        className="rise w-full max-w-md rounded-[var(--r)] border border-[var(--hairline-strong)] bg-[var(--surface-2)] p-6 shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">{title}</h2>
        {children && <div className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">{children}</div>}

        {reasonLabel && (
          <label className="mt-5 block">
            <span className="mb-1.5 block text-xs font-medium text-[var(--text-dim)]">{reasonLabel}</span>
            <input ref={first} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
              className="w-full rounded-[var(--r-sm)] border border-[var(--hairline-strong)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--accent-line)]" />
          </label>
        )}

        {typeToConfirm != null && (
          <label className="mt-5 block">
            <span className="mb-1.5 block text-xs text-[var(--text-dim)]">
              Type <code className="rounded bg-[var(--surface-3)] px-1 py-0.5 text-[var(--text)]">{typeToConfirm}</code> to confirm
            </span>
            <input ref={reasonLabel ? undefined : first} value={typed} onChange={(e) => setTyped(e.target.value)}
              autoComplete="off" spellCheck={false}
              className="w-full rounded-[var(--r-sm)] border border-[var(--hairline-strong)] bg-[var(--surface)] px-3 py-2 font-[family-name:var(--font-jetbrains-mono)] text-sm outline-none focus:border-[var(--accent-line)]" />
          </label>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button ref={confirmRef} variant={danger ? "danger" : "primary"} loading={busy} disabled={blocked}
            onClick={() => onConfirm(reason)}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
