import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { getProjectPaths } from "../system/paths.js";
import { renderValidationSite } from "./site.js";

function writeText(target: string, contents: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function writeJson(target: string, payload: unknown): void {
  writeText(target, `${JSON.stringify(payload, null, 2)}\n`);
}

test("renderValidationSite builds a browser-openable HTML layer over the markdown wiki", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-site-"));

  try {
    writeText(path.join(tempRoot, "package.json"), "{}\n");
    mkdirSync(path.join(tempRoot, "input", "writings"), { recursive: true });

    const paths = getProjectPaths(tempRoot);

    writeText(
      path.join(paths.wikiDir, "index.md"),
      [
        "# Validation Wiki",
        "",
        "Open the [Senzory jako vrstva](theses/senzory-jako-vrstva.md) page.",
        "",
        "- [Consolidated graph](../compiled/consolidated_thought_graph.json)",
        "",
        "| Section | Count |",
        "| --- | --- |",
        "| Thoughts | 1 |"
      ].join("\n")
    );
    writeText(
      path.join(paths.wikiThoughtsDir, "index.md"),
      ["# All Thoughts", "", "- [Senzory jako vrstva](../theses/senzory-jako-vrstva.md)"].join("\n")
    );
    writeText(
      path.join(paths.wikiThesesDir, "index.md"),
      ["# Theses", "", "- [Senzory jako vrstva](senzory-jako-vrstva.md)"].join("\n")
    );
    writeText(
      path.join(paths.wikiThesesDir, "senzory-jako-vrstva.md"),
      [
        "# Senzory jako vrstva",
        "",
        "Senzory tvoří řídicí vrstvu skleníku.",
        "",
        "## Evidence",
        "",
        "- Primární formulace: [Senzory jako vrstva](../references/writing-writing-senzory-vrstva.md#ref-paragraph-1)",
        "- Alias: `Senzory jako nová řídicí vrstva`",
        "- Chybějící příloha: [nedodaný soubor](missing-attachment.md)",
        "",
        "## Senzory jako vrstva",
        "",
        "> První řádek metadat",
        "> Druhý řádek metadat",
        "",
        "## Connections",
        "",
        "1. [Graph diagnostics](../indexes/graph.md)",
        "",
        "## Appendix: Evidence a audit",
        "",
        "Compiler detail."
      ].join("\n")
    );
    writeText(
      path.join(paths.wikiReferencesDir, "index.md"),
      ["# References", "", "- [Senzory jako vrstva](writing-writing-senzory-vrstva.md)"].join("\n")
    );
    writeText(
      path.join(paths.wikiReferencesDir, "writing-writing-senzory-vrstva.md"),
      [
        "# Reference · Senzory jako vrstva",
        "",
        '<a id="ref-paragraph-1"></a>',
        "## paragraph:1",
        "",
        "> Senzory tvoří novou řídicí vrstvu skleníku.",
        "",
        "Related: [Senzory jako vrstva](../theses/senzory-jako-vrstva.md)"
      ].join("\n")
    );
    writeText(
      path.join(paths.wikiIndexesDir, "graph.md"),
      [
        "# Graph diagnostics",
        "",
        "| Metric | Value |",
        "| --- | --- |",
        "| Nodes | 1 |",
        "| Edges | 0 |"
      ].join("\n")
    );

    writeJson(path.join(paths.wikiIndexesDir, "wiki_manifest.json"), {
      generatedAt: "2026-04-22T12:00:00.000Z",
      sourceRunId: "thought-compiler-test",
      sourceCorpusPath: path.join(tempRoot, "output", "normalized", "unified", "corpus.json"),
      sourceGraphPath: path.join(tempRoot, "output", "compiled", "consolidated_thought_graph.json"),
      pageCount: 7,
      thoughtPageCount: 1,
      referencePageCount: 1,
      indexPageCount: 5,
      pages: [
        {
          title: "Validation Wiki",
          path: "index.md",
          kind: "index",
          summary: "Root validation wiki index."
        },
        {
          title: "All Thoughts",
          path: "thoughts/index.md",
          kind: "index",
          summary: "Master index of rendered thought pages."
        },
        {
          title: "Theses",
          path: "theses/index.md",
          kind: "index",
          summary: "Browse thesis pages."
        },
        {
          title: "Senzory jako vrstva",
          path: "theses/senzory-jako-vrstva.md",
          kind: "thought",
          summary: "Senzory tvoří řídicí vrstvu skleníku.",
          nodeType: "thesis",
          nodeId: "consolidated:0001:senzory-jako-vrstva"
        },
        {
          title: "References",
          path: "references/index.md",
          kind: "index",
          summary: "Document-level source references."
        },
        {
          title: "Reference · Senzory jako vrstva",
          path: "references/writing-writing-senzory-vrstva.md",
          kind: "reference",
          summary: "Source excerpts for Senzory jako vrstva.",
          documentId: "writing:senzory-vrstva"
        },
        {
          title: "Graph diagnostics",
          path: "indexes/graph.md",
          kind: "index",
          summary: "Graph-level diagnostics and counts."
        }
      ]
    });
    writeJson(path.join(paths.wikiIndexesDir, "search_index.json"), [
      {
        id: "index-root",
        title: "Validation Wiki",
        path: "index.md",
        kind: "index",
        summary: "Root validation wiki index.",
        keywords: ["validation", "wiki", "index"]
      },
      {
        id: "consolidated:0001:senzory-jako-vrstva",
        title: "Senzory jako vrstva",
        path: "theses/senzory-jako-vrstva.md",
        kind: "thought",
        summary: "Senzory tvoří řídicí vrstvu skleníku.",
        nodeType: "thesis",
        nodeStatus: "active",
        aliases: ["Senzory jako nová řídicí vrstva"],
        keywords: ["senzory", "vrstva", "sklenik"]
      },
      {
        id: "writing:senzory-vrstva",
        title: "Reference · Senzory jako vrstva",
        path: "references/writing-writing-senzory-vrstva.md",
        kind: "reference",
        summary: "Source excerpts for Senzory jako vrstva.",
        documentId: "writing:senzory-vrstva",
        keywords: ["writing", "reference", "source"]
      }
    ]);
    writeJson(path.join(paths.compiledDir, "consolidated_thought_graph.json"), {
      generatedAt: "2026-04-22T12:00:00.000Z",
      sourceRunId: "thought-compiler-test",
      sourceGraphPath: path.join(paths.compiledDir, "thought_graph.json"),
      sourceNodeCount: 1,
      sourceEdgeCount: 0,
      nodeCount: 1,
      edgeCount: 0,
      nodes: [
        {
          id: "consolidated:0001:senzory-jako-vrstva",
          canonicalKey: "senzory-jako-vrstva",
          title: "Senzory jako vrstva",
          summary: "Senzory tvoří řídicí vrstvu skleníku.",
          nodeType: "thesis",
          status: "active",
          firstSeen: "2026-04-22T12:00:00.000Z",
          lastSeen: "2026-04-22T12:00:00.000Z",
          sourceRefs: [],
          relatedNodeIds: [],
          aliases: [],
          signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
          memberNodeIds: ["thought:senzory-jako-vrstva"],
          memberCanonicalKeys: ["senzory-jako-vrstva"],
          memberClaimIds: [],
          memberStateIds: [],
          currentStateIds: [],
          memberWorldlineIds: [],
          consolidationReasons: ["single_node"]
        }
      ],
      edges: []
    });

    const summary = renderValidationSite(paths);

    assert.equal(summary.pageCount, 8);
    assert.ok(existsSync(summary.indexPath));
    assert.ok(existsSync(summary.manifestPath));
    assert.ok(existsSync(summary.searchIndexPath));
    assert.ok(existsSync(path.join(paths.siteAssetsDir, "style.css")));
    assert.ok(existsSync(path.join(paths.siteAssetsDir, "app.js")));
    assert.ok(existsSync(path.join(paths.siteAssetsDir, "search-data.js")));
    assert.ok(existsSync(path.join(paths.siteAssetsDir, "graph-app.js")));
    assert.ok(existsSync(path.join(paths.siteAssetsDir, "graph-data.js")));
    assert.ok(existsSync(path.join(paths.siteAssetsDir, "graph.css")));
    assert.ok(existsSync(path.join(paths.siteDir, "graph", "index.html")));

    const rootHtml = readFileSync(summary.indexPath, "utf8");
    assert.match(rootHtml, /<table>/);
    assert.match(rootHtml, /theses\/senzory-jako-vrstva\.html/);
    assert.match(rootHtml, /graph\/index\.html/);
    assert.match(rootHtml, /href="\.\.\/compiled\/consolidated_thought_graph\.json"/);
    assert.doesNotMatch(rootHtml, /consolidated<em>thought<\/em>graph/);

    const thesisHtmlPath = path.join(paths.siteDir, "theses", "senzory-jako-vrstva.html");
    const thesisHtml = readFileSync(thesisHtmlPath, "utf8");
    assert.match(thesisHtml, /Mapa myšlení/);
    assert.match(thesisHtml, /View markdown/);
    assert.match(thesisHtml, /\.\.\/references\/writing-writing-senzory-vrstva\.html#ref-paragraph-1/);
    assert.match(thesisHtml, /<code>Senzory jako nová řídicí vrstva<\/code>/);
    assert.match(thesisHtml, /id="senzory-jako-vrstva-2"/);
    assert.match(thesisHtml, /class="unavailable-link"[^>]*>nedodaný soubor<\/span>/);
    assert.match(thesisHtml, /První řádek metadat<br>Druhý řádek metadat/);
    assert.match(thesisHtml, /assets\/search-data\.js/);
    assert.doesNotMatch(thesisHtml, /site-search-data/);
    assert.doesNotMatch(thesisHtml, /page-summary/);
    assert.match(thesisHtml, /<details class="audit-appendix">/);
    assert.match(thesisHtml, /<summary>Appendix: Evidence a audit<\/summary>/);

    const searchDataScript = readFileSync(
      path.join(paths.siteAssetsDir, "search-data.js"),
      "utf8"
    );
    assert.match(searchDataScript, /"url":"theses\/senzory-jako-vrstva\.html"/);

    const graphHtml = readFileSync(path.join(paths.siteDir, "graph", "index.html"), "utf8");
    assert.match(graphHtml, /id="thought-graph"/);
    assert.match(graphHtml, /assets\/graph-data\.js/);
    assert.match(graphHtml, /assets\/graph-app\.js/);
    const graphDataScript = readFileSync(
      path.join(paths.siteAssetsDir, "graph-data.js"),
      "utf8"
    );
    assert.match(graphDataScript, /consolidated:0001:senzory-jako-vrstva/);
    assert.match(graphDataScript, /\.\.\/theses\/senzory-jako-vrstva\.html/);

    const referenceHtml = readFileSync(
      path.join(paths.siteDir, "references", "writing-writing-senzory-vrstva.html"),
      "utf8"
    );
    assert.match(referenceHtml, /id="ref-paragraph-1"/);
    assert.match(referenceHtml, /\.\.\/theses\/senzory-jako-vrstva\.html/);

    const siteManifest = JSON.parse(readFileSync(summary.manifestPath, "utf8")) as {
      pageCount: number;
      pages: Array<{ path: string; sourceMarkdownPath: string | null; kind: string }>;
    };
    assert.equal(siteManifest.pageCount, 8);
    assert.ok(
      siteManifest.pages.some(
        (page) =>
          page.path === "theses/senzory-jako-vrstva.html" &&
          page.sourceMarkdownPath === "theses/senzory-jako-vrstva.md"
      )
    );
    assert.ok(
      siteManifest.pages.some(
        (page) =>
          page.path === "graph/index.html" &&
          page.sourceMarkdownPath === null &&
          page.kind === "graph"
      )
    );

    const siteSearchIndex = JSON.parse(readFileSync(summary.searchIndexPath, "utf8")) as Array<{
      path: string;
      url?: string;
    }>;
    assert.ok(
      siteSearchIndex.some(
        (entry) =>
          entry.path === "theses/senzory-jako-vrstva.md" &&
          entry.url === "theses/senzory-jako-vrstva.html"
      )
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
