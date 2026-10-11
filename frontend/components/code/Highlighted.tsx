/**
 * Source code with syntax highlighting and line numbers.
 *
 * Shiki, the highlighter VS Code's grammars come from, loaded only when a
 * file is first opened — the rest of the console never pays for it — and
 * with its JavaScript regex engine rather than WebAssembly, so nothing extra
 * has to be served. Languages load on demand and stay loaded.
 *
 * Very large files are shown as plain text: highlighting ten thousand lines
 * freezes the tab for a moment nobody asked for.
 */

"use client";

import { useEffect, useState } from "react";

import { Skeleton } from "@/components/ui";

type Highlighter = {
  codeToHtml: (code: string, options: { lang: string; theme: string }) => string;
  loadLanguage: (...langs: string[]) => Promise<void>;
  getLoadedLanguages: () => string[];
};

const THEME = "vitesse-dark";
const MAX_HIGHLIGHT_LINES = 4000;

// Our language names -> shiki's.
const LANGS: Record<string, string> = {
  python: "python", javascript: "javascript", jsx: "jsx", typescript: "typescript", tsx: "tsx",
  json: "json", markdown: "markdown", mdx: "mdx", yaml: "yaml", toml: "toml", html: "html",
  css: "css", scss: "scss", sass: "sass", less: "less", go: "go", rust: "rust", java: "java",
  kotlin: "kotlin", ruby: "ruby", php: "php", c: "c", cpp: "cpp", csharp: "csharp",
  swift: "swift", bash: "bash", powershell: "powershell", sql: "sql", xml: "xml", vue: "vue",
  svelte: "svelte", dart: "dart", lua: "lua", r: "r", ini: "ini", dotenv: "dotenv",
  graphql: "graphql", prisma: "prisma", docker: "docker", makefile: "makefile",
};

let highlighter: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  highlighter ??= (async () => {
    const [{ createHighlighter }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki"),
      import("shiki/engine/javascript"),
    ]);
    return (await createHighlighter({
      themes: [THEME],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    })) as unknown as Highlighter;
  })();
  return highlighter;
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Plain lines in the same markup shiki produces, so the styling is shared. */
function plain(code: string): string {
  const lines = code.split("\n").map((l) => `<span class="line">${escape(l)}</span>`);
  return `<pre><code>${lines.join("\n")}</code></pre>`;
}

export default function Highlighted({ code, language }: { code: string; language: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const lineCount = code.split("\n").length;

  useEffect(() => {
    let active = true;
    const lang = LANGS[language];
    if (!lang || lineCount > MAX_HIGHLIGHT_LINES) {
      const frame = requestAnimationFrame(() => active && setHtml(plain(code)));
      return () => {
        active = false;
        cancelAnimationFrame(frame);
      };
    }
    (async () => {
      try {
        const h = await getHighlighter();
        if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage(lang);
        const out = h.codeToHtml(code, { lang, theme: THEME });
        if (active) setHtml(out);
      } catch {
        if (active) setHtml(plain(code));
      }
    })();
    return () => {
      active = false;
    };
  }, [code, language, lineCount]);

  if (html === null) {
    return (
      <div className="space-y-2 p-4">
        {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-3.5" />)}
      </div>
    );
  }
  // Shiki output is generated from the file's text, escaped by shiki itself;
  // the plain fallback is escaped above. No raw repository HTML is rendered.
  return <div className="code-view thin-scroll overflow-x-auto py-3" dangerouslySetInnerHTML={{ __html: html }} />;
}
