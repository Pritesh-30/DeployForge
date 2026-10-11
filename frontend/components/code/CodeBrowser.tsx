/**
 * The app's repository, browsed the way GitHub shows it.
 *
 * A file tree, a directory listing with its README, any file opened with
 * syntax highlighting and line numbers, the commits that touched what is on
 * screen, and every branch. Press `t` to jump to any file by typing part of
 * its name — the same shortcut GitHub uses.
 *
 * The location lives in the URL (?ref=…&path=…), so a link to a file at a
 * commit can be shared and the back button walks back through what was read.
 * Everything is read with the student's own GitHub token through the API,
 * and cached server-side by commit, so browsing is quick after the first
 * visit and costs GitHub almost nothing.
 */

"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import Highlighted from "@/components/code/Highlighted";
import Markdown from "@/components/code/Markdown";
import { ProportionBar } from "@/components/charts";
import {
  BookIcon,
  BranchIcon,
  ChevronRight,
  CommitIcon,
  ExternalIcon,
  FileIcon,
  FolderIcon,
  HistoryIcon,
  RocketIcon,
  SearchIcon,
} from "@/components/Icons";
import { Alert, Badge, Mono, Skeleton, cx, relativeTime } from "@/components/ui";
import {
  codeCommits,
  codeFile,
  codeReadme,
  codeSummary,
  codeTree,
  type CodeFile,
  type CodeSummary,
  type Commit,
  type TreeEntry,
} from "@/lib/apps";
import { bytes, compact } from "@/lib/format";
import { fuzzyFilter } from "@/lib/fuzzy";

const MARKDOWN = /\.(md|markdown|mdx)$/i;

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export default function CodeBrowser({ appId }: { appId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const ref = params.get("ref") ?? "";
  const path = params.get("path") ?? "";

  const [summary, setSummary] = useState<CodeSummary | null>(null);
  const [tree, setTree] = useState<{ sha: string; entries: TreeEntry[]; truncated: boolean } | null>(null);
  const [error, setError] = useState("");
  const [finder, setFinder] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const navigate = useCallback(
    (next: { ref?: string; path?: string }) => {
      const q = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v) q.set(k, v);
        else q.delete(k);
      }
      router.push(`${pathname}?${q.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  useEffect(() => {
    let active = true;
    Promise.all([codeSummary(appId, ref || undefined), codeTree(appId, ref || undefined)])
      .then(([s, t]) => {
        if (!active) return;
        setSummary(s);
        setTree(t);
        setError("");
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not read the repository."));
    return () => {
      active = false;
    };
  }, [appId, ref]);

  // GitHub's shortcut: `t` opens the file finder.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if (e.key === "t" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setFinder(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const byPath = useMemo(() => new Map((tree?.entries ?? []).map((e) => [e.path, e])), [tree]);
  const children = useMemo(() => {
    const map = new Map<string, TreeEntry[]>();
    for (const entry of tree?.entries ?? []) {
      const parent = parentOf(entry.path);
      (map.get(parent) ?? map.set(parent, []).get(parent)!).push(entry);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.type === b.type ? nameOf(a.path).localeCompare(nameOf(b.path), undefined, { sensitivity: "base" }) : a.type === "dir" ? -1 : 1));
    }
    return map;
  }, [tree]);

  if (error) {
    return (
      <Alert title="Could not read the repository">
        {error} If you recently changed your GitHub connection, reconnect it in Settings.
      </Alert>
    );
  }
  if (!summary || !tree) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-14" />
        <div className="grid gap-4 lg:grid-cols-[17rem_1fr]">
          <Skeleton className="h-[32rem]" />
          <Skeleton className="h-[32rem]" />
        </div>
      </div>
    );
  }

  const entry = path ? byPath.get(path) : null;
  const isFile = entry?.type === "file";
  const directory = isFile ? parentOf(path) : path;
  const repo = summary.repository;
  const deployRoots = new Set([...(summary.service_paths ?? []), summary.deploy_path ?? ""].filter(Boolean));

  return (
    <div className="space-y-4">
      {/* --- Repository bar --------------------------------------------- */}
      <div className="plate flex flex-col gap-4 p-4 lg:flex-row lg:items-center">
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--hairline-strong)] bg-[var(--surface-2)] px-2.5 py-1.5 text-sm">
            <BranchIcon className="h-3.5 w-3.5 text-[var(--text-dim)]" />
            <select value={ref || summary.branch} onChange={(e) => navigate({ ref: e.target.value === summary.branch ? "" : e.target.value, path: "" })}
              className="bg-transparent outline-none">
              {summary.branches.map((b) => (
                <option key={b.name} value={b.name}>{b.name}{b.name === summary.branch ? " (deploys)" : ""}</option>
              ))}
              {ref && !summary.branches.some((b) => b.name === ref) && <option value={ref}>{ref.slice(0, 12)}</option>}
            </select>
          </label>
          <span className="text-xs text-[var(--text-dim)]">{summary.branches.length} branch{summary.branches.length === 1 ? "" : "es"}</span>
          <button onClick={() => setFinder(true)}
            className="inline-flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--hairline)] px-2.5 py-1.5 text-xs text-[var(--text-muted)] transition-colors hover:border-[var(--hairline-strong)] hover:text-[var(--text)]">
            <SearchIcon className="h-3.5 w-3.5" />Go to file<kbd className="rounded border border-[var(--hairline-strong)] px-1 text-[10px]">t</kbd>
          </button>
        </div>

        {summary.head && (
          <div className="flex min-w-0 flex-1 items-center gap-2.5 text-sm lg:justify-end">
            {summary.head.avatar_url && (
              // eslint-disable-next-line @next/next/no-img-element -- GitHub avatar
              <img src={summary.head.avatar_url} alt="" className="h-5 w-5 rounded-full" />
            )}
            <span className="shrink-0 font-medium">{summary.head.author}</span>
            <span className="min-w-0 truncate text-[var(--text-muted)]">{summary.head.message}</span>
            <a href={summary.head.html_url ?? undefined} target="_blank" rel="noreferrer" className="shrink-0">
              <Mono className="hover:text-[var(--text)]">{summary.sha.slice(0, 7)}</Mono>
            </a>
            <span className="shrink-0 text-xs text-[var(--text-dim)]">{relativeTime(summary.head.date)}</span>
            <button onClick={() => setShowHistory((h) => !h)}
              className={cx("inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-sm)] border px-2.5 py-1 text-xs transition-colors",
                showHistory ? "border-[var(--accent-line)] text-[var(--accent)]" : "border-[var(--hairline)] text-[var(--text-muted)] hover:text-[var(--text)]")}>
              <HistoryIcon className="h-3.5 w-3.5" />History
            </button>
          </div>
        )}
      </div>

      {showHistory && <CommitHistory appId={appId} refName={summary.sha} path={path} fullName={repo.full_name} />}

      <div className="grid gap-4 lg:grid-cols-[17rem_1fr]">
        {/* --- Tree --------------------------------------------------------- */}
        <aside className="plate thin-scroll max-h-[44rem] overflow-y-auto p-2 lg:sticky lg:top-6 lg:self-start">
          <Tree
            childrenOf={children}
            dir=""
            depth={0}
            current={path}
            deployRoots={deployRoots}
            onOpen={(p) => navigate({ path: p })}
          />
          {tree.truncated && (
            <p className="px-2 py-2 text-[11px] text-[var(--text-dim)]">The repository is very large; some files are not listed.</p>
          )}
        </aside>

        {/* --- Main pane ---------------------------------------------------- */}
        <section className="min-w-0 space-y-4">
          <Breadcrumb name={repo.full_name.split("/")[1]} path={path} onOpen={(p) => navigate({ path: p })} />
          {isFile ? (
            <FilePane appId={appId} refName={summary.sha} path={path} fullName={repo.full_name} isPrivate={repo.private}
              onOpen={(p) => navigate({ path: p })} />
          ) : (
            <>
              <DirectoryListing
                entries={children.get(directory) ?? []}
                parent={directory ? parentOf(directory) : null}
                deployRoots={deployRoots}
                onOpen={(p) => navigate({ path: p })}
              />
              <Readme appId={appId} refName={summary.sha} dir={directory} fullName={repo.full_name} isPrivate={repo.private}
                onOpen={(p) => navigate({ path: p })} />
            </>
          )}
        </section>
      </div>

      {/* --- About ---------------------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="plate p-5">
          <p className="text-[13px] font-medium text-[var(--text-muted)]">About</p>
          <p className="mt-2 text-sm leading-relaxed">{repo.description || <span className="text-[var(--text-dim)]">No description.</span>}</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--text-dim)]">
            <span>★ {compact(repo.stars)}</span>
            <span>{compact(repo.forks)} forks</span>
            <span>{compact(repo.open_issues)} open issues</span>
            {repo.license && <span>{repo.license}</span>}
            <span>{bytes(repo.size_kb * 1024, 0)}</span>
            <Badge>{repo.private ? "Private" : "Public"}</Badge>
            <a href={repo.html_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-[var(--text)]">
              GitHub <ExternalIcon className="h-3 w-3" />
            </a>
          </div>
          {repo.topics.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {repo.topics.map((t) => <Badge key={t} tone="info">{t}</Badge>)}
            </div>
          )}
        </div>
        <div className="plate p-5">
          <p className="mb-4 text-[13px] font-medium text-[var(--text-muted)]">Languages</p>
          {summary.languages.length ? (
            <ProportionBar items={summary.languages.map((l) => ({ label: l.name, value: l.bytes }))} />
          ) : <p className="text-sm text-[var(--text-dim)]">GitHub has not classified any code here.</p>}
        </div>
      </div>

      {finder && (
        <FileFinder
          files={tree.entries.filter((e) => e.type === "file").map((e) => e.path)}
          onClose={() => setFinder(false)}
          onOpen={(p) => {
            setFinder(false);
            navigate({ path: p });
          }}
        />
      )}
    </div>
  );
}

/* --- Tree ----------------------------------------------------------------- */

function Tree({
  childrenOf,
  dir,
  depth,
  current,
  deployRoots,
  onOpen,
}: {
  childrenOf: Map<string, TreeEntry[]>;
  dir: string;
  depth: number;
  current: string;
  deployRoots: Set<string>;
  onOpen: (path: string) => void;
}) {
  const entries = childrenOf.get(dir) ?? [];
  return (
    <ul>
      {entries.map((e) => (
        <TreeNode key={e.path} entry={e} childrenOf={childrenOf} depth={depth} current={current}
          deployRoots={deployRoots} onOpen={onOpen} />
      ))}
    </ul>
  );
}

function TreeNode({
  entry,
  childrenOf,
  depth,
  current,
  deployRoots,
  onOpen,
}: {
  entry: TreeEntry;
  childrenOf: Map<string, TreeEntry[]>;
  depth: number;
  current: string;
  deployRoots: Set<string>;
  onOpen: (path: string) => void;
}) {
  const isDir = entry.type === "dir";
  // A folder starts open when what is on screen is inside it, or when it is
  // what this app deploys.
  const [open, setOpen] = useState(
    () => isDir && (current.startsWith(entry.path + "/") || current === entry.path || [...deployRoots].some((r) => r === entry.path || r.startsWith(entry.path + "/"))),
  );
  const active = current === entry.path;
  const deploys = deployRoots.has(entry.path);

  return (
    <li>
      <button
        onClick={() => {
          if (isDir) setOpen((o) => !o);
          onOpen(entry.path);
        }}
        className={cx(
          "flex w-full items-center gap-1.5 rounded-[var(--r-xs)] py-1 pr-2 text-left text-[13px] transition-colors",
          active ? "bg-[var(--surface-3)] text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
        )}
        style={{ paddingLeft: `${0.5 + depth * 0.85}rem` }}
      >
        {isDir ? (
          <ChevronRight className={cx("h-3 w-3 shrink-0 text-[var(--text-dim)] transition-transform duration-150", open && "rotate-90")} />
        ) : <span className="w-3 shrink-0" />}
        {isDir ? <FolderIcon className="h-3.5 w-3.5 shrink-0 text-[var(--info)]" /> : <FileIcon className="h-3.5 w-3.5 shrink-0 text-[var(--text-dim)]" />}
        <span className="truncate">{nameOf(entry.path)}</span>
        {deploys && <RocketIcon className="ml-auto h-3 w-3 shrink-0 text-[var(--accent)]" />}
      </button>
      {isDir && open && (
        <Tree childrenOf={childrenOf} dir={entry.path} depth={depth + 1} current={current}
          deployRoots={deployRoots} onOpen={onOpen} />
      )}
    </li>
  );
}

/* --- Breadcrumb ---------------------------------------------------------- */

function Breadcrumb({ name, path, onOpen }: { name: string; path: string; onOpen: (p: string) => void }) {
  const parts = path ? path.split("/") : [];
  return (
    <nav className="flex flex-wrap items-center gap-1 font-[family-name:var(--font-jetbrains-mono)] text-[13px]">
      <button onClick={() => onOpen("")} className="font-semibold text-[var(--accent)] hover:underline">{name}</button>
      {parts.map((part, i) => {
        const to = parts.slice(0, i + 1).join("/");
        const last = i === parts.length - 1;
        return (
          <span key={to} className="inline-flex items-center gap-1">
            <span className="text-[var(--text-dim)]">/</span>
            {last ? <span className="font-semibold text-[var(--text)]">{part}</span> : (
              <button onClick={() => onOpen(to)} className="text-[var(--accent)] hover:underline">{part}</button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/* --- Directory listing --------------------------------------------------- */

function DirectoryListing({
  entries,
  parent,
  deployRoots,
  onOpen,
}: {
  entries: TreeEntry[];
  parent: string | null;
  deployRoots: Set<string>;
  onOpen: (p: string) => void;
}) {
  return (
    <div className="plate overflow-hidden">
      <ul className="divide-y divide-[var(--hairline)]">
        {parent !== null && (
          <li>
            <button onClick={() => onOpen(parent)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-[var(--text-muted)] hover:bg-[var(--surface-2)]">
              <FolderIcon className="h-4 w-4 text-[var(--info)]" />..
            </button>
          </li>
        )}
        {entries.map((e) => (
          <li key={e.path}>
            <button onClick={() => onOpen(e.path)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-[var(--surface-2)]">
              {e.type === "dir" ? <FolderIcon className="h-4 w-4 shrink-0 text-[var(--info)]" /> : <FileIcon className="h-4 w-4 shrink-0 text-[var(--text-dim)]" />}
              <span className="min-w-0 flex-1 truncate">{nameOf(e.path)}</span>
              {deployRoots.has(e.path) && <Badge tone="accent"><RocketIcon className="h-3 w-3" />deployed</Badge>}
              {e.type === "file" && <span className="tabular shrink-0 text-xs text-[var(--text-dim)]">{bytes(e.size)}</span>}
            </button>
          </li>
        ))}
        {entries.length === 0 && <li className="px-4 py-8 text-center text-sm text-[var(--text-dim)]">This folder is empty.</li>}
      </ul>
    </div>
  );
}

/* --- README ---------------------------------------------------------------- */

function Readme({ appId, refName, dir, fullName, isPrivate, onOpen }: {
  appId: string; refName: string; dir: string; fullName: string; isPrivate: boolean; onOpen: (p: string) => void;
}) {
  const [readme, setReadme] = useState<{ path: string | null; name: string | null; content: string | null } | null>(null);
  useEffect(() => {
    let active = true;
    codeReadme(appId, dir, refName).then((r) => active && setReadme(r)).catch(() => active && setReadme(null));
    return () => {
      active = false;
    };
  }, [appId, dir, refName]);

  if (!readme?.content) return null;
  return (
    <div className="plate overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[var(--hairline)] px-4 py-2.5 text-sm font-medium">
        <BookIcon className="h-4 w-4 text-[var(--text-dim)]" />{readme.name}
      </div>
      <div className="px-6 py-5">
        {MARKDOWN.test(readme.name ?? "") ? (
          <Markdown source={readme.content} directory={dir} fullName={fullName} sha={refName} isPrivate={isPrivate} onOpen={onOpen} />
        ) : (
          <pre className="whitespace-pre-wrap font-[family-name:var(--font-jetbrains-mono)] text-xs text-[var(--text-muted)]">{readme.content}</pre>
        )}
      </div>
    </div>
  );
}

/* --- A file ----------------------------------------------------------------- */

function FilePane({ appId, refName, path, fullName, isPrivate, onOpen }: {
  appId: string; refName: string; path: string; fullName: string; isPrivate: boolean; onOpen: (p: string) => void;
}) {
  const [file, setFile] = useState<{ path: string; data: CodeFile | null; error: string } | null>(null);
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    codeFile(appId, path, refName)
      .then((f) => active && setFile({ path, data: f, error: "" }))
      .catch((e) => active && setFile({ path, data: null, error: e instanceof Error ? e.message : "Could not open the file." }));
    return () => {
      active = false;
    };
  }, [appId, path, refName]);

  const current = file?.path === path ? file : null;
  const data = current?.data;
  const lines = data?.content ? data.content.split("\n").length : 0;
  const isMarkdown = MARKDOWN.test(path);

  return (
    <div className="plate overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--hairline)] px-4 py-2.5 text-xs text-[var(--text-muted)]">
        {data && !data.binary && !data.too_large && <span className="tabular">{lines.toLocaleString()} lines</span>}
        {data && <span className="tabular">{bytes(data.size)}</span>}
        {data && <Badge>{data.language}</Badge>}
        <div className="ml-auto flex items-center gap-1.5">
          {isMarkdown && data?.content && (
            <div className="inline-flex rounded-[var(--r-xs)] border border-[var(--hairline)] p-0.5">
              {["Preview", "Code"].map((label) => (
                <button key={label} onClick={() => setRaw(label === "Code")}
                  className={cx("rounded-[3px] px-2 py-0.5", (label === "Code") === raw ? "bg-[var(--surface-3)] text-[var(--text)]" : "text-[var(--text-dim)]")}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {data?.content && (
            <button onClick={() => {
              navigator.clipboard.writeText(data.content ?? "").then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }} className="rounded-[var(--r-xs)] border border-[var(--hairline)] px-2 py-0.5 hover:text-[var(--text)]">
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          {data && (
            <a href={data.html_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-[var(--r-xs)] border border-[var(--hairline)] px-2 py-0.5 hover:text-[var(--text)]">
              GitHub <ExternalIcon className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>

      {!current ? (
        <div className="space-y-2 p-4">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-3.5" />)}</div>
      ) : current.error ? (
        <p className="p-6 text-sm text-[var(--danger)]">{current.error}</p>
      ) : data?.too_large ? (
        <p className="p-6 text-sm text-[var(--text-muted)]">This file is {bytes(data.size)} — too large to show here. <a className="text-[var(--accent)] underline" href={data.html_url} target="_blank" rel="noreferrer">Open it on GitHub</a>.</p>
      ) : data?.binary ? (
        <p className="p-6 text-sm text-[var(--text-muted)]">Binary file, not shown. <a className="text-[var(--accent)] underline" href={data.html_url} target="_blank" rel="noreferrer">Open it on GitHub</a>.</p>
      ) : isMarkdown && !raw && data?.content ? (
        <div className="px-6 py-5">
          <Markdown source={data.content} directory={parentOf(path)} fullName={fullName} sha={refName} isPrivate={isPrivate} onOpen={onOpen} />
        </div>
      ) : data?.content != null ? (
        <Highlighted code={data.content.replace(/\n$/, "")} language={data.language} />
      ) : null}
    </div>
  );
}

/* --- History ------------------------------------------------------------------- */

function CommitHistory({ appId, refName, path, fullName }: { appId: string; refName: string; path: string; fullName: string }) {
  const [pages, setPages] = useState<Commit[][]>([]);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);

  const load = useCallback(async (page: number) => {
    setLoading(true);
    try {
      const next = await codeCommits(appId, refName, path || undefined, page);
      setPages((p) => (page === 1 ? [next] : [...p, next]));
      if (next.length < 30) setDone(true);
    } finally {
      setLoading(false);
    }
  }, [appId, refName, path]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setPages([]);
      setDone(false);
      load(1);
    });
    return () => cancelAnimationFrame(frame);
  }, [load]);

  const commits = pages.flat();
  return (
    <div className="plate overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[var(--hairline)] px-4 py-2.5 text-sm font-medium">
        <HistoryIcon className="h-4 w-4 text-[var(--text-dim)]" />
        Commits {path ? <>to <Mono>{path}</Mono></> : "on this branch"}
      </div>
      <ol className="thin-scroll max-h-80 divide-y divide-[var(--hairline)] overflow-y-auto">
        {commits.map((c) => (
          <li key={c.sha} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <CommitIcon className="h-4 w-4 shrink-0 text-[var(--text-dim)]" />
            <div className="min-w-0 flex-1">
              <p className="truncate">{c.message}</p>
              <p className="text-xs text-[var(--text-dim)]">{c.author} committed {relativeTime(c.date)}</p>
            </div>
            <a href={c.html_url ?? `https://github.com/${fullName}/commit/${c.sha}`} target="_blank" rel="noreferrer">
              <Mono className="hover:text-[var(--text)]">{c.sha.slice(0, 7)}</Mono>
            </a>
          </li>
        ))}
        {loading && <li className="p-4"><Skeleton className="h-8" /></li>}
      </ol>
      {!done && !loading && commits.length > 0 && (
        <button onClick={() => load(pages.length + 1)} className="w-full border-t border-[var(--hairline)] py-2 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-2)]">
          Load older commits
        </button>
      )}
    </div>
  );
}

/* --- Go to file ------------------------------------------------------------------ */

function FileFinder({ files, onClose, onOpen }: { files: string[]; onClose: () => void; onOpen: (p: string) => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const results = useMemo(() => fuzzyFilter(files, query, (f) => f, 40), [files, query]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[oklch(0%_0_0/0.55)] px-4 pt-[10vh]" onClick={onClose}>
      <div className="w-full max-w-2xl overflow-hidden rounded-[var(--r)] border border-[var(--hairline-strong)] bg-[var(--surface-2)] shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-[var(--hairline)] px-4">
          <SearchIcon className="h-4 w-4 text-[var(--text-dim)]" />
          <input autoFocus value={query}
            onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(results.length - 1, i + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
              else if (e.key === "Enter" && results[index]) onOpen(results[index].item);
            }}
            placeholder={`Find a file among ${files.length.toLocaleString()}…`}
            className="h-12 flex-1 bg-transparent font-[family-name:var(--font-jetbrains-mono)] text-sm outline-none placeholder:font-[family-name:var(--font-geist-sans)] placeholder:text-[var(--text-dim)]" />
        </div>
        <ul className="thin-scroll max-h-[55vh] overflow-y-auto p-1.5">
          {results.map(({ item, match }, i) => {
            const hit = new Set(match.positions);
            return (
              <li key={item}>
                <button onClick={() => onOpen(item)} onMouseEnter={() => setIndex(i)}
                  className={cx("flex w-full items-center gap-2.5 rounded-[var(--r-xs)] px-3 py-2 text-left font-[family-name:var(--font-jetbrains-mono)] text-[12.5px]",
                    i === index && "bg-[var(--surface-3)]")}>
                  <FileIcon className="h-3.5 w-3.5 shrink-0 text-[var(--text-dim)]" />
                  <span className="truncate text-[var(--text-muted)]">
                    {[...item].map((ch, k) => hit.has(k) ? <span key={k} className="font-semibold text-[var(--accent)]">{ch}</span> : <span key={k}>{ch}</span>)}
                  </span>
                </button>
              </li>
            );
          })}
          {results.length === 0 && <li className="px-3 py-6 text-center text-sm text-[var(--text-dim)]">No file matches.</li>}
        </ul>
      </div>
    </div>
  );
}
