/**
 * A README rendered the way GitHub renders it.
 *
 * Relative links and images are resolved against the file's own directory,
 * as GitHub does: a link to `docs/setup.md` opens that file on GitHub, an
 * image `./screenshot.png` loads from the repository. Images in a private
 * repository need a GitHub login a third-party page does not have, so they
 * are left out rather than shown broken.
 *
 * READMEs use HTML constantly — `<img width>`, `<p align="center">`,
 * `<details>` — so it is rendered, but only after `rehype-sanitize` with its
 * default schema, which is GitHub's own: the same tags and attributes GitHub
 * allows, and no scripts, event handlers or `javascript:` URLs.
 */

"use client";

import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

/** `target` relative to the `base` directory, as a repository path. */
export function resolvePath(base: string, target: string): string {
  const parts = target.startsWith("/") ? [] : base ? base.split("/") : [];
  for (const segment of target.replace(/^\//, "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

export default function Markdown({
  source,
  directory,
  fullName,
  sha,
  isPrivate,
  onOpen,
}: {
  source: string;
  directory: string;
  fullName: string;
  sha: string;
  isPrivate: boolean;
  /** Open a repository path in place instead of leaving for GitHub. */
  onOpen?: (path: string) => void;
}) {
  function transform(url: string, key: string): string {
    const absolute = /^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(url);
    if (absolute) return defaultUrlTransform(url);
    const path = resolvePath(directory, url.split("#")[0]);
    if (key === "src") {
      return isPrivate ? "" : `https://raw.githubusercontent.com/${fullName}/${sha}/${path}`;
    }
    // A fragment marker: inert as a link, and recognised below to open in place.
    return `#repo:${encodeURI(path)}`;
  }

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Raw HTML is parsed, then sanitised — in that order, always.
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        urlTransform={transform}
        components={{
          a: ({ href, children }) => {
            const link = String(href ?? "");
            if (link.startsWith("#repo:")) {
              const path = decodeURI(link.slice(6));
              return onOpen ? (
                <a href={`#${path}`} onClick={(e) => { e.preventDefault(); onOpen(path); }}>{children}</a>
              ) : (
                <a href={`https://github.com/${fullName}/blob/${sha}/${path}`} target="_blank" rel="noreferrer">{children}</a>
              );
            }
            return <a href={link} target="_blank" rel="noreferrer">{children}</a>;
          },
          img: ({ src, alt, width, height }) =>
            src ? (
              // eslint-disable-next-line @next/next/no-img-element -- repository images, arbitrary hosts
              <img src={String(src)} alt={alt ?? ""} width={width} height={height} loading="lazy" />
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
