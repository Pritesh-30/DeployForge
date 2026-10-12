/**
 * How numbers read in this product.
 *
 * One place for units, so "512 MB" on a card and "0.5 GB" on a chart never
 * describe the same thing two ways.
 */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function bytes(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  let n = Math.abs(value);
  let unit = 0;
  while (n >= 1024 && unit < BYTE_UNITS.length - 1) {
    n /= 1024;
    unit += 1;
  }
  const shown = unit === 0 ? Math.round(n).toString() : n.toFixed(n >= 100 ? 0 : digits);
  return `${value < 0 ? "-" : ""}${shown} ${BYTE_UNITS[unit]}`;
}

export function rate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond == null) return "—";
  return `${bytes(bytesPerSecond)}/s`;
}

export function percent(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(value >= 100 ? 0 : digits)}%`;
}

/** A 0..1 fraction as a percentage. */
export function share(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function ms(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value < 1) return "<1 ms";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

export function seconds(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const s = Math.round(value);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** 1,284 / 12.9K / 4.2M */
export function compact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function clock(ts: number | string): string {
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function dateTime(ts: number | string | null | undefined): string {
  if (ts == null) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "—";
}

/** Who did something, as a person would say it. */
export function actorName(actor: string | null | undefined): string | null {
  if (!actor || actor === "owner") return null;
  if (actor === "admin") return "an administrator";
  if (actor === "platform") return "the platform, automatically";
  if (actor === "github") return "a push to GitHub";
  return actor;
}
