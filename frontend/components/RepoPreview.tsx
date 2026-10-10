"use client";

/**
 * The repository as GitHub shows it: a browsable file tree, the README of the
 * folder being viewed, and any file opened inline.
 *
 * Shown while choosing what to deploy, so a student can check they picked the
 * right repository and see what each candidate folder actually contains. The
 * tree and READMEs come with the scan (no extra requests); a file is fetched
 * only when opened.
 *
 * Give it `key={scan.scan_token}` so a new scan starts again at the root.
 */

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  BookIcon,
  ChevronRight,
  ExternalIcon,
  FileIcon,
  FolderIcon,
  GitHubIcon,
} from "@/components/Icons";
import { Badge, Mono, Spinner } from "@/components/ui";
import {
  getFilePreview,
  type FilePreview,
  type PreviewEntry,
  type ScanResult,
} from "@/lib/github";

const MARKDOWN = /\.(md|markdown|mdx)$/i;

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** `target` relative to `base` directory, as a repository path. */
function resolvePath(base: string, target: string): string {
  const parts = target.startsWith("/") ? [] : base ? base.split("/") : [];
  for (const segment of target.replace(/^\//, "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

export default function RepoPreview({
  scan,
  picked,
}: {
  scan: ScanResult;
  /** Candidate paths currently ticked, highlighted in the tree. */
  picked: string[];
}) {
  const preview = scan.preview;
  const ref = scan.commit_sha ?? scan.default_branch;
  const [cwd, setCwd] = useState("");
  const [openPath, setOpenPath] = useState<string | null>(null);
  // The last file fetched, keyed by its path, so a slow response for a file
  // the student has already moved away from is never shown for another.
  const [loaded, setLoaded] = useState<{
    path: string;
    file: FilePreview | null;
    error: string;
  } | null>(null);
  const file = loaded?.path === openPath ? loaded.file : null;
  const fileError = loaded?.path === openPath ? loaded.error : "";

  const children = useMemo(() => {
    const byParent = new Map<string, PreviewEntry[]>();
    for (const entry of preview?.entries ?? []) {
      const parent = parentOf(entry.path);
      const list = byParent.get(parent) ?? [];
      list.push(entry);
      byParent.set(parent, list);
    }
    return byParent;
  }, [preview]);

  const deployable = useMemo(
    () =>
      new Set(
        scan.candidates.filter((c) => c.type !== "unknown").map((c) => c.path),
      ),
    [scan.candidates],
  );

  useEffect(() => {
    if (!openPath) return;
    let cancelled = false;
    getFilePreview(scan.full_name, openPath, ref)
      .then((result) => {
        if (!cancelled) setLoaded({ path: openPath, file: result, error: "" });
      })
      .catch((err) => {
        if (!cancelled)
          setLoaded({
            path: openPath,
            file: null,
            error: err instanceof Error ? err.message : "Could not load the file.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [openPath, scan.full_name, ref]);

  if (!preview) return null;

  const listing = children.get(cwd) ?? [];
  const readme = preview.readmes[cwd];
  const githubBase = scan.html_url ?? `https://github.com/${scan.full_name}`;
  const crumbs = cwd ? cwd.split("/") : [];

  function go(path: string) {
    setOpenPath(null);
    setCwd(path);
  }

  return (
    <div className="overflow-hidden rounded-[var(--r-sm)] border border-[var(--hairline-strong)] bg-[var(--surface)]">
      {/* --- Repository header ------------------------------------------ */}
      <div className="border-b border-[var(--hairline)] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <GitHubIcon className="h-4 w-4 shrink-0 text-[var(--text-dim)]" />
            <span className="truncate text-sm font-semibold">{scan.full_name}</span>
            <Badge>{scan.private ? "Private" : "Public"}</Badge>
          </div>
          <a
            href={`${githubBase}/tree/${ref}/${cwd}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            View on GitHub
            <ExternalIcon className="h-3 w-3" />
          </a>
        </div>
        {scan.description && (
          <p className="mt-1.5 text-sm text-[var(--text-muted)]">{scan.description}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--text-dim)]">
          <span>
            branch <Mono>{scan.default_branch}</Mono>
          </span>
          {scan.commit_sha && (
            <span>
              commit <Mono title={scan.commit_sha}>{scan.commit_sha.slice(0, 7)}</Mono>
            </span>
          )}
          {scan.language && <span>{scan.language}</span>}
          <span>
            {scan.file_count} files · {formatBytes(scan.total_bytes)}
          </span>
        </div>
      </div>

      {/* --- Breadcrumbs ------------------------------------------------- */}
      <nav className="flex flex-wrap items-center gap-1 border-b border-[var(--hairline)] bg-[var(--surface-2)] px-4 py-2 text-sm">
        <button
          onClick={() => go("")}
          className="font-medium text-[var(--accent)] hover:underline"
        >
          {scan.full_name.split("/")[1]}
        </button>
        {crumbs.map((segment, i) => {
          const path = crumbs.slice(0, i + 1).join("/");
          const last = i === crumbs.length - 1 && !openPath;
          return (
            <span key={path} className="flex items-center gap-1">
              <span className="text-[var(--text-dim)]">/</span>
              {last ? (
                <span className="font-medium">{segment}</span>
              ) : (
                <button
                  onClick={() => go(path)}
                  className="text-[var(--accent)] hover:underline"
                >
                  {segment}
                </button>
              )}
            </span>
          );
        })}
        {openPath && (
          <span className="flex items-center gap-1">
            <span className="text-[var(--text-dim)]">/</span>
            <span className="font-medium">{nameOf(openPath)}</span>
          </span>
        )}
      </nav>

      {openPath ? (
        <FileView
          path={openPath}
          file={file}
          error={fileError}
          githubUrl={`${githubBase}/blob/${ref}/${openPath}`}
          scan={scan}
          ref_={ref}
        />
      ) : (
        <>
          {/* --- Listing ----------------------------------------------- */}
          <ul className="max-h-[22rem] divide-y divide-[var(--hairline)] overflow-auto">
            {cwd && (
              <li>
                <button
                  onClick={() => go(parentOf(cwd))}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
                >
                  <FolderIcon className="h-4 w-4 text-[var(--text-dim)]" />
                  ..
                </button>
              </li>
            )}
            {listing.map((entry) => {
              const isDir = entry.type === "dir";
              const canDeploy = isDir && deployable.has(entry.path);
              return (
                <li key={entry.path}>
                  <button
                    onClick={() => (isDir ? go(entry.path) : setOpenPath(entry.path))}
                    className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      {isDir ? (
                        <FolderIcon className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                      ) : (
                        <FileIcon className="h-4 w-4 shrink-0 text-[var(--text-dim)]" />
                      )}
                      <span className="truncate">{nameOf(entry.path)}</span>
                      {canDeploy && (
                        <Badge tone={picked.includes(entry.path) ? "accent" : "ok"}>
                          {picked.includes(entry.path) ? "Selected" : "Deployable"}
                        </Badge>
                      )}
                    </span>
                    {isDir ? (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-dim)]" />
                    ) : (
                      <span className="shrink-0 text-xs text-[var(--text-dim)]">
                        {formatBytes(entry.size)}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
            {listing.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-[var(--text-dim)]">
                This folder is empty.
              </li>
            )}
          </ul>
          {preview.truncated && (
            <p className="border-t border-[var(--hairline)] px-4 py-2 text-xs text-[var(--text-dim)]">
              This repository is too large to list completely here. Some deep
              folders are left out; GitHub has the full tree.
            </p>
          )}

          {/* --- README ------------------------------------------------- */}
          {readme && (
            <div className="border-t border-[var(--hairline-strong)]">
              <div className="flex items-center gap-2 border-b border-[var(--hairline)] px-4 py-2 text-sm font-medium">
                <BookIcon className="h-4 w-4 text-[var(--text-dim)]" />
                {readme.name}
              </div>
              <div className="max-h-[32rem] overflow-auto px-5 py-4">
                {MARKDOWN.test(readme.name) ? (
                  <Markdown
                    source={readme.content}
                    directory={cwd}
                    scan={scan}
                    ref_={ref}
                  />
                ) : (
                  <pre className="whitespace-pre-wrap font-[family-name:var(--font-mono)] text-xs leading-relaxed text-[var(--text-muted)]">
                    {readme.content}
                  </pre>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FileView({
  path,
  file,
  error,
  githubUrl,
  scan,
  ref_,
}: {
  path: string;
  file: FilePreview | null;
  error: string;
  githubUrl: string;
  scan: ScanResult;
  ref_: string;
}) {
  const lines = file?.content?.split("\n") ?? [];
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] px-4 py-2 text-xs text-[var(--text-dim)]">
        <span>
          {file ? `${lines.length || "—"} lines · ${formatBytes(file.size)}` : " "}
        </span>
        <a
          href={githubUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 hover:text-[var(--text)]"
        >
          Open on GitHub
          <ExternalIcon className="h-3 w-3" />
        </a>
      </div>
      <div className="max-h-[32rem] overflow-auto">
        {error ? (
          <p className="px-4 py-6 text-sm text-[var(--danger)]">{error}</p>
        ) : !file ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : file.binary ? (
          <p className="px-4 py-6 text-center text-sm text-[var(--text-dim)]">
            Binary file, not shown.
          </p>
        ) : file.content === null ? (
          <p className="px-4 py-6 text-center text-sm text-[var(--text-dim)]">
            This file is too large to show here. Open it on GitHub instead.
          </p>
        ) : MARKDOWN.test(path) ? (
          <div className="px-5 py-4">
            <Markdown
              source={file.content}
              directory={parentOf(path)}
              scan={scan}
              ref_={ref_}
            />
          </div>
        ) : (
          <table className="w-full border-collapse font-[family-name:var(--font-mono)] text-xs leading-5">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i}>
                  <td className="w-12 select-none pr-3 text-right align-top text-[var(--text-dim)]">
                    {i + 1}
                  </td>
                  <td className="whitespace-pre pr-4 text-[var(--text)]">{line || " "}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {file?.truncated && file.content !== null && (
          <p className="border-t border-[var(--hairline)] px-4 py-2 text-xs text-[var(--text-dim)]">
            Only the beginning of this file is shown.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * GitHub-flavoured Markdown, safely: raw HTML in a README is not rendered, and
 * links are passed through react-markdown's URL sanitiser after relative ones
 * are pointed at the repository on GitHub.
 */
function Markdown({
  source,
  directory,
  scan,
  ref_,
}: {
  source: string;
  directory: string;
  scan: ScanResult;
  ref_: string;
}) {
  const githubBase = scan.html_url ?? `https://github.com/${scan.full_name}`;

  function transform(url: string, key: string): string {
    const absolute = /^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(url);
    if (absolute) return defaultUrlTransform(url);
    const path = resolvePath(directory, url.split("#")[0]);
    if (key === "src") {
      // Images in a private repository need a login GitHub will not give a
      // third-party page, so only public ones are fetched.
      return scan.private
        ? ""
        : `https://raw.githubusercontent.com/${scan.full_name}/${ref_}/${path}`;
    }
    return defaultUrlTransform(`${githubBase}/blob/${ref_}/${path}`);
  }

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={transform}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          img: ({ src, alt }) =>
            src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={String(src)} alt={alt ?? ""} loading="lazy" />
            ) : (
              <span className="text-[var(--text-dim)]">[{alt || "image"}]</span>
            ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
