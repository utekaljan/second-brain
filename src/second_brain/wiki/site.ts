import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { withOutputDir, type ProjectPaths } from "../system/paths.js";
import { slugify } from "../utils/text.js";
import { ThrottledProgressReporter, type ProgressWriter } from "../utils/progress.js";
import { renderGraphExplorer } from "./graph.js";
import { renderValidationWiki } from "./render.js";

/**
 * Builds a static HTML wrapper over the generated markdown validation wiki.
 *
 * This follows the single-generator pattern used in `repos/llm-wiki/llmwiki/build.py`,
 * but keeps `output/wiki/` as the source-of-truth and stays friendly to direct
 * `file://` browsing without requiring a local web server.
 */
type WikiManifestPage = {
  title: string;
  path: string;
  kind: "index" | "thought" | "reference" | "constellation" | "trajectory";
  summary: string;
  nodeType?: "question" | "thesis" | "theme" | "tension" | "thread";
  nodeId?: string;
  documentId?: string;
};

type WikiManifest = {
  generatedAt: string;
  sourceRunId: string;
  sourceCorpusPath: string;
  sourceGraphPath: string;
  pageCount: number;
  thoughtPageCount: number;
  referencePageCount: number;
  indexPageCount: number;
  pages: WikiManifestPage[];
};

type WikiSearchEntry = {
  id: string;
  title: string;
  path: string;
  kind: "index" | "thought" | "reference" | "constellation" | "trajectory";
  summary: string;
  nodeType?: "question" | "thesis" | "theme" | "tension" | "thread";
  nodeStatus?: "active" | "tentative" | "unresolved" | "revised";
  documentId?: string;
  aliases?: string[];
  keywords: string[];
};

type SitePageInfo = {
  manifestPage: WikiManifestPage;
  markdownPath: string;
  htmlPath: string;
  htmlRelativePath: string;
};

type ValidationSiteManifestPage = {
  title: string;
  path: string;
  sourceMarkdownPath: string | null;
  kind: "index" | "thought" | "reference" | "constellation" | "trajectory" | "graph";
  summary: string;
};

type ValidationSiteManifest = {
  generatedAt: string;
  sourceRunId: string;
  pageCount: number;
  sourceWikiDir: string;
  sourceWikiManifestPath: string;
  pages: ValidationSiteManifestPage[];
};

/**
 * Small CLI summary for the static HTML validation site.
 */
export type ValidationSiteRenderSummary = {
  generatedAt: string;
  sourceRunId: string;
  pageCount: number;
  indexPath: string;
  manifestPath: string;
  searchIndexPath: string;
};

const SECTION_TITLES: Record<string, string> = {
  "": "Mapa myšlení",
  atlas: "Konstelace",
  trajectories: "Trajektorie",
  thoughts: "Inventář myšlenek",
  theses: "Teze",
  questions: "Otázky",
  themes: "Témata",
  tensions: "Tenze",
  threads: "Vlákna",
  vertical: "Vertikální mapa",
  chronology: "Chronologie",
  references: "Reference",
  indexes: "Diagnostika",
  graph: "Živý graf"
};

const TYPE_LABELS: Record<string, string> = {
  thesis: "Teze",
  question: "Otázka",
  theme: "Téma",
  tension: "Tenze",
  thread: "Vlákno"
};

const STATUS_LABELS: Record<string, string> = {
  active: "aktivní",
  tentative: "pracovní",
  unresolved: "neuzavřené",
  revised: "revidované"
};

const SITE_STYLE = `
:root {
  color-scheme: light;
  --bg: #f5f0e6;
  --bg-elevated: rgba(255, 250, 241, 0.9);
  --panel: #fffaf1;
  --panel-strong: #fffdf8;
  --text: #1f261f;
  --muted: #5f675d;
  --border: rgba(44, 62, 45, 0.16);
  --accent: #0d6b57;
  --accent-soft: rgba(13, 107, 87, 0.12);
  --accent-strong: #08493b;
  --shadow: 0 18px 48px rgba(36, 43, 34, 0.08);
  --code-bg: #f0eadf;
  --blockquote-bg: #efe8db;
  --table-stripe: rgba(13, 107, 87, 0.04);
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #101614;
  --bg-elevated: rgba(17, 24, 22, 0.9);
  --panel: #151d1a;
  --panel-strong: #1b2622;
  --text: #edf2ec;
  --muted: #a6b2aa;
  --border: rgba(200, 222, 210, 0.12);
  --accent: #58c4a6;
  --accent-soft: rgba(88, 196, 166, 0.14);
  --accent-strong: #83d8bf;
  --shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
  --code-bg: #1d2723;
  --blockquote-bg: #18211e;
  --table-stripe: rgba(88, 196, 166, 0.05);
}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background:
    radial-gradient(circle at top left, rgba(13, 107, 87, 0.16), transparent 32%),
    radial-gradient(circle at bottom right, rgba(198, 162, 92, 0.12), transparent 28%),
    var(--bg);
  color: var(--text);
  font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
  line-height: 1.65;
}

a { color: var(--accent); text-decoration-thickness: 0.08em; text-underline-offset: 0.14em; }
a:hover { color: var(--accent-strong); }
code, pre {
  font-family: "SF Mono", "IBM Plex Mono", "JetBrains Mono", "Fira Code", Consolas, monospace;
}
code {
  background: var(--code-bg);
  padding: 0.12rem 0.32rem;
  border-radius: 0.32rem;
  font-size: 0.92em;
}
pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 0.9rem;
  padding: 1rem 1.1rem;
  overflow-x: auto;
}

.site-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 290px minmax(0, 1fr);
}

.site-sidebar {
  position: sticky;
  top: 0;
  align-self: start;
  min-height: 100vh;
  padding: 1.2rem 1rem 1.5rem;
  background: var(--bg-elevated);
  backdrop-filter: blur(20px);
  border-right: 1px solid var(--border);
}

.brand {
  display: block;
  margin-bottom: 1rem;
  padding: 1rem 1rem 0.9rem;
  border-radius: 1rem;
  background: linear-gradient(145deg, var(--panel-strong), var(--panel));
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  color: inherit;
  text-decoration: none;
}

.brand-eyebrow {
  display: inline-block;
  margin-bottom: 0.45rem;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  color: var(--accent);
}

.brand-title {
  margin: 0;
  font-size: 1.2rem;
  line-height: 1.15;
  font-family: "Avenir Next", "Gill Sans", "Trebuchet MS", sans-serif;
}

.brand-copy {
  margin: 0.6rem 0 0;
  color: var(--muted);
  font-size: 0.92rem;
}

.sidebar-search {
  position: relative;
  margin-bottom: 1rem;
}

.sidebar-search input {
  width: 100%;
  padding: 0.85rem 0.95rem;
  border-radius: 0.9rem;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  font: inherit;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.search-results {
  display: none;
  position: absolute;
  top: calc(100% + 0.45rem);
  left: 0;
  right: 0;
  z-index: 50;
  max-height: 55vh;
  overflow: auto;
  padding: 0.4rem;
  border-radius: 1rem;
  border: 1px solid var(--border);
  background: var(--panel-strong);
  box-shadow: var(--shadow);
}

.search-results.is-open { display: block; }

.search-result {
  display: block;
  padding: 0.7rem 0.8rem;
  border-radius: 0.75rem;
  color: inherit;
  text-decoration: none;
}

.search-result:hover,
.search-result.is-active {
  background: var(--accent-soft);
}

.search-result-title {
  display: block;
  font-weight: 600;
}

.search-result-meta,
.search-result-summary {
  display: block;
  font-size: 0.86rem;
  color: var(--muted);
}

.sidebar-group {
  margin-top: 1.1rem;
  padding: 0.85rem 0.9rem;
  border-radius: 1rem;
  background: rgba(255, 255, 255, 0.18);
  border: 1px solid var(--border);
}

.sidebar-heading {
  margin: 0 0 0.65rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--muted);
}

.sidebar-nav,
.sidebar-links {
  list-style: none;
  padding: 0;
  margin: 0;
}

.sidebar-nav a,
.sidebar-links a,
.theme-toggle {
  display: block;
  width: 100%;
  padding: 0.55rem 0.65rem;
  border-radius: 0.65rem;
  color: inherit;
  text-decoration: none;
  border: 0;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.sidebar-nav a:hover,
.sidebar-links a:hover,
.theme-toggle:hover,
.sidebar-nav a.is-active,
.sidebar-links a.is-active {
  background: var(--accent-soft);
}

.unavailable-link {
  color: var(--muted);
  text-decoration: underline dotted;
  text-underline-offset: 0.14em;
  cursor: help;
}

.sidebar-links li + li,
.sidebar-nav li + li { margin-top: 0.1rem; }

.sidebar-meta {
  margin-top: 1rem;
  font-size: 0.84rem;
  color: var(--muted);
}

.site-main {
  min-width: 0;
  padding: 2rem min(5vw, 3rem) 3.5rem;
}

.page-wrap {
  width: min(100%, 980px);
  margin: 0 auto;
}

.page-topbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.8rem;
  margin-bottom: 1rem;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.28rem 0.62rem;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 0.82rem;
  letter-spacing: 0.02em;
}

.page-actions {
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem;
}

.action-link {
  padding: 0.55rem 0.82rem;
  border-radius: 0.7rem;
  background: var(--panel);
  border: 1px solid var(--border);
  text-decoration: none;
  color: inherit;
}

.breadcrumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-bottom: 1rem;
  color: var(--muted);
  font-size: 0.92rem;
}

.breadcrumbs span[aria-current="page"] {
  color: var(--text);
  font-weight: 600;
}

.page-card {
  padding: 1.6rem clamp(1rem, 2vw, 2rem) 2rem;
  border-radius: 1.35rem;
  background: linear-gradient(160deg, var(--panel-strong), var(--panel));
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
}

.page-card h1 {
  margin: 0 0 0.45rem;
  font-size: clamp(1.9rem, 3vw, 2.65rem);
  line-height: 1.05;
  font-family: "Charter", "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
}

.page-summary {
  margin: 0 0 1.35rem;
  font-size: 1.03rem;
  color: var(--muted);
}

.markdown-body {
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: "Charter", "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
  font-size: 1.03rem;
}

.markdown-body h2,
.markdown-body h3,
.markdown-body h4,
.markdown-body h5,
.markdown-body h6 {
  margin-top: 1.7em;
  margin-bottom: 0.55em;
  line-height: 1.15;
  font-family: "Avenir Next", "Gill Sans", "Trebuchet MS", sans-serif;
}

.markdown-body h2 {
  padding-top: 0.15rem;
  border-top: 1px solid var(--border);
}

.markdown-body p,
.markdown-body ul,
.markdown-body ol,
.markdown-body blockquote,
.markdown-body table,
.markdown-body pre {
  margin-top: 0;
  margin-bottom: 1rem;
}

.markdown-body ul,
.markdown-body ol {
  padding-left: 1.35rem;
}

.markdown-body li + li {
  margin-top: 0.32rem;
}

.markdown-body blockquote {
  margin-left: 0;
  padding: 0.9rem 1rem;
  border-left: 4px solid var(--accent);
  background: var(--blockquote-bg);
  border-radius: 0.95rem;
}

.markdown-body table {
  display: block;
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  border-collapse: collapse;
  border-radius: 0.95rem;
  border: 1px solid var(--border);
  font-size: 0.95rem;
}

.markdown-body thead {
  background: var(--accent-soft);
}

.markdown-body th,
.markdown-body td {
  padding: 0.72rem 0.78rem;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}

.markdown-body tbody tr:nth-child(even) {
  background: var(--table-stripe);
}

.markdown-body tbody tr:last-child td {
  border-bottom: 0;
}

.site-footnote {
  margin-top: 1rem;
  color: var(--muted);
  font-size: 0.86rem;
}

.audit-appendix {
  margin-top: 1.7rem;
  padding: 0.85rem 1rem;
  border: 1px solid var(--border);
  border-radius: 0.95rem;
  background: var(--blockquote-bg);
}

.audit-appendix summary {
  cursor: pointer;
  font-family: "Avenir Next", "Gill Sans", "Trebuchet MS", sans-serif;
  font-weight: 700;
  color: var(--accent-strong);
}

.audit-appendix[open] summary {
  margin-bottom: 1rem;
}

@media (max-width: 1024px) {
  .site-shell {
    display: block;
    width: 100%;
    max-width: 100%;
  }

  .site-sidebar {
    position: relative;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    min-height: auto;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
}

@media (max-width: 720px) {
  .site-sidebar {
    padding: 0.75rem;
  }

  .brand {
    margin-bottom: 0.65rem;
    padding: 0.72rem 0.82rem;
  }

  .brand-eyebrow,
  .brand-copy,
  .sidebar-meta,
  .sidebar-group + .sidebar-group {
    display: none;
  }

  .sidebar-search {
    margin-bottom: 0.65rem;
  }

  .sidebar-search input {
    padding: 0.68rem 0.78rem;
  }

  .sidebar-group {
    margin-top: 0;
    padding: 0.45rem;
  }

  .sidebar-heading {
    margin: 0 0 0.35rem;
  }

  .sidebar-nav {
    display: flex;
    gap: 0.2rem;
    overflow-x: auto;
    scrollbar-width: thin;
  }

  .sidebar-nav li {
    flex: 0 0 auto;
  }

  .sidebar-nav li + li {
    margin-top: 0;
  }

  .sidebar-nav a {
    white-space: nowrap;
    padding: 0.45rem 0.58rem;
  }

  .markdown-body th,
  .markdown-body td {
    min-width: 10rem;
  }

  .site-main {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    padding: 1rem 0.75rem 2rem;
  }

  .page-card {
    padding: 1.15rem 0.9rem 1.5rem;
    border-radius: 1rem;
  }

  .page-actions {
    margin-left: 0;
    width: 100%;
  }
}
`;

const SITE_SCRIPT = `
(function () {
  var root = document.documentElement;
  var storageKey = "second-brain-site-theme";
  var searchEntries = Array.isArray(window.__SECOND_BRAIN_SEARCH__)
    ? window.__SECOND_BRAIN_SEARCH__
    : [];
  var siteRoot = document.body.getAttribute("data-site-root") || ".";

  function siteUrl(url) {
    return (siteRoot === "." ? "" : siteRoot + "/") + String(url || "");
  }

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(storageKey, theme);
    } catch (error) {}
  }

  var savedTheme = null;
  try {
    savedTheme = localStorage.getItem(storageKey);
  } catch (error) {}
  if (savedTheme === "light" || savedTheme === "dark") {
    applyTheme(savedTheme);
  }

  var themeButtons = document.querySelectorAll("[data-theme-toggle]");
  themeButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      applyTheme(next);
    });
  });

  var input = document.getElementById("site-search");
  var results = document.getElementById("site-search-results");
  var activeIndex = -1;

  function score(entry, query) {
    if (!query) return 0;
    var haystack = [
      entry.title || "",
      entry.summary || "",
      entry.kind || "",
      (entry.keywords || []).join(" "),
      entry.nodeType || "",
      entry.nodeStatus || ""
    ].join(" ").toLowerCase();
    var q = query.toLowerCase().trim();
    if (!q) return 0;
    if ((entry.title || "").toLowerCase() === q) return 100;
    if ((entry.title || "").toLowerCase().indexOf(q) === 0) return 70;
    var parts = q.split(/\\s+/).filter(Boolean);
    var matched = 0;
    parts.forEach(function (part) {
      if (haystack.indexOf(part) !== -1) matched += 1;
    });
    if (!matched) return 0;
    return matched * 15 + (haystack.indexOf(q) !== -1 ? 25 : 0);
  }

  function topMatches(query) {
    return searchEntries
      .map(function (entry) {
        return { entry: entry, score: score(entry, query) };
      })
      .filter(function (row) { return row.score > 0; })
      .sort(function (left, right) { return right.score - left.score; })
      .slice(0, 8)
      .map(function (row) { return row.entry; });
  }

  function renderResults(items) {
    if (!results) return;
    if (!items.length) {
      results.innerHTML = "";
      results.classList.remove("is-open");
      activeIndex = -1;
      return;
    }

    results.innerHTML = items.map(function (item, index) {
      var meta = [item.kind, item.nodeType, item.nodeStatus].filter(Boolean).join(" · ");
      return '<a class="search-result' + (index === 0 ? ' is-active' : '') + '" data-index="' + index + '" href="' + siteUrl(item.url) + '">' +
        '<span class="search-result-title">' + escapeHtml(item.title || item.path || "") + '</span>' +
        (meta ? '<span class="search-result-meta">' + escapeHtml(meta) + '</span>' : '') +
        '<span class="search-result-summary">' + escapeHtml(item.summary || "") + '</span>' +
      '</a>';
    }).join("");
    results.classList.add("is-open");
    activeIndex = 0;
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, function (char) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char];
    });
  }

  function currentItems() {
    if (!results) return [];
    return Array.prototype.slice.call(results.querySelectorAll(".search-result"));
  }

  if (input && results) {
    input.addEventListener("input", function () {
      var query = input.value.trim();
      if (!query) {
        results.innerHTML = "";
        results.classList.remove("is-open");
        activeIndex = -1;
        return;
      }
      renderResults(topMatches(query));
    });

    input.addEventListener("keydown", function (event) {
      var items = currentItems();
      if (!items.length) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        activeIndex = Math.min(items.length - 1, activeIndex + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        activeIndex = Math.max(0, activeIndex - 1);
      } else if (event.key === "Enter" && activeIndex >= 0) {
        event.preventDefault();
        items[activeIndex].click();
        return;
      } else {
        return;
      }

      items.forEach(function (item, index) {
        item.classList.toggle("is-active", index === activeIndex);
      });
    });

    document.addEventListener("click", function (event) {
      if (!results.contains(event.target) && event.target !== input) {
        results.classList.remove("is-open");
      }
    });
  }
})();
`;

function replacePathSeparators(value: string): string {
  return value.split(path.sep).join("/");
}

function readJsonFile<T>(target: string): T {
  return JSON.parse(readFileSync(target, "utf8")) as T;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function serializeInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function relativeLink(fromTarget: string, toTarget: string): string {
  return replacePathSeparators(path.relative(path.dirname(fromTarget), toTarget));
}

function stripMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .trim();
}

function headingId(text: string): string {
  return slugify(stripMarkdown(text)) || "section";
}

function splitHref(href: string): { pathPart: string; hashPart: string } {
  const hashIndex = href.indexOf("#");
  if (hashIndex === -1) {
    return {
      pathPart: href,
      hashPart: ""
    };
  }

  return {
    pathPart: href.slice(0, hashIndex),
    hashPart: href.slice(hashIndex)
  };
}

function renderableHref(
  href: string,
  markdownPath: string,
  wikiMarkdownPaths: Set<string>
): string | null {
  if (
    href.startsWith("#") ||
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("mailto:") ||
    href.startsWith("tel:")
  ) {
    return href;
  }

  // Source excerpts can contain ChatGPT sandbox links or references to files
  // that were not included in the corpus export. Do not turn those into dead
  // local links in the validation site.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)) {
    return null;
  }

  const { pathPart, hashPart } = splitHref(href);
  let decodedPathPart: string;
  try {
    decodedPathPart = decodeURIComponent(pathPart);
  } catch {
    return null;
  }
  const resolvedTarget = path.resolve(path.dirname(markdownPath), decodedPathPart);
  if (pathPart.endsWith(".md")) {
    if (wikiMarkdownPaths.has(resolvedTarget)) {
      return `${pathPart.slice(0, -3)}.html${hashPart}`;
    }
    return existsSync(resolvedTarget) ? href : null;
  }

  if (path.extname(pathPart).length === 0 && !existsSync(resolvedTarget)) {
    return null;
  }

  return href;
}

function renderInlineMarkdown(
  text: string,
  markdownPath: string,
  wikiMarkdownPaths: Set<string>
): string {
  const codeChunks: string[] = [];
  const withCodePlaceholders = text.replace(/`([^`]+)`/g, (_, code: string) => {
    const token = `@@CODE${codeChunks.length}@@`;
    codeChunks.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  const linkChunks: string[] = [];
  const withLinkPlaceholders = withCodePlaceholders.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label: string, href: string) => {
      const token = `@@LINK${linkChunks.length}@@`;
      const trimmedHref = href.trim();
      const renderedHref = renderableHref(trimmedHref, markdownPath, wikiMarkdownPaths);
      const renderedLabel = renderInlineMarkdown(label, markdownPath, wikiMarkdownPaths);
      linkChunks.push(renderedHref === null
        ? `<span class="unavailable-link" title="Cíl není součástí exportu: ${escapeHtml(trimmedHref)}">${renderedLabel}</span>`
        : `<a href="${escapeHtml(renderedHref)}">${renderedLabel}</a>`
      );
      return token;
    }
  );

  let html = escapeHtml(withLinkPlaceholders);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1<em>$2</em>");
  html = html.replace(/(^|[^\w])\*([^*]+)\*(?=[^\w]|$)/g, "$1<em>$2</em>");

  for (let index = 0; index < linkChunks.length; index += 1) {
    html = html.replace(`@@LINK${index}@@`, linkChunks[index] ?? "");
  }
  for (let index = 0; index < codeChunks.length; index += 1) {
    html = html.replace(`@@CODE${index}@@`, codeChunks[index] ?? "");
  }

  return html;
}

function splitTableRow(line: string): string[] {
  const cells = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

  return cells;
}

function isTableDivider(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isListLine(line: string, ordered: boolean): boolean {
  return ordered ? /^\d+\.\s+/.test(line) : /^-\s+/.test(line);
}

function renderListItem(
  lines: string[],
  markdownPath: string,
  wikiMarkdownPaths: Set<string>
): string {
  const normalized = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (normalized.length === 0) {
    return "<li></li>";
  }

  return `<li>${normalized
    .map((line) => renderInlineMarkdown(line, markdownPath, wikiMarkdownPaths))
    .join("<br>")}</li>`;
}

function markdownToHtml(
  markdown: string,
  markdownPath: string,
  wikiMarkdownPaths: Set<string>
): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  const headingIdCounts = new Map<string, number>();
  let index = 0;

  const uniqueHeadingId = (baseId: string): string => {
    const count = headingIdCounts.get(baseId) ?? 0;
    headingIdCounts.set(baseId, count + 1);
    return count === 0 ? baseId : `${baseId}-${count + 1}`;
  };

  const startsBlock = (line: string): boolean => {
    return (
      /^#{1,6}\s+/.test(line) ||
      /^>\s?/.test(line) ||
      /^<a id="[-A-Za-z0-9_:]+"><\/a>$/.test(line) ||
      /^-\s+/.test(line) ||
      /^\d+\.\s+/.test(line) ||
      line.includes("|")
    );
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      index += 1;
      continue;
    }

    const anchorMatch = trimmed.match(/^<a id="([-A-Za-z0-9_:]+)"><\/a>$/);
    if (anchorMatch) {
      blocks.push(`<a id="${escapeHtml(uniqueHeadingId(anchorMatch[1] ?? "section"))}"></a>`);
      index += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]?.length ?? 1;
      const content = headingMatch[2] ?? "";
      blocks.push(
        `<h${level} id="${uniqueHeadingId(headingId(content))}">${renderInlineMarkdown(content, markdownPath, wikiMarkdownPaths)}</h${level}>`
      );
      index += 1;
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1] ?? "")) {
      const headerCells = splitTableRow(line);
      const bodyRows: string[][] = [];
      index += 2;
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        if (!candidate.includes("|") || candidate.trim().length === 0) {
          break;
        }
        bodyRows.push(splitTableRow(candidate));
        index += 1;
      }

      blocks.push(
        `<table><thead><tr>${headerCells
          .map((cell) => `<th>${renderInlineMarkdown(cell, markdownPath, wikiMarkdownPaths)}</th>`)
          .join("")}</tr></thead><tbody>${bodyRows
          .map(
            (row) =>
              `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell, markdownPath, wikiMarkdownPaths)}</td>`).join("")}</tr>`
          )
          .join("")}</tbody></table>`
      );
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? "")) {
        quoteLines.push((lines[index] ?? "").replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(
        `<blockquote><p>${quoteLines
          .map((item) => renderInlineMarkdown(item, markdownPath, wikiMarkdownPaths))
          .join("<br>")}</p></blockquote>`
      );
      continue;
    }

    if (isListLine(line, false) || isListLine(line, true)) {
      const ordered = isListLine(line, true);
      const items: string[] = [];
      while (index < lines.length && isListLine(lines[index] ?? "", ordered)) {
        const current = lines[index] ?? "";
        const itemLines = [
          current.replace(ordered ? /^\d+\.\s+/ : /^-\s+/, "")
        ];
        index += 1;
        while (index < lines.length) {
          const continuation = lines[index] ?? "";
          if (continuation.trim().length === 0) {
            index += 1;
            break;
          }
          if (/^\s{2,}\S/.test(continuation)) {
            itemLines.push(continuation.trim());
            index += 1;
            continue;
          }
          break;
        }
        items.push(renderListItem(itemLines, markdownPath, wikiMarkdownPaths));
      }
      blocks.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }

    const paragraphLines = [trimmed];
    index += 1;
    while (index < lines.length) {
      const continuation = lines[index] ?? "";
      if (continuation.trim().length === 0) {
        index += 1;
        break;
      }
      if (startsBlock(continuation)) {
        break;
      }
      paragraphLines.push(continuation.trim());
      index += 1;
    }
    blocks.push(`<p>${paragraphLines
      .map((item) => renderInlineMarkdown(item, markdownPath, wikiMarkdownPaths))
      .join(" ")}</p>`);
  }

  const appendixIndex = blocks.findIndex((block) => /^<h2 id="appendix-/.test(block));
  if (appendixIndex !== -1) {
    const heading = blocks[appendixIndex]?.match(/^<h2[^>]*>(.*)<\/h2>$/)?.[1] ?? "Appendix";
    return [
      ...blocks.slice(0, appendixIndex),
      `<details class="audit-appendix"><summary>${heading}</summary>`,
      ...blocks.slice(appendixIndex + 1),
      "</details>"
    ].join("\n");
  }

  return blocks.join("\n");
}

function activeSection(relativePath: string): string {
  const normalized = replacePathSeparators(relativePath);
  if (normalized === "index.html") {
    return "";
  }
  if (normalized === "indexes/vertical_alignment.html" || normalized.startsWith("vertical/")) {
    return "vertical";
  }

  const [head] = normalized.split("/");
  return head ?? "";
}

function pageTitleForSection(section: string): string {
  return SECTION_TITLES[section] ?? section;
}

function breadcrumbsForPage(
  page: SitePageInfo,
  indexPageByMarkdownPath: Map<string, SitePageInfo>,
  siteDir: string
): Array<{
  label: string;
  href: string | null;
}> {
  const crumbs: Array<{ label: string; href: string | null }> = [
    { label: "Mapa myšlení", href: rootTarget(page.htmlPath, siteDir, "index.html") }
  ];
  const normalized = replacePathSeparators(page.manifestPage.path);
  const [section, basename] = normalized.split("/");

  if (!section || section === "index.md") {
    crumbs[0] = { label: "Mapa myšlení", href: null };
    return crumbs;
  }

  const sectionIndex = indexPageByMarkdownPath.get(`${section}/index.md`);
  crumbs.push({
    label: pageTitleForSection(section),
    href: sectionIndex ? relativeLink(page.htmlPath, sectionIndex.htmlPath) : null
  });

  if (basename && basename !== "index.md") {
    crumbs.push({
      label: page.manifestPage.title,
      href: null
    });
  } else {
    crumbs[crumbs.length - 1] = {
      label: page.manifestPage.title,
      href: null
    };
  }

  return crumbs;
}

function renderBreadcrumbs(
  page: SitePageInfo,
  indexPageByMarkdownPath: Map<string, SitePageInfo>,
  siteDir: string
): string {
  return `<nav class="breadcrumbs" aria-label="Breadcrumb">${breadcrumbsForPage(
    page,
    indexPageByMarkdownPath,
    siteDir
  )
    .map((crumb) => {
      if (!crumb.href) {
        return `<span aria-current="page">${escapeHtml(crumb.label)}</span>`;
      }
      return `<a href="${escapeHtml(crumb.href)}">${escapeHtml(crumb.label)}</a>`;
    })
    .join('<span aria-hidden="true">›</span>')}</nav>`;
}

function renderSidebar(
  page: SitePageInfo,
  allPages: SitePageInfo[],
  searchEntries: Array<WikiSearchEntry & { url: string }>,
  siteDir: string,
  hasGraph: boolean
): string {
  const currentSection = activeSection(page.htmlRelativePath);
  const availableTargets = new Set(allPages.map((candidate) => candidate.htmlRelativePath));
  const navItems = [
    { label: "Mapa myšlení", target: "index.html", section: "" },
    { label: "Živý graf", target: "graph/index.html", section: "graph" },
    { label: "Konstelace", target: "atlas/index.html", section: "atlas" },
    { label: "Trajektorie", target: "trajectories/index.html", section: "trajectories" },
    { label: "Inventář myšlenek", target: "thoughts/index.html", section: "thoughts" },
    { label: "Vertikální mapa", target: "indexes/vertical_alignment.html", section: "vertical" },
    { label: "Teze", target: "theses/index.html", section: "theses" },
    { label: "Otázky", target: "questions/index.html", section: "questions" },
    { label: "Témata", target: "themes/index.html", section: "themes" },
    { label: "Tenze", target: "tensions/index.html", section: "tensions" },
    { label: "Vlákna", target: "threads/index.html", section: "threads" },
    { label: "Chronologie", target: "chronology/index.html", section: "chronology" },
    { label: "Reference", target: "references/index.html", section: "references" },
    { label: "Diagnostika", target: "indexes/graph.html", section: "indexes" }
  ].filter((item) =>
    item.target === "graph/index.html" ? hasGraph : availableTargets.has(item.target)
  );

  const activePageCandidates = allPages
    .filter((candidate) => activeSection(candidate.htmlRelativePath) === currentSection)
    .filter((candidate) => currentSection !== "atlas" || !candidate.manifestPage.title.startsWith("Členové ·"))
    .filter((candidate) =>
      !["theses", "questions", "themes", "tensions", "threads", "chronology"].includes(currentSection) ||
      candidate.manifestPage.kind === "index"
    )
    .sort((left, right) => left.manifestPage.title.localeCompare(right.manifestPage.title));
  const activePageLimit = currentSection === "references" ? 14 : 12;
  const activePages = activePageCandidates.slice(0, activePageLimit);
  if (
    activePageCandidates.includes(page) &&
    !activePages.includes(page) &&
    activePages.length > 0
  ) {
    activePages[activePages.length - 1] = page;
  }

  return `
<aside class="site-sidebar">
  <a class="brand" href="${escapeHtml(rootTarget(page.htmlPath, siteDir, "index.html"))}">
    <span class="brand-eyebrow">Second Brain</span>
    <div class="brand-title">Mapa myšlení</div>
    <p class="brand-copy">Konstelace, vývojové trajektorie a jednotlivé myšlenky s dohledatelnými zdroji.</p>
  </a>

  <div class="sidebar-search">
    <input id="site-search" type="search" placeholder="Hledat názvy, shrnutí, typy uzlů..." autocomplete="off" />
    <div id="site-search-results" class="search-results" aria-label="Výsledky hledání"></div>
  </div>

  <div class="sidebar-group">
    <div class="sidebar-heading">Procházet</div>
    <ul class="sidebar-nav">
      ${navItems
        .map((item) => {
          return `<li><a class="${item.section === currentSection && !(item.section === "" && page.htmlRelativePath !== "index.html") ? "is-active" : ""}" href="${escapeHtml(rootTarget(page.htmlPath, siteDir, item.target))}">${escapeHtml(item.label)}</a></li>`;
        })
        .join("")}
    </ul>
  </div>

  <div class="sidebar-group">
    <div class="sidebar-heading">V této sekci</div>
    <ul class="sidebar-links">
      ${activePages
        .map((candidate) => {
          const href = relativeLink(page.htmlPath, candidate.htmlPath);
          return `<li><a class="${candidate.htmlRelativePath === page.htmlRelativePath ? "is-active" : ""}" href="${escapeHtml(href)}">${escapeHtml(candidate.manifestPage.title)}</a></li>`;
        })
        .join("")}
    </ul>
  </div>

  <div class="sidebar-group">
    <div class="sidebar-heading">Vzhled</div>
    <button class="theme-toggle" type="button" data-theme-toggle>Přepnout světlý / tmavý režim</button>
  </div>

  <div class="sidebar-meta">
    ${searchEntries.length} stránek · funguje přímo z lokálních file:// cest
  </div>
</aside>`;
}

function rootTarget(currentHtmlPath: string, siteDir: string, target: string): string {
  return relativeLink(currentHtmlPath, path.join(siteDir, target));
}

function pageKindLabel(kind: WikiManifestPage["kind"]): string {
  if (kind === "constellation") {
    return "Konstelace";
  }
  if (kind === "trajectory") {
    return "Vývojová trajektorie";
  }
  if (kind === "thought") {
    return "Myšlenková stránka";
  }
  if (kind === "reference") {
    return "Reference";
  }
  return "Index";
}

function renderPageHtml(options: {
  page: SitePageInfo;
  markdown: string;
  siteDir: string;
  wikiDir: string;
  allPages: SitePageInfo[];
  indexPageByMarkdownPath: Map<string, SitePageInfo>;
  searchEntries: Array<WikiSearchEntry & { url: string }>;
  wikiMarkdownPaths: Set<string>;
  hasGraph: boolean;
}): string {
  const bodyHtml = markdownToHtml(
    options.markdown,
    options.page.markdownPath,
    options.wikiMarkdownPaths
  );
  const assetCssPath = relativeLink(options.page.htmlPath, path.join(options.siteDir, "assets", "style.css"));
  const assetJsPath = relativeLink(options.page.htmlPath, path.join(options.siteDir, "assets", "app.js"));
  const searchDataJsPath = relativeLink(
    options.page.htmlPath,
    path.join(options.siteDir, "assets", "search-data.js")
  );
  const siteRoot = relativeLink(options.page.htmlPath, options.siteDir) || ".";
  const markdownSourcePath = relativeLink(
    options.page.htmlPath,
    path.join(options.wikiDir, options.page.manifestPage.path)
  );
  const breadcrumbs = renderBreadcrumbs(
    options.page,
    options.indexPageByMarkdownPath,
    options.siteDir
  );
  const kindLabel = pageKindLabel(options.page.manifestPage.kind);

  return `<!DOCTYPE html>
<html lang="cs">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(options.page.manifestPage.title)} · Mapa myšlení</title>
    <meta name="description" content="${escapeHtml(options.page.manifestPage.summary)}" />
    <link rel="stylesheet" href="${escapeHtml(assetCssPath)}" />
  </head>
  <body data-site-root="${escapeHtml(siteRoot)}">
    <div class="site-shell">
      ${renderSidebar(
        options.page,
        options.allPages,
        options.searchEntries,
        options.siteDir,
        options.hasGraph
      )}
      <main class="site-main">
        <div class="page-wrap">
          ${breadcrumbs}
          <div class="page-topbar">
            <span class="pill">${escapeHtml(kindLabel)}</span>
            ${options.page.manifestPage.nodeType ? `<span class="pill">${escapeHtml(TYPE_LABELS[options.page.manifestPage.nodeType] ?? options.page.manifestPage.nodeType)}</span>` : ""}
            <div class="page-actions">
              <a class="action-link" href="${escapeHtml(markdownSourcePath)}">View markdown</a>
            </div>
          </div>
          <section class="page-card">
            <article class="markdown-body">
${bodyHtml}
            </article>
          </section>
          <p class="site-footnote">
            Source markdown: <a href="${escapeHtml(markdownSourcePath)}">${escapeHtml(
              replacePathSeparators(options.page.manifestPage.path)
            )}</a>
          </p>
        </div>
      </main>
    </div>
    <script src="${escapeHtml(searchDataJsPath)}"></script>
    <script src="${escapeHtml(assetJsPath)}"></script>
  </body>
</html>
`;
}

function loadSiteInputs(paths: ProjectPaths): {
  wikiManifest: WikiManifest;
  wikiSearchIndex: WikiSearchEntry[];
} {
  const manifestPath = path.join(paths.wikiIndexesDir, "wiki_manifest.json");
  const searchIndexPath = path.join(paths.wikiIndexesDir, "search_index.json");

  if (!existsSync(manifestPath) || !existsSync(searchIndexPath)) {
    throw new Error(
      `Missing wiki manifest/search index in ${paths.wikiIndexesDir}. Run render-wiki first.`
    );
  }

  return {
    wikiManifest: readJsonFile<WikiManifest>(manifestPath),
    wikiSearchIndex: readJsonFile<WikiSearchEntry[]>(searchIndexPath)
  };
}

/**
 * Render a static HTML site over the generated markdown wiki.
 *
 * The markdown wiki remains the source-of-truth inspection layer. This site is
 * a thin browseable wrapper so the same artifacts open cleanly in a browser.
 */
export function renderValidationSite(
  paths: ProjectPaths,
  options?: {
    refreshWiki?: boolean;
    sourceOutputDir?: string;
    targetOutputDir?: string;
    macroMapPath?: string;
    progress?: ProgressWriter;
  }
): ValidationSiteRenderSummary {
  const progress = new ThrottledProgressReporter(options?.progress);
  const targetPaths = options?.targetOutputDir
    ? withOutputDir(paths, options.targetOutputDir)
    : paths;
  if (options?.refreshWiki) {
    progress.phase("site", "refreshing markdown wiki before HTML build");
    renderValidationWiki(paths, {
      sourceOutputDir: options.sourceOutputDir,
      targetOutputDir: options.targetOutputDir,
      macroMapPath: options.macroMapPath,
      progress: options.progress
    });
  }

  progress.phase("site", "loading wiki manifest and search index");
  const { wikiManifest, wikiSearchIndex } = loadSiteInputs(targetPaths);
  const hasGraph = existsSync(
    path.join(targetPaths.compiledDir, "consolidated_thought_graph.json")
  );
  const pages: SitePageInfo[] = wikiManifest.pages.map((manifestPage) => {
    const markdownPath = path.join(targetPaths.wikiDir, manifestPage.path);
    const htmlPath = path.join(targetPaths.siteDir, manifestPage.path.replace(/\.md$/, ".html"));
    return {
      manifestPage,
      markdownPath,
      htmlPath,
      htmlRelativePath: replacePathSeparators(path.relative(targetPaths.siteDir, htmlPath))
    };
  });
  const indexPageByMarkdownPath = new Map(
    pages
      .filter((page) => page.manifestPage.path.endsWith("/index.md") || page.manifestPage.path === "index.md")
      .map((page) => [page.manifestPage.path, page])
  );
  const wikiMarkdownPaths = new Set(pages.map((page) => path.resolve(page.markdownPath)));

  const siteSearchIndex = wikiSearchIndex
    .map((entry) => ({
      ...entry,
      url: entry.path.replace(/\.md$/, ".html")
    }))
    .sort((left, right) => left.url.localeCompare(right.url));

  rmSync(targetPaths.siteDir, { recursive: true, force: true });

  progress.phase("site", `rendering ${pages.length} HTML pages`);
  for (const page of pages) {
    const markdown = readFileSync(page.markdownPath, "utf8");
    const html = renderPageHtml({
      page,
      markdown,
      siteDir: targetPaths.siteDir,
      wikiDir: targetPaths.wikiDir,
      allPages: pages,
      indexPageByMarkdownPath,
      searchEntries: siteSearchIndex,
      wikiMarkdownPaths,
      hasGraph
    });
    mkdirSync(path.dirname(page.htmlPath), { recursive: true });
    writeFileSync(page.htmlPath, html, "utf8");
  }

  mkdirSync(targetPaths.siteAssetsDir, { recursive: true });
  writeFileSync(path.join(targetPaths.siteAssetsDir, "style.css"), SITE_STYLE.trimStart(), "utf8");
  writeFileSync(path.join(targetPaths.siteAssetsDir, "app.js"), SITE_SCRIPT.trimStart(), "utf8");
  const clientSearchIndex = siteSearchIndex.map((entry) => ({
    title: entry.title,
    url: entry.url,
    kind: pageKindLabel(entry.kind),
    summary: entry.summary,
    nodeType: entry.nodeType ? TYPE_LABELS[entry.nodeType] ?? entry.nodeType : undefined,
    nodeStatus: entry.nodeStatus ? STATUS_LABELS[entry.nodeStatus] ?? entry.nodeStatus : undefined,
    keywords: entry.keywords
  }));
  writeFileSync(
    path.join(targetPaths.siteAssetsDir, "search-data.js"),
    `window.__SECOND_BRAIN_SEARCH__ = ${serializeInlineJson(clientSearchIndex)};\n`,
    "utf8"
  );

  const graphSummary = hasGraph
    ? renderGraphExplorer({
        paths: targetPaths,
        pages: wikiManifest.pages,
        macroMapPath: options?.macroMapPath
      })
    : null;

  const searchIndexPath = path.join(targetPaths.siteDir, "search-index.json");
  const siteManifestPath = path.join(targetPaths.siteDir, "site-manifest.json");
  const siteManifest: ValidationSiteManifest = {
    generatedAt: new Date().toISOString(),
    sourceRunId: wikiManifest.sourceRunId,
    pageCount: pages.length + (graphSummary ? 1 : 0),
    sourceWikiDir: targetPaths.wikiDir,
    sourceWikiManifestPath: path.join(targetPaths.wikiIndexesDir, "wiki_manifest.json"),
    pages: [
      ...pages.map((page) => ({
        title: page.manifestPage.title,
        path: page.htmlRelativePath,
        sourceMarkdownPath: page.manifestPage.path,
        kind: page.manifestPage.kind,
        summary: page.manifestPage.summary
      })),
      ...(graphSummary
        ? [
            {
              title: "Živý graf myšlení",
              path: "graph/index.html",
              sourceMarkdownPath: null,
              kind: "graph" as const,
              summary: "Plynulá interaktivní vizualizace konsolidovaného thought graphu."
            }
          ]
        : [])
    ]
      .sort((left, right) => left.path.localeCompare(right.path))
  };
  writeFileSync(searchIndexPath, `${JSON.stringify(siteSearchIndex, null, 2)}\n`, "utf8");
  writeFileSync(siteManifestPath, `${JSON.stringify(siteManifest, null, 2)}\n`, "utf8");
  const siteIndexesDir = path.join(targetPaths.siteDir, "indexes");
  mkdirSync(siteIndexesDir, { recursive: true });
  writeFileSync(
    path.join(siteIndexesDir, "wiki_manifest.json"),
    `${JSON.stringify(wikiManifest, null, 2)}\n`,
    "utf8"
  );
  writeFileSync(
    path.join(siteIndexesDir, "search_index.json"),
    `${JSON.stringify(wikiSearchIndex, null, 2)}\n`,
    "utf8"
  );

  progress.phase("site", "done");
  return {
    generatedAt: siteManifest.generatedAt,
    sourceRunId: siteManifest.sourceRunId,
    pageCount: siteManifest.pageCount,
    indexPath: path.join(targetPaths.siteDir, "index.html"),
    manifestPath: siteManifestPath,
    searchIndexPath
  };
}
