/**
 * Form controls drawn in the console's own visual language.
 *
 * The browser's native `<select>` opens an OS menu — white, system font,
 * blue highlight — that no amount of CSS reaches, so in a dark interface it
 * looks like a different application opened. These replace it and the native
 * checkbox while keeping what made them usable: full keyboard control
 * (arrows, Home/End, Enter, Escape, type-to-jump), focus that returns to the
 * trigger, and the listbox/checkbox roles screen readers expect.
 */

"use client";

import { ReactNode, useEffect, useId, useRef, useState } from "react";

import { CheckIcon, ChevronDown } from "@/components/Icons";
import { cx } from "@/components/ui";

export type SelectOption<T extends string> = {
  value: T;
  label: ReactNode;
  /** Plain text for type-to-jump and the trigger's tooltip. */
  text?: string;
  hint?: ReactNode;
};

export function Select<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  variant = "field",
  icon,
  disabled = false,
  className,
  menuClassName,
  align = "left",
}: {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  ariaLabel: string;
  /** "field" sits in a form; "pill" sits in a toolbar. */
  variant?: "field" | "pill" | "ghost";
  icon?: ReactNode;
  disabled?: boolean;
  className?: string;
  menuClassName?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [above, setAbove] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const id = useId();

  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const selected = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function show() {
    if (disabled) return;
    // Open upward when there is no room below, so the menu is never cut off
    // by the bottom of the window.
    const rect = trigger.current?.getBoundingClientRect();
    setAbove(!!rect && window.innerHeight - rect.bottom < Math.min(320, options.length * 40 + 16) && rect.top > 240);
    setActive(selectedIndex);
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    setOpen(false);
    trigger.current?.focus();
    if (option.value !== value) onChange(option.value);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    const last = options.length - 1;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(last, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(last);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Tab") {
      setOpen(false);
    } else if (e.key.length === 1) {
      // Type to jump: letters typed within a second build one search.
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 1000 ? typed.current.text : "") + e.key.toLowerCase(), at: now };
      const hit = options.findIndex((o) => (o.text ?? String(o.label)).toLowerCase().startsWith(typed.current.text));
      if (hit >= 0) setActive(hit);
    }
  }

  return (
    <div ref={root} className={cx("relative inline-flex", className)}>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        disabled={disabled}
        title={selected?.text}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        className={cx(
          "inline-flex w-full min-w-0 items-center gap-2 text-left transition-[border-color,background-color,color] duration-[var(--t-hover)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-line)] disabled:cursor-not-allowed disabled:opacity-50",
          variant === "field" && "rounded-[var(--r-sm)] border border-[var(--hairline-strong)] bg-[var(--surface-2)] px-3.5 py-2.5 text-sm shadow-[var(--bevel)] hover:bg-[var(--surface-3)]",
          variant === "pill" && "rounded-full border border-[var(--hairline)] bg-[var(--surface)] px-3 py-1.5 text-xs hover:border-[var(--hairline-strong)]",
          variant === "ghost" && "rounded-[var(--r-sm)] px-2 py-1 text-sm hover:bg-[var(--surface-2)]",
          open && variant !== "ghost" && "border-[var(--accent-line)]",
        )}
      >
        {icon && <span className="shrink-0 text-[var(--text-dim)]">{icon}</span>}
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? "—"}</span>
        <ChevronDown className={cx("h-3.5 w-3.5 shrink-0 text-[var(--text-dim)] transition-transform duration-[var(--t-hover)]", open && "rotate-180")} />
      </button>

      {open && (
        <ul
          ref={list}
          id={`${id}-list`}
          role="listbox"
          aria-label={ariaLabel}
          className={cx(
            "rise thin-scroll absolute z-40 max-h-80 min-w-full overflow-y-auto rounded-[var(--r)] border border-[var(--hairline-strong)] bg-[var(--surface)] p-1 shadow-[var(--shadow-lg)]",
            above ? "bottom-full mb-1.5" : "top-full mt-1.5",
            align === "right" ? "right-0" : "left-0",
            menuClassName,
          )}
        >
          {options.map((option, i) => {
            const isSelected = option.value === value;
            return (
              <li
                key={option.value}
                id={`${id}-${i}`}
                data-index={i}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
                className={cx(
                  "flex cursor-pointer items-start gap-2.5 rounded-[var(--r-sm)] px-3 py-2 text-sm",
                  i === active ? "bg-[var(--surface-3)] text-[var(--text)]" : "text-[var(--text-muted)]",
                )}
              >
                <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--accent)]">
                  {isSelected && <CheckIcon className="h-3.5 w-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cx("block truncate", isSelected && "font-medium text-[var(--text)]")}>{option.label}</span>
                  {option.hint && <span className="mt-0.5 block text-xs text-[var(--text-dim)]">{option.hint}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  children,
  disabled = false,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "group inline-flex items-center gap-2 rounded-[var(--r-sm)] text-left text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-line)] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <span className={cx(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-[var(--t-hover)]",
        checked
          ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg-deep)]"
          : "border-[var(--hairline-strong)] bg-[var(--surface-2)] group-hover:border-[var(--text-dim)]",
      )}>
        {checked && <CheckIcon className="h-3 w-3" />}
      </span>
      {children}
    </button>
  );
}
