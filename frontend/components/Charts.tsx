/**
 * Charts, hand-built in SVG.
 *
 * The rules they follow (and why) are the data-visualisation spec this
 * product uses: thin marks — 2px lines, 10% area washes, bars no thicker than
 * 24px with a 4px rounded end — hairline grids that stay out of the way, one
 * y-axis only, a legend whenever there are two series, text in text colours
 * rather than series colours, and a hover readout that lists every series at
 * the pointer rather than making anyone aim at a line.
 *
 * Series colours come from --series-1..5, a palette validated for colour
 * vision deficiency against this product's surface. Status colours (ok,
 * danger) are used only where the data *is* a status — builds that
 * succeeded or failed — and always with a label beside them.
 */

"use client";

import { ReactNode, useEffect, useId, useRef, useState } from "react";

import { cx } from "@/components/ui";

export type Point = [number, number];

export const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)"];

/* --- Sizing ------------------------------------------------------------- */

/** The element's size, kept current as the layout changes. */
function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, number, number] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) }),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, size.width, size.height];
}

/** Charts without a fixed height fill their container, never below this. */
const MIN_FILL_HEIGHT = 120;

/* --- Scales ------------------------------------------------------------- */

/** Round tick values: 0, 25, 50, 75, 100 rather than 0, 23.7, 47.4 ... */
export function niceTicks(max: number, count = 4, integer = false): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  // Counts are whole: half a build is not a tick anyone needs.
  if (integer) step = Math.max(1, Math.ceil(step));
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Number(v.toPrecision(12)));
  if (ticks[ticks.length - 1] < max) ticks.push(Number((ticks[ticks.length - 1] + step).toPrecision(12)));
  return ticks;
}

/**
 * Split a series where samples stop. If an app was down for ten minutes, a
 * line drawn straight across the gap would claim values nobody measured.
 */
function segments(points: Point[], gapMs: number): Point[][] {
  const out: Point[][] = [];
  let current: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && points[i][0] - points[i - 1][0] > gapMs) {
      if (current.length) out.push(current);
      current = [];
    }
    current.push(points[i]);
  }
  if (current.length) out.push(current);
  return out;
}

function medianStep(points: Point[]): number {
  if (points.length < 2) return 60_000;
  const steps = points.slice(1).map((p, i) => p[0] - points[i][0]).sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)] || 60_000;
}

/* --- Time series -------------------------------------------------------- */

export type Series = { key: string; label: string; points: Point[]; color?: string };

export function TimeSeries({
  series,
  format,
  height: fixedHeight,
  domain,
  yMax,
  integer = false,
  area = true,
  empty = "No samples in this window yet.",
}: {
  series: Series[];
  /**
   * Formats a value for the axis and the readout. On the axis it is given the
   * number of decimals the tick spacing needs, so ticks 0.25 apart do not all
   * read "0%"; in the readout it is not, and picks its own.
   */
  format: (value: number, decimals?: number) => string;
  /** Fixed height in px. Omit to fill the container's height. */
  height?: number;
  /** The time window shown, [start, end] in ms — so an hour reads as an hour. */
  domain?: [number, number];
  /** Fix the top of the scale, e.g. 100 for a percentage of a limit. */
  yMax?: number;
  /** Whole-number ticks, for counts. */
  integer?: boolean;
  area?: boolean;
  empty?: ReactNode;
}) {
  const [ref, width, measured] = useSize<HTMLDivElement>();
  const height = fixedHeight ?? Math.max(MIN_FILL_HEIGHT, measured);
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const colored = series.map((s, i) => ({ ...s, color: s.color ?? SERIES[i] }));
  const all = colored.flatMap((s) => s.points);
  const hasData = all.length > 0;

  const pad = { top: 12, right: 12, bottom: 24, left: 52 };
  const innerW = Math.max(0, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;

  // The window shown: the one asked for, else the data's own extent. An
  // empty chart has no time axis to draw, so its extent does not matter.
  const xs = all.map((p) => p[0]);
  const [x0, x1]: [number, number] = domain ?? (hasData ? [Math.min(...xs), Math.max(...xs)] : [0, 1]);

  const peak = Math.max(yMax ?? 0, ...all.map((p) => p[1]), 0);
  const ticks = niceTicks(peak || 1, 4, integer);
  const top = ticks[ticks.length - 1];
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
  const decimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step) - 1e-9));

  const sx = (t: number) => pad.left + (x1 === x0 ? innerW : ((t - x0) / (x1 - x0)) * innerW);
  const sy = (v: number) => pad.top + innerH - (v / top) * innerH;

  // The readout snaps to the nearest sampled time of the first series that
  // has data; every series is then read at its own nearest point.
  const anchor = colored.find((s) => s.points.length)?.points ?? [];

  function nearest(points: Point[], t: number): Point | null {
    if (!points.length) return null;
    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid][0] < t) lo = mid;
      else hi = mid;
    }
    return Math.abs(points[lo][0] - t) <= Math.abs(points[hi][0] - t) ? points[lo] : points[hi];
  }

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!anchor.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = x0 + ((e.clientX - rect.left - pad.left) / innerW) * (x1 - x0);
    const p = nearest(anchor, t);
    setHover(p ? anchor.indexOf(p) : null);
  }

  function onKey(e: React.KeyboardEvent) {
    if (!anchor.length) return;
    if (e.key === "ArrowRight") setHover((h) => Math.min(anchor.length - 1, (h ?? -1) + 1));
    else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? anchor.length) - 1));
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  }

  const tickCount = width < 420 ? 3 : 5;
  const xTicks = hasData || domain
    ? Array.from({ length: tickCount }, (_, i) => x0 + ((x1 - x0) * i) / (tickCount - 1))
    : [];

  const spanHours = (x1 - x0) / 3_600_000;
  const timeLabel = (t: number) =>
    new Date(t).toLocaleTimeString([], spanHours > 20 ? { hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });

  const hoverT = hover != null ? anchor[hover]?.[0] : null;
  const readout =
    hoverT != null
      ? colored.map((s) => ({ ...s, value: nearest(s.points, hoverT)?.[1] ?? null }))
      : null;

  return (
    <div ref={ref} className={cx("relative w-full", fixedHeight == null && "h-full")}
      style={fixedHeight != null ? { height: fixedHeight } : { minHeight: MIN_FILL_HEIGHT }}>
      {colored.length > 1 && (
        <div className="absolute right-0 top-[-1.75rem] flex gap-3 text-[11px] text-[var(--text-muted)]">
          {colored.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="h-[2px] w-3 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}

      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={colored.map((s) => s.label).join(", ")}
          tabIndex={hasData ? 0 : -1}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          className="block outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-line)] rounded-[var(--r-xs)]"
        >
          <defs>
            {colored.map((s, i) => (
              <linearGradient key={s.key} id={`${gradientId}-${i}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.16} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>

          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={sy(t)} y2={sy(t)}
                stroke={t === 0 ? "var(--chart-axis)" : "var(--chart-grid)"} strokeWidth={1} />
              <text x={pad.left - 8} y={sy(t)} dy="0.32em" textAnchor="end"
                className="tabular" fontSize={10.5} fill="var(--chart-ink)">
                {format(t, decimals)}
              </text>
            </g>
          ))}

          {xTicks.map((t, i) => (
            <text key={i} x={sx(t)} y={height - 6}
              textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
              className="tabular" fontSize={10.5} fill="var(--chart-ink)">
              {timeLabel(t)}
            </text>
          ))}

          {colored.map((s, i) => {
            const parts = segments(s.points, medianStep(s.points) * 3.5);
            return (
              <g key={s.key}>
                {parts.map((part, j) => {
                  if (part.length === 1) {
                    return <circle key={j} cx={sx(part[0][0])} cy={sy(part[0][1])} r={2} fill={s.color} />;
                  }
                  const line = part.map((p, k) => `${k ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join("");
                  const fill = `${line}L${sx(part[part.length - 1][0]).toFixed(1)},${sy(0)}L${sx(part[0][0]).toFixed(1)},${sy(0)}Z`;
                  return (
                    <g key={j}>
                      {area && i === 0 && <path d={fill} fill={`url(#${gradientId}-${i})`} />}
                      <path d={line} fill="none" stroke={s.color} strokeWidth={2}
                        strokeLinejoin="round" strokeLinecap="round" />
                    </g>
                  );
                })}
              </g>
            );
          })}

          {hoverT != null && (
            <g pointerEvents="none">
              <line x1={sx(hoverT)} x2={sx(hoverT)} y1={pad.top} y2={pad.top + innerH}
                stroke="var(--chart-axis)" strokeWidth={1} />
              {readout?.map((r) =>
                r.value == null ? null : (
                  <circle key={r.key} cx={sx(hoverT)} cy={sy(r.value)} r={4}
                    fill={r.color} stroke="var(--surface)" strokeWidth={2} />
                ),
              )}
            </g>
          )}

          {!hasData && (
            <text x={width / 2} y={pad.top + innerH / 2} textAnchor="middle" fontSize={12} fill="var(--text-dim)">
              {typeof empty === "string" ? empty : ""}
            </text>
          )}
        </svg>
      )}

      {hoverT != null && readout && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-[8.5rem] rounded-[var(--r-xs)] border border-[var(--hairline-strong)] bg-[var(--surface-3)] px-3 py-2 shadow-[var(--shadow)]"
          style={{
            left: Math.min(Math.max(sx(hoverT) + 12, 0), Math.max(0, width - 150)),
          }}
        >
          <p className="tabular text-[10.5px] text-[var(--text-dim)]">
            {new Date(hoverT).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </p>
          {readout.map((r) => (
            <div key={r.key} className="mt-1 flex items-center justify-between gap-4">
              <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                <span className="h-[2px] w-2.5 rounded-full" style={{ background: r.color }} />
                {r.label}
              </span>
              <span className="tabular text-[12px] font-semibold text-[var(--text)]">
                {r.value == null ? "—" : format(r.value)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* --- Sparkline ---------------------------------------------------------- */

/**
 * A trend at a glance: the line in a quiet tone, the latest value marked in
 * the accent — the shape is context, the end is the news.
 */
export function Sparkline({
  points,
  width = 96,
  height = 28,
  max,
  label,
}: {
  points: Point[] | number[];
  width?: number;
  height?: number;
  max?: number;
  label?: string;
}) {
  const data: Point[] = (points as (Point | number)[]).map((p, i) =>
    Array.isArray(p) ? (p as Point) : ([i, p] as Point),
  );
  if (data.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden>
        <line x1={0} x2={width} y1={height - 2} y2={height - 2} stroke="var(--chart-grid)" />
      </svg>
    );
  }
  const xs = data.map((p) => p[0]);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const top = Math.max(max ?? 0, ...data.map((p) => p[1])) || 1;
  const px = (t: number) => 2 + ((t - lo) / (hi - lo || 1)) * (width - 6);
  const py = (v: number) => height - 3 - (v / top) * (height - 6);
  const d = data.map((p, i) => `${i ? "L" : "M"}${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join("");
  const last = data[data.length - 1];
  return (
    <svg width={width} height={height} role="img" aria-label={label ?? "trend"}>
      <path d={d} fill="none" stroke="var(--text-dim)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={px(last[0])} cy={py(last[1])} r={2.5} fill="var(--accent)" />
    </svg>
  );
}

/* --- Stacked daily bars ------------------------------------------------- */

export type Stack = { label: string; values: number[] };

/**
 * Columns per day, each split into parts — e.g. builds that succeeded and
 * builds that failed. Parts are separated by a 2px surface gap, not a
 * stroke; the top part has the rounded end.
 */
export function StackedBars({
  days,
  parts,
  height: fixedHeight,
}: {
  days: string[];
  parts: { key: string; label: string; color: string; values: number[] }[];
  /** Fixed height in px. Omit to fill the container's height. */
  height?: number;
}) {
  const [ref, width, measured] = useSize<HTMLDivElement>();
  const height = fixedHeight ?? Math.max(MIN_FILL_HEIGHT, measured);
  const [hover, setHover] = useState<number | null>(null);
  const totals = days.map((_, i) => parts.reduce((sum, p) => sum + (p.values[i] ?? 0), 0));
  const ticks = niceTicks(Math.max(1, ...totals), 3, true);
  const top = ticks[ticks.length - 1];

  const pad = { top: 8, right: 4, bottom: 22, left: 28 };
  const innerW = Math.max(0, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const slot = days.length ? innerW / days.length : 0;
  const barW = Math.min(24, Math.max(4, slot * 0.6));
  const sy = (v: number) => pad.top + innerH - (v / top) * innerH;

  return (
    <div ref={ref} className={cx("relative w-full", fixedHeight == null && "h-full")}
      style={fixedHeight != null ? { height: fixedHeight } : { minHeight: MIN_FILL_HEIGHT }}>
      <div className="absolute right-0 top-[-1.75rem] flex gap-3 text-[11px] text-[var(--text-muted)]">
        {parts.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[2px]" style={{ background: p.color }} />
            {p.label}
          </span>
        ))}
      </div>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={parts.map((p) => p.label).join(" and ") + " per day"}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={sy(t)} y2={sy(t)}
                stroke={t === 0 ? "var(--chart-axis)" : "var(--chart-grid)"} />
              <text x={pad.left - 6} y={sy(t)} dy="0.32em" textAnchor="end" fontSize={10.5}
                className="tabular" fill="var(--chart-ink)">{t}</text>
            </g>
          ))}
          {days.map((day, i) => {
            const cx = pad.left + slot * i + slot / 2;
            let base = 0;
            const drawn = parts
              .map((p) => ({ ...p, v: p.values[i] ?? 0 }))
              .filter((p) => p.v > 0);
            return (
              <g key={day}
                tabIndex={0}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="outline-none"
              >
                {/* The hit area is the whole slot, not just the painted bar. */}
                <rect x={pad.left + slot * i} y={pad.top} width={slot} height={innerH} fill="transparent" />
                {drawn.map((p, j) => {
                  const y0 = sy(base);
                  const y1 = sy(base + p.v);
                  base += p.v;
                  const isTop = j === drawn.length - 1;
                  const h = Math.max(1, y0 - y1 - (j > 0 ? 2 : 0));
                  const y = y1;
                  const r = isTop ? Math.min(4, h / 2, barW / 2) : 0;
                  const x = cx - barW / 2;
                  const path = r
                    ? `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + barW - r}Q${x + barW},${y} ${x + barW},${y + r}V${y + h}Z`
                    : `M${x},${y}H${x + barW}V${y + h}H${x}Z`;
                  return (
                    <path key={p.key} d={path} fill={p.color}
                      opacity={hover == null || hover === i ? 1 : 0.55}
                      style={{ transition: "opacity 160ms" }} />
                  );
                })}
                {(i === 0 || i === days.length - 1 || (days.length > 7 && i === Math.floor(days.length / 2))) && (
                  <text x={cx} y={height - 6} textAnchor="middle" fontSize={10.5} fill="var(--chart-ink)">
                    {new Date(day + "T00:00:00").toLocaleDateString([], { month: "short", day: "numeric" })}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {hover != null && width > 0 && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-[var(--r-xs)] border border-[var(--hairline-strong)] bg-[var(--surface-3)] px-3 py-2 shadow-[var(--shadow)]"
          style={{ left: Math.min(pad.left + slot * hover + slot, Math.max(0, width - 140)) }}
        >
          <p className="text-[10.5px] text-[var(--text-dim)]">
            {new Date(days[hover] + "T00:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
          </p>
          {parts.map((p) => (
            <div key={p.key} className="mt-1 flex items-center justify-between gap-5">
              <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                <span className="h-2 w-2 rounded-[2px]" style={{ background: p.color }} />
                {p.label}
              </span>
              <span className="tabular text-[12px] font-semibold">{p.values[hover] ?? 0}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* --- Meter -------------------------------------------------------------- */

/**
 * How full something is. The fill carries severity — calm, then warning,
 * then danger — and the track is the same hue, fainter, so the state reads
 * across the whole bar.
 */
export function Meter({
  value,
  max,
  warnAt = 0.75,
  dangerAt = 0.9,
  invert = false,
  className,
}: {
  value: number;
  max: number;
  warnAt?: number;
  dangerAt?: number;
  /** Higher is better (a success rate): low values are the warning. */
  invert?: boolean;
  className?: string;
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const level = invert ? 1 - ratio : ratio;
  const tone = level >= dangerAt ? "var(--danger)" : level >= warnAt ? "var(--warn)" : invert ? "var(--ok)" : "var(--accent)";
  return (
    <div className={cx("h-1.5 w-full overflow-hidden rounded-full", className)}
      style={{ background: `color-mix(in oklch, ${tone} 16%, transparent)` }}
      role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <div className="h-full rounded-full transition-[width] duration-[var(--t-move)] ease-[var(--ease-out)]"
        style={{ width: `${ratio * 100}%`, background: tone }} />
    </div>
  );
}

/* --- Proportion bar (GitHub's language bar) ----------------------------- */

export function ProportionBar({
  items,
  maxSlots = 5,
}: {
  items: { label: string; value: number }[];
  maxSlots?: number;
}) {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const shown = sorted.slice(0, maxSlots);
  const rest = sorted.slice(maxSlots).reduce((s, i) => s + i.value, 0);
  const parts = [
    ...shown.map((it, i) => ({ ...it, color: SERIES[i] })),
    ...(rest > 0 ? [{ label: "Other", value: rest, color: "var(--text-dim)" }] : []),
  ];
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  return (
    <div>
      <div className="flex h-2 w-full gap-[2px] overflow-hidden rounded-full">
        {parts.map((p) => (
          <div key={p.label} title={`${p.label} ${((p.value / total) * 100).toFixed(1)}%`}
            style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
        {parts.map((p) => (
          <li key={p.label} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
            <span className="font-medium text-[var(--text)]">{p.label}</span>
            <span className="tabular text-[var(--text-dim)]">{((p.value / total) * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --- Ranked bars -------------------------------------------------------- */

export function RankedBars({
  rows,
  format = (v) => String(v),
}: {
  rows: { label: ReactNode; value: number; hint?: ReactNode }[];
  format?: (v: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-3">
      {rows.map((r, i) => (
        <li key={i}>
          <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{r.label}</span>
            <span className="tabular shrink-0 text-xs text-[var(--text-muted)]">
              {format(r.value)} {r.hint}
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-[var(--surface-3)]">
            <div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: "var(--series-1)" }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/* --- Stat tile ---------------------------------------------------------- */

export function StatTile({
  label,
  value,
  hint,
  trend,
  icon,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  trend?: Point[] | number[];
  icon?: ReactNode;
  tone?: "ok" | "warn" | "danger";
}) {
  return (
    <div className="plate flex flex-col justify-between gap-3 px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">{label}</p>
        {icon && <span className="text-[var(--text-dim)]">{icon}</span>}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className={cx(
            "text-[28px] font-semibold leading-none",
            tone === "ok" && "text-[var(--ok)]",
            tone === "warn" && "text-[var(--warn)]",
            tone === "danger" && "text-[var(--danger)]",
          )}>
            {value}
          </p>
          {hint && <p className="mt-2 truncate text-xs text-[var(--text-dim)]">{hint}</p>}
        </div>
        {trend && trend.length > 1 && <Sparkline points={trend} />}
      </div>
    </div>
  );
}

/* --- Chart card --------------------------------------------------------- */

/**
 * A chart in a panel, with the same header geometry as `Panel` — so a chart
 * and a list sitting side by side line up exactly — plus the headline number
 * the chart is about. The chart fills whatever height the row gives it.
 */
export function ChartPanel({
  title,
  value,
  caption,
  children,
  footer,
  className,
}: {
  title: string;
  value?: ReactNode;
  caption?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("plate flex min-h-0 flex-col overflow-hidden", className)}>
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--hairline)] px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold">{title}</h2>
          {value != null && <p className="tabular mt-1 text-[22px] font-semibold leading-none">{value}</p>}
        </div>
        {caption && <div className="shrink-0 text-right text-xs leading-relaxed text-[var(--text-dim)]">{caption}</div>}
      </header>
      {/* The chart takes all the height the row gives the panel. */}
      <div className="min-h-0 flex-1 px-5 pb-4 pt-9">{children}</div>
      {footer && (
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--hairline)] px-5 py-2.5 text-xs text-[var(--text-dim)]">
          {footer}
        </footer>
      )}
    </section>
  );
}
