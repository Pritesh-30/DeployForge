/**
 * What changed between two deployments: the commits and the diff.
 *
 * "It worked yesterday" is the most common starting point for debugging a
 * deployment, and the question that follows is always "what changed?". This
 * answers it in place, the way GitHub's compare view does.
 */

"use client";

import { useEffect, useState } from "react";

import { ChevronRight, ExternalIcon, FileIcon } from "@/components/Icons";
import { Mono, Skeleton, cx, relativeTime } from "@/components/ui";
import { codeCompare, type Comparison } from "@/lib/apps";

const STATUS_TONE: Record<string, string> = {
  added: "text-[var(--ok)]",
  removed: "text-[var(--danger)]",
  modified: "text-[var(--warn)]",
  renamed: "text-[var(--info)]",
};

export function Changes({ appId, base, head }: { appId: string; base: string; head: string }) {
  const [data, setData] = useState<Comparison | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    codeCompare(appId, base, head)
      .then((c) => active && setData(c))
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not compare."));
    return () => {
      active = false;
    };
  }, [appId, base, head]);

  if (error) return <p className="px-4 py-4 text-sm text-[var(--danger)]">{error}</p>;
  if (!data) return <div className="p-4"><Skeleton className="h-24" /></div>;

  return (
    <div className="space-y-4 bg-[var(--bg-deep)] px-4 py-4">
      <p className="text-xs text-[var(--text-muted)]">
        <span className="font-semibold text-[var(--text)]">{data.total_commits}</span> commit{data.total_commits === 1 ? "" : "s"} ·{" "}
        <span className="font-semibold text-[var(--text)]">{data.files.length}</span> file{data.files.length === 1 ? "" : "s"} changed ·{" "}
        <span className="text-[var(--ok)]">+{data.additions}</span>{" "}
        <span className="text-[var(--danger)]">−{data.deletions}</span>
      </p>

      {data.commits.length > 0 && (
        <ol className="space-y-2">
          {[...data.commits].reverse().slice(0, 12).map((c) => (
            <li key={c.sha} className="flex items-start gap-3 text-sm">
              {c.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element -- GitHub avatars, tiny and remote
                <img src={c.avatar_url} alt="" className="mt-0.5 h-5 w-5 rounded-full" />
              ) : <span className="mt-0.5 h-5 w-5 rounded-full bg-[var(--surface-3)]" />}
              <div className="min-w-0 flex-1">
                <p className="truncate">{c.message}</p>
                <p className="text-xs text-[var(--text-dim)]">{c.author} · {relativeTime(c.date)}</p>
              </div>
              {c.html_url && (
                <a href={c.html_url} target="_blank" rel="noreferrer" className="shrink-0">
                  <Mono className="hover:text-[var(--text)]">{c.sha.slice(0, 7)}</Mono>
                </a>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="overflow-hidden rounded-[var(--r-sm)] border border-[var(--hairline)]">
        {data.files.map((f) => (
          <div key={f.filename} className="border-b border-[var(--hairline)] last:border-b-0">
            <button onClick={() => setOpen(open === f.filename ? null : f.filename)}
              className="flex w-full items-center gap-2.5 bg-[var(--surface)] px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--surface-2)]">
              <ChevronRight className={cx("h-3.5 w-3.5 text-[var(--text-dim)] transition-transform", open === f.filename && "rotate-90")} />
              <FileIcon className="h-3.5 w-3.5 text-[var(--text-dim)]" />
              <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-jetbrains-mono)]">{f.filename}</span>
              <span className={cx("capitalize", STATUS_TONE[f.status] ?? "text-[var(--text-dim)]")}>{f.status}</span>
              <span className="tabular text-[var(--ok)]">+{f.additions}</span>
              <span className="tabular text-[var(--danger)]">−{f.deletions}</span>
            </button>
            {open === f.filename && <Patch patch={f.patch} />}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Patch({ patch }: { patch: string | null }) {
  if (!patch) {
    return <p className="px-4 py-3 text-xs text-[var(--text-dim)]">No inline diff — the file is binary or too large to show.</p>;
  }
  return (
    <div className="thin-scroll max-h-[28rem] overflow-auto bg-[var(--bg-deep)] py-1 font-[family-name:var(--font-jetbrains-mono)] text-[12px] leading-[1.6]">
      {patch.split("\n").map((line, i) => (
        <div key={i} className={cx(
          "whitespace-pre px-4",
          line.startsWith("+") && "bg-[color-mix(in_oklch,var(--ok)_11%,transparent)] text-[var(--text)]",
          line.startsWith("-") && "bg-[color-mix(in_oklch,var(--danger)_11%,transparent)] text-[var(--text)]",
          line.startsWith("@@") && "bg-[var(--info-soft)] text-[var(--info)]",
          !/^[+\-@]/.test(line) && "text-[var(--text-muted)]",
        )}>
          {line || " "}
        </div>
      ))}
    </div>
  );
}

export function GitHubCommitLink({ fullName, sha }: { fullName: string; sha: string }) {
  return (
    <a href={`https://github.com/${fullName}/commit/${sha}`} target="_blank" rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs text-[var(--text-dim)] hover:text-[var(--text)]">
      View on GitHub <ExternalIcon className="h-3 w-3" />
    </a>
  );
}
