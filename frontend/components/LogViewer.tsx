/**
 * A live log, streamed as it is written.
 *
 * Fed by Server-Sent Events. A build log reconnects from the byte offset it
 * reached, so a dropped connection loses no lines and repeats none; a
 * runtime log simply resumes following.
 *
 * Built to be read, not just shown: a filter that keeps only matching lines
 * and counts them, follow mode that pins to the newest line until the reader
 * scrolls up, wrapping on demand, and one level of colour for the lines that
 * matter — errors, warnings, steps — so a failure stands out of a thousand
 * lines of npm output.
 */

"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { DownloadIcon, SearchIcon } from "@/components/Icons";
import { cx } from "@/components/ui";
import { apiStream } from "@/lib/api";

const MAX_LINES = 8000;

type State = "connecting" | "live" | "ended" | "error";

function classify(line: string): string | undefined {
  const l = line.toLowerCase();
  if (/(^|\W)(error|err!|failed|failure|fatal|exception|traceback|cannot find|not found|denied|exited with code [1-9])/.test(l))
    return "log-line-error";
  if (/(^|\W)(warn|warning|deprecated)/.test(l)) return "log-line-warn";
  if (/(successfully|built in|build succeeded|running at|listening on|ready in|stored |✓)/.test(l)) return "log-line-ok";
  if (/^(#\d+ \[|step \d+|=+>|\$ |-----> |\[\d+\/\d+\]|={8,})/.test(l)) return "log-line-step";
  return undefined;
}

export default function LogViewer({
  streamPath,
  kind,
  height = "32rem",
  emptyText = "Waiting for output…",
  filename = "deployforge.log",
}: {
  /** The SSE endpoint, without `offset` for build logs (added on reconnect). */
  streamPath: string | null;
  kind: "build" | "runtime";
  height?: string;
  emptyText?: string;
  filename?: string;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [state, setState] = useState<State>("connecting");
  const [endStatus, setEndStatus] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const partial = useRef("");

  useEffect(() => {
    if (!streamPath) return;
    let offset = 0;
    let attempts = 0;
    let close: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let finished = false;
    partial.current = "";

    function append(text: string) {
      const combined = partial.current + text;
      const parts = combined.split(/\r?\n/);
      partial.current = parts.pop() ?? "";
      if (parts.length === 0) return;
      setLines((prev) => {
        const next = prev.concat(parts);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    }

    function connect() {
      const path =
        kind === "build"
          ? `${streamPath}${streamPath!.includes("?") ? "&" : "?"}offset=${offset}`
          : streamPath!;
      close = apiStream(
        path,
        (e) => {
          setState("live");
          attempts = 0;
          if (e.event === "log") {
            const text = String(e.data.text ?? "");
            if (typeof e.data.offset === "number") offset = e.data.offset;
            append(text);
          } else if (e.event === "end") {
            finished = true;
            if (partial.current) {
              const rest = partial.current;
              partial.current = "";
              setLines((prev) => prev.concat(rest));
            }
            setEndStatus(String(e.data.status ?? ""));
            setState("ended");
          }
        },
        () => {
          if (finished) return;
          attempts += 1;
          setState(attempts > 5 ? "error" : "connecting");
          if (attempts <= 5) timer = setTimeout(connect, Math.min(8000, 1000 * 2 ** attempts));
        },
      );
    }

    // The previous stream's lines are cleared on the next frame, not inside
    // the effect body, so switching deployments never shows two logs mixed.
    const frame = requestAnimationFrame(() => {
      setLines([]);
      setEndStatus(null);
      setState("connecting");
      connect();
    });

    return () => {
      finished = true;
      cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
      close?.();
    };
  }, [streamPath, kind]);

  useEffect(() => {
    if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [lines, follow]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const indexed = lines.map((text, i) => ({ text, n: i + 1 }));
    return q ? indexed.filter((l) => l.text.toLowerCase().includes(q)) : indexed;
  }, [lines, filter]);

  const errors = useMemo(() => lines.filter((l) => classify(l) === "log-line-error").length, [lines]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (follow !== atBottom) setFollow(atBottom);
  }

  function download() {
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const stateLabel =
    state === "live" ? (kind === "runtime" ? "Following" : "Streaming")
      : state === "ended" ? (endStatus ? `Ended · ${endStatus}` : "Ended")
      : state === "error" ? "Disconnected"
      : "Connecting";

  return (
    <div className="overflow-hidden rounded-[var(--r)] border border-[var(--hairline)] bg-[var(--bg-deep)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--hairline)] px-3 py-2">
        <span className={cx(
          "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
          state === "live" && "bg-[var(--ok-soft)] text-[var(--ok)]",
          state === "ended" && "bg-[var(--surface-2)] text-[var(--text-muted)]",
          state === "error" && "bg-[var(--danger-soft)] text-[var(--danger)]",
          state === "connecting" && "bg-[var(--info-soft)] text-[var(--info)]",
        )}>
          <span className={cx("h-1.5 w-1.5 rounded-full bg-current", state === "live" && "live-dot")} />
          {stateLabel}
        </span>
        <span className="tabular text-[11px] text-[var(--text-dim)]">
          {lines.length.toLocaleString()} lines
          {errors > 0 && <span className="text-[var(--danger)]"> · {errors} error line{errors === 1 ? "" : "s"}</span>}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <label className="flex items-center gap-1.5 rounded-[var(--r-xs)] border border-[var(--hairline)] bg-[var(--surface)] px-2 py-1">
            <SearchIcon className="h-3 w-3 text-[var(--text-dim)]" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter lines"
              className="w-36 bg-transparent text-xs outline-none placeholder:text-[var(--text-dim)]" />
            {filter && <span className="tabular text-[10px] text-[var(--text-dim)]">{shown.length}</span>}
          </label>
          <ToggleChip on={wrap} onClick={() => setWrap((w) => !w)}>Wrap</ToggleChip>
          <ToggleChip on={follow} onClick={() => setFollow((f) => !f)}>Follow</ToggleChip>
          <button onClick={download} disabled={!lines.length} title="Download"
            className="rounded-[var(--r-xs)] p-1.5 text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] disabled:opacity-40">
            <DownloadIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div ref={scroller} onScroll={onScroll} className="thin-scroll overflow-auto" style={{ height }}>
        {lines.length === 0 ? (
          <p className="p-4 font-[family-name:var(--font-jetbrains-mono)] text-xs text-[var(--text-dim)]">
            {state === "error" ? "Could not connect to the log stream." : emptyText}
          </p>
        ) : (
          <div className={cx(
            "py-2 font-[family-name:var(--font-jetbrains-mono)] text-[12px] leading-[1.6] text-[var(--text-muted)]",
            wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
          )}>
            {shown.map(({ text, n }) => (
              <div key={n} className={cx("flex hover:bg-[oklch(100%_0_0/0.025)]", classify(text))}>
                <span className="tabular w-12 shrink-0 select-none pr-3 text-right text-[var(--text-dim)] opacity-50">{n}</span>
                <span className="min-w-0 pr-4">{text || " "}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToggleChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={on}
      className={cx(
        "rounded-[var(--r-xs)] border px-2 py-1 text-[11px] font-medium transition-colors",
        on ? "border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent)]"
          : "border-[var(--hairline)] text-[var(--text-dim)] hover:text-[var(--text-muted)]",
      )}>
      {children}
    </button>
  );
}
