import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getProjectPaths } from "../system/paths.js";
import { renderGptMarkdownExport } from "./gpt.js";

function writeJson(target: string, payload: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function sourceRef(index: number) {
  return {
    sourceKind: "writing",
    sourcePath: "input/writings/synthetic-garden.txt",
    documentId: "writing:synthetic-garden",
    documentTitle: "Synthetic garden notes",
    locator: `paragraph:${index}`,
    sourceItemId: `paragraph:${index}`
  };
}

function node(
  index: number,
  key: string,
  title: string,
  summary: string,
  nodeType: "question" | "thesis" | "tension"
) {
  return {
    id: `consolidated:${String(index).padStart(4, "0")}:${key}`,
    canonicalKey: key,
    title,
    summary,
    nodeType,
    status: nodeType === "question" ? "unresolved" : "active",
    firstSeen: `2025-0${index}-01T00:00:00.000Z`,
    lastSeen: `2025-0${index}-01T00:00:00.000Z`,
    sourceRefs: [sourceRef(index)],
    relatedNodeIds: [] as string[],
    aliases: [],
    signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
    memberNodeIds: [],
    memberCanonicalKeys: [],
    memberClaimIds: [],
    memberStateIds: [],
    currentStateIds: [],
    memberWorldlineIds: [],
    consolidationReasons: [],
    frameMemberships: []
  };
}

function setupSyntheticFixture(tempRoot: string): ReturnType<typeof getProjectPaths> {
  writeFileSync(path.join(tempRoot, "package.json"), "{}\n", "utf8");
  mkdirSync(path.join(tempRoot, "input"), { recursive: true });
  const paths = getProjectPaths(tempRoot);
  const nodes = [
    node(
      1,
      "shade-planning",
      "Shade determines the planting plan",
      "Measure the hours of direct light before choosing plants for each bed.",
      "thesis"
    ),
    node(
      2,
      "soil-moisture",
      "Water according to soil moisture",
      "A moisture reading is more useful than a fixed daily watering schedule.",
      "thesis"
    ),
    node(
      3,
      "pollinator-corridor",
      "Can a small bed support pollinators?",
      "The notes leave open how small a connected habitat can remain useful.",
      "question"
    )
  ];
  nodes[0]!.relatedNodeIds = [nodes[1]!.id];
  nodes[1]!.relatedNodeIds = [nodes[0]!.id, nodes[2]!.id];
  nodes[2]!.relatedNodeIds = [nodes[1]!.id];

  const graphPath = path.join(paths.compiledDir, "consolidated_thought_graph.json");
  writeJson(graphPath, {
    generatedAt: "2025-04-01T00:00:00.000Z",
    sourceRunId: "synthetic-export-test",
    sourceGraphPath: "output/compiled/thought_graph.json",
    sourceNodeCount: nodes.length,
    sourceEdgeCount: 2,
    nodeCount: nodes.length,
    edgeCount: 2,
    nodes,
    edges: [
      {
        id: "edge:shade-moisture",
        from: nodes[0]!.id,
        to: nodes[1]!.id,
        type: "supports",
        weight: 0.8,
        supportingSourceNodeIds: [],
        supportingEdgeIds: [],
        sourceRelationTypes: ["supports"]
      },
      {
        id: "edge:moisture-pollinators",
        from: nodes[1]!.id,
        to: nodes[2]!.id,
        type: "semantic_related",
        weight: 0.6,
        supportingSourceNodeIds: [],
        supportingEdgeIds: [],
        sourceRelationTypes: ["semantic_related"]
      }
    ]
  });

  const paragraphs = [
    "The north bed receives four hours of direct light. The planting plan should follow that measured constraint rather than a generic catalog recommendation.",
    "Watering should respond to soil moisture. A fixed daily schedule can waste water after rain and still miss unusually dry conditions.",
    "A narrow strip of flowering plants may help pollinators, but the minimum useful size and spacing remain open questions for this small garden."
  ];
  const segments = paragraphs.map((text, index) => ({
    id: `segment:${index + 1}`,
    documentId: "writing:synthetic-garden",
    sourceKind: "writing",
    segmentKind: "writing_paragraph",
    signalKind: "primary",
    authorKind: "self",
    authorLabel: null,
    sequenceIndex: index,
    time: `2025-0${index + 1}-01T00:00:00.000Z`,
    timeUnix: null,
    timePrecision: "day",
    sourcePriority: 0,
    segmentLabel: `Paragraph ${index + 1}`,
    text,
    textPreview: text,
    sourceRef: sourceRef(index + 1)
  }));
  writeJson(path.join(paths.normalizedUnifiedDir, "corpus.json"), {
    generatedAt: "2025-04-01T00:00:00.000Z",
    options: {
      ownerNames: [],
      includeOtherContext: false,
      includeAssistantContext: false,
      includeToolContext: false,
      contextWindow: 0,
      includedSourceKinds: ["writing"]
    },
    documents: [{
      id: "writing:synthetic-garden",
      sourceKind: "writing",
      sourcePath: "input/writings/synthetic-garden.txt",
      slug: "synthetic-garden",
      title: "Synthetic garden notes",
      time: "2025-01-01T00:00:00.000Z",
      timeUnix: null,
      timePrecision: "day",
      sourcePriority: 0,
      primaryText: paragraphs.join("\n\n"),
      contextText: null,
      primarySegmentCount: segments.length,
      contextSegmentCount: 0,
      metadata: {}
    }],
    segments,
    timeline: [],
    primaryTimeline: [],
    stats: {
      documentCount: 1,
      segmentCount: segments.length,
      primarySegmentCount: segments.length,
      contextSegmentCount: 0,
      documentsBySourceKind: { writing: 1, conversation: 0, chat: 0 },
      segmentsBySourceKind: { writing: segments.length, conversation: 0, chat: 0 }
    }
  });

  const constellationId = "macro:synthetic-garden";
  const trajectoryId = "trajectory:adaptive-care";
  const assessments = nodes.map((item, index) => ({
    nodeId: item.id,
    title: item.title,
    nodeType: item.nodeType,
    status: item.status,
    sourceAuthority: "authored",
    salienceScore: 90 - index * 5,
    salienceFactors: {
      authority: 100,
      crossDocument: 0,
      recurrence: 40,
      graphCentrality: 50,
      semanticRole: 70
    },
    documentIds: ["writing:synthetic-garden"],
    writingDocumentIds: ["writing:synthetic-garden"],
    conversationDocumentIds: [],
    chatDocumentIds: []
  }));
  writeJson(path.join(paths.compiledDir, "thought_macro_map.json"), {
    schemaVersion: 1,
    contractVersion: "synthetic-export-test",
    generatedAt: "2025-04-01T00:00:00.000Z",
    model: null,
    reasoningEffort: "medium",
    iterationLabel: "test",
    sourceConsolidatedGraphPath: graphPath,
    sourceConsolidatedGraphHash: "synthetic",
    sourceFrameAlignmentPath: null,
    sourceFrameAlignmentHash: null,
    sourceNodeCount: nodes.length,
    atlas: {
      title: "Urban garden atlas",
      summary: "A synthetic map used only to test the exporter.",
      constellationIds: [constellationId],
      entrypointConstellationIds: [constellationId],
      trajectoryIds: [trajectoryId],
      currentPositionNodeIds: [nodes[1]!.id],
      openQuestionNodeIds: [nodes[2]!.id],
      openTensionNodeIds: []
    },
    constellations: [{
      id: constellationId,
      title: "Urban garden planning",
      summary: "Observation connects light, water, and habitat decisions.",
      rationale: "Each node turns a measured site condition into a planning decision.",
      trajectoryHint: "Move from fixed routines toward observation-led care.",
      atlasRole: "core_direction",
      confidence: 0.9,
      uncertainty: "The habitat threshold remains unknown.",
      salienceScore: 90,
      sourceAuthority: "authored",
      firstSeen: nodes[0]!.firstSeen,
      lastSeen: nodes[2]!.lastSeen,
      documentIds: ["writing:synthetic-garden"],
      memberNodeIds: nodes.map((item) => item.id),
      members: [
        { nodeId: nodes[0]!.id, role: "supporting", currentPosition: false, openQuestion: false, tension: false },
        { nodeId: nodes[1]!.id, role: "core", currentPosition: true, openQuestion: false, tension: false },
        { nodeId: nodes[2]!.id, role: "supporting", currentPosition: false, openQuestion: true, tension: false }
      ],
      evidenceHighlights: [{
        nodeId: nodes[1]!.id,
        title: nodes[1]!.title,
        salienceScore: 90,
        sourceAuthority: "authored",
        documentIds: ["writing:synthetic-garden"]
      }]
    }],
    trajectories: [{
      id: trajectoryId,
      title: "From fixed routines to adaptive care",
      summary: "The notes move from static planning toward observation-led maintenance.",
      constellationIds: [constellationId],
      stages: [
        {
          label: "Measure the site",
          summary: "Begin with available light.",
          nodeIds: [nodes[0]!.id],
          startDate: nodes[0]!.firstSeen,
          endDate: nodes[0]!.lastSeen
        },
        {
          label: "Adapt ongoing care",
          summary: "Use current moisture rather than a fixed schedule.",
          nodeIds: [nodes[1]!.id],
          startDate: nodes[1]!.firstSeen,
          endDate: nodes[1]!.lastSeen
        }
      ],
      currentPositionNodeIds: [nodes[1]!.id],
      openTensionNodeIds: [],
      confidence: 0.85,
      uncertainty: "The notes cover only one season."
    }],
    currentPositions: [{
      nodeId: nodes[1]!.id,
      title: nodes[1]!.title,
      constellationIds: [constellationId],
      salienceScore: 90,
      sourceAuthority: "authored"
    }],
    openQuestions: [{
      nodeId: nodes[2]!.id,
      title: nodes[2]!.title,
      constellationIds: [constellationId],
      salienceScore: 80,
      sourceAuthority: "authored"
    }],
    openTensions: [],
    nodeAssessments: assessments,
    quality: {
      constellationCount: 1,
      trajectoryCount: 1,
      mappedNodeCount: nodes.length,
      mappedNodeShare: 1,
      overlapNodeCount: 0,
      highSalienceNodeCount: nodes.length,
      mappedHighSalienceNodeCount: nodes.length,
      mappedHighSalienceShare: 1,
      authoredNodeCount: nodes.length,
      mappedAuthoredNodeCount: nodes.length,
      mappedAuthoredShare: 1,
      unmappedNodeIds: [],
      unmappedHighSalienceNodeIds: [],
      acceptedUnmappedHighSalienceNodeIds: [],
      unmappedAuthoredNodeIds: [],
      proposalRepairs: [],
      warnings: []
    }
  });
  return paths;
}

test("renderGptMarkdownExport requires a macro map instead of using a hidden taxonomy", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-gpt-missing-map-"));
  try {
    writeFileSync(path.join(tempRoot, "package.json"), "{}\n", "utf8");
    mkdirSync(path.join(tempRoot, "input"), { recursive: true });
    assert.throws(
      () => renderGptMarkdownExport(getProjectPaths(tempRoot)),
      /Missing GPT export input: .*thought_macro_map\.json/
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("renderGptMarkdownExport renders a generic macro-map pack and data-derived Preview prompts", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-gpt-macro-"));
  try {
    const paths = setupSyntheticFixture(tempRoot);
    const summary = renderGptMarkdownExport(paths, {
      budget: {
        maxMarkdownFiles: 10,
        targetMaxBytesPerFile: 80_000,
        hardMaxBytesPerFile: 100_000
      }
    });

    assert.equal(summary.markdownFileCount, 5);
    assert.ok(existsSync(path.join(paths.exportsGptDir, "01_ATLAS_AND_QUERY_ROUTES.md")));
    assert.ok(existsSync(path.join(paths.exportsGptDir, "02_TRAJECTORIES_AND_CURRENT_POSITIONS.md")));
    assert.ok(summary.files.some((file) => file.filename.startsWith("10_CONSTELLATION_URBAN-GARDEN-PLANNING")));
    assert.ok(existsSync(path.join(paths.exportsGptDir, "80_UNMAPPED_THOUGHTS.md")));
    assert.ok(existsSync(path.join(paths.exportsGptDir, "90_SOURCE_EVIDENCE.md")));

    const setup = readFileSync(path.join(paths.exportsGptDir, "00_CUSTOM_GPT_SETUP.txt"), "utf8");
    assert.match(setup, /Urban garden planning/);
    assert.match(setup, /From fixed routines to adaptive care/);
    assert.match(setup, /Can a small bed support pollinators\?/);
    assert.match(setup, /PUBLIC DEMO PLACEHOLDER/);
    assert.match(setup, /original Custom GPT system prompt is intentionally omitted/);
    assert.doesNotMatch(setup, /Nenapodobuj automaticky styl autora archivu\./);

    const audit = JSON.parse(readFileSync(summary.retrievalAuditPath, "utf8")) as {
      caseCount: number;
      results: Array<{ question: string }>;
    };
    assert.ok(audit.caseCount >= 4);
    assert.ok(audit.results.every((result) =>
      /Urban garden planning|From fixed routines to adaptive care|soil moisture|pollinators|Synthetic garden notes/i.test(
        result.question
      )
    ));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
