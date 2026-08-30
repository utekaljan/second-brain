import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConsolidatedThoughtGraph } from "../compiler/types.js";
import type { ThoughtMacroMapArtifact } from "../structure/macro_map.js";
import type { UnifiedCorpus, UnifiedDocument, UnifiedSegment } from "../types/domain.js";
import { getProjectPaths } from "../system/paths.js";
import { renderSourceArchive } from "./source_archive.js";

function makeDocument(
  id: string,
  sourceKind: "writing" | "conversation" | "chat",
  title: string,
  primaryText: string,
  time: string
): UnifiedDocument {
  return {
    id,
    sourceKind,
    sourcePath: `/tmp/${id}.txt`,
    slug: id.replace(/^[^:]+:/, ""),
    title,
    time,
    timeUnix: Date.parse(time),
    timePrecision: sourceKind === "writing" ? "day" : "second",
    sourcePriority: sourceKind === "writing" ? 100 : sourceKind === "conversation" ? 80 : 60,
    primaryText,
    contextText: null,
    primarySegmentCount: 1,
    contextSegmentCount: 0,
    metadata: {}
  };
}

function makeSegment(
  document: UnifiedDocument,
  id: string,
  text: string,
  signalKind: "primary" | "context",
  authorKind: "self" | "assistant" | "other_person"
): UnifiedSegment {
  return {
    id,
    documentId: document.id,
    sourceKind: document.sourceKind,
    segmentKind: document.sourceKind === "writing"
      ? "writing_paragraph"
      : document.sourceKind === "conversation"
        ? signalKind === "primary" ? "conversation_user_turn" : "conversation_assistant_context"
        : signalKind === "primary" ? "chat_owner_message" : "chat_context_message",
    signalKind,
    authorKind,
    authorLabel: authorKind,
    sequenceIndex: signalKind === "primary" ? 1 : 2,
    time: document.time,
    timeUnix: document.timeUnix,
    timePrecision: document.timePrecision,
    sourcePriority: document.sourcePriority,
    segmentLabel: id,
    text,
    textPreview: text,
    sourceRef: {
      sourceKind: document.sourceKind,
      sourcePath: document.sourcePath,
      documentId: document.id,
      documentTitle: document.title,
      locator: document.sourceKind === "writing" ? "paragraph:1" : document.sourceKind === "conversation" ? "turn:1" : "message:1",
      sourceItemId: id
    }
  };
}

function writeJson(target: string, payload: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function setupFixture(tempRoot: string): ReturnType<typeof getProjectPaths> {
  writeFileSync(path.join(tempRoot, "package.json"), "{}\n", "utf8");
  mkdirSync(path.join(tempRoot, "input", "writings"), { recursive: true });
  const paths = getProjectPaths(tempRoot);
  const writing = makeDocument(
    "writing:uvaha",
    "writing",
    "Úvaha",
    "Úvaha\n\nÚplný původní text.",
    "2024-01-01T00:00:00.000Z"
  );
  const conversation = makeDocument(
    "conversation:synthetic-garden",
    "conversation",
    "Example archive conversation",
    "Přesná syntetická formulace o měření půdy.",
    "2024-02-01T12:00:00.000Z"
  );
  const chat = makeDocument(
    "chat:dialog",
    "chat",
    "Ukázkový chat",
    "Syntetická chatová zpráva o zálivce.",
    "2024-03-01T12:00:00.000Z"
  );
  const writingSegment = makeSegment(writing, "writing:uvaha:paragraph:1", "Úplný původní text.", "primary", "self");
  const conversationSegment = makeSegment(conversation, "conversation:synthetic-garden:turn:user", conversation.primaryText, "primary", "self");
  const chatSegment = makeSegment(chat, "chat:dialog:message:self", chat.primaryText, "primary", "self");
  const segments = [
    writingSegment,
    conversationSegment,
    makeSegment(conversation, "conversation:synthetic-garden:turn:assistant", "ODPOVĚĎ ASISTENTA", "context", "assistant"),
    chatSegment,
    makeSegment(chat, "chat:dialog:message:other", "ZPRÁVA JINÉHO ČLOVĚKA", "context", "other_person")
  ];
  const corpus: UnifiedCorpus = {
    generatedAt: "2026-08-14T10:00:00.000Z",
    options: {
      ownerNames: ["Alex"],
      includeOtherContext: true,
      includeAssistantContext: true,
      includeToolContext: false,
      contextWindow: 1,
      includedSourceKinds: ["writing", "conversation", "chat"]
    },
    documents: [writing, conversation, chat],
    segments,
    timeline: [],
    primaryTimeline: [],
    stats: {
      documentCount: 3,
      segmentCount: 5,
      primarySegmentCount: 3,
      contextSegmentCount: 2,
      documentsBySourceKind: { writing: 1, conversation: 1, chat: 1 },
      segmentsBySourceKind: { writing: 1, conversation: 2, chat: 2 }
    }
  };

  const nodeIds = [
    "consolidated:111111111111:uvaha-jako-teze",
    "consolidated:222222222222:presna-formulace",
    "consolidated:333333333333:chatova-otazka"
  ];
  const sourceSegments = [writingSegment, conversationSegment, chatSegment];
  const graph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-08-14T10:01:00.000Z",
    sourceRunId: "fixture",
    sourceGraphPath: "fixture.json",
    sourceNodeCount: 3,
    sourceEdgeCount: 2,
    nodeCount: 3,
    edgeCount: 2,
    nodes: nodeIds.map((id, index) => ({
      id,
      canonicalKey: id.split(":")[2]!,
      title: ["Úvaha jako teze", "Přesná formulace", "Chatová otázka"][index]!,
      summary: [
        "Autorský text formuluje hlavní tezi, ze které další úvaha vychází.",
        "Konverzační formulace rozvíjí původní tezi přesnějším směrem.",
        "Chat ponechává související otázku otevřenou."
      ][index]!,
      nodeType: index === 2 ? "question" : "thesis",
      status: index === 2 ? "unresolved" : "active",
      firstSeen: sourceSegments[index]!.time,
      lastSeen: sourceSegments[index]!.time,
      sourceRefs: [sourceSegments[index]!.sourceRef],
      relatedNodeIds: index === 0 ? [nodeIds[1]!] : index === 1 ? [nodeIds[0]!, nodeIds[2]!] : [nodeIds[1]!],
      aliases: [],
      signalBySourceKind: {
        writing: index === 0 ? 1 : 0,
        conversation: index === 1 ? 1 : 0,
        chat: index === 2 ? 1 : 0
      },
      memberNodeIds: [],
      memberCanonicalKeys: [],
      memberClaimIds: [],
      memberStateIds: [],
      currentStateIds: [],
      memberWorldlineIds: [],
      consolidationReasons: [],
      frameMemberships: []
    })),
    edges: [
      {
        id: "edge:1",
        from: nodeIds[0]!,
        to: nodeIds[1]!,
        type: "supports",
        weight: 0.9,
        supportingSourceNodeIds: [],
        supportingEdgeIds: [],
        sourceRelationTypes: ["supports"]
      },
      {
        id: "edge:2",
        from: nodeIds[1]!,
        to: nodeIds[2]!,
        type: "tensions_with",
        weight: 0.8,
        supportingSourceNodeIds: [],
        supportingEdgeIds: [],
        sourceRelationTypes: ["tensions_with"]
      }
    ]
  };

  const constellationId = "macro:aaaaaaaaaa:hlavni-linie";
  const macroMap: ThoughtMacroMapArtifact = {
    schemaVersion: 1,
    contractVersion: "fixture-v1",
    generatedAt: "2026-08-14T10:02:00.000Z",
    model: "fixture",
    reasoningEffort: "high",
    iterationLabel: "fixture",
    sourceConsolidatedGraphPath: "consolidated_thought_graph.json",
    sourceConsolidatedGraphHash: "fixture",
    sourceNodeCount: 3,
    sourceFrameAlignmentPath: null,
    sourceFrameAlignmentHash: null,
    atlas: {
      title: "Atlas fixture",
      summary: "Atlas spojuje autorskou tezi, její rozvinutí a otevřenou otázku.",
      constellationIds: [constellationId],
      entrypointConstellationIds: [constellationId],
      trajectoryIds: ["trajectory:bbbbbbbbbb:vyvoj"],
      currentPositionNodeIds: [nodeIds[1]!],
      openQuestionNodeIds: [nodeIds[2]!],
      openTensionNodeIds: [nodeIds[2]!]
    },
    constellations: [{
      id: constellationId,
      title: "Hlavní linie",
      summary: "Jedna myšlenková linie napříč třemi zdroji.",
      rationale: "Uzly na sebe přímo navazují.",
      trajectoryHint: "Sledovat otevřenou otázku.",
      atlasRole: "core_direction",
      confidence: 0.9,
      uncertainty: "Otázka zůstává otevřená.",
      salienceScore: 80,
      sourceAuthority: "mixed",
      firstSeen: writing.time,
      lastSeen: chat.time,
      documentIds: [writing.id, conversation.id, chat.id],
      memberNodeIds: nodeIds,
      members: nodeIds.map((nodeId, index) => ({
        nodeId,
        role: index === 0 ? "core" : "supporting",
        currentPosition: index === 1,
        openQuestion: index === 2,
        tension: index === 2
      })),
      evidenceHighlights: [{
        nodeId: nodeIds[0]!,
        title: "Úvaha jako teze",
        salienceScore: 90,
        sourceAuthority: "authored",
        documentIds: [writing.id]
      }]
    }],
    trajectories: [{
      id: "trajectory:bbbbbbbbbb:vyvoj",
      title: "Od teze k otázce",
      summary: "Teze je rozvinuta a následně otevřena otázkou.",
      constellationIds: [constellationId],
      stages: [{
        label: "Teze a rozvinutí",
        summary: "První dvě formulace na sebe navazují.",
        nodeIds: nodeIds.slice(0, 2),
        startDate: writing.time,
        endDate: conversation.time
      }],
      currentPositionNodeIds: [nodeIds[1]!],
      openTensionNodeIds: [nodeIds[2]!],
      confidence: 0.8,
      uncertainty: "Další vývoj není znám."
    }],
    currentPositions: [],
    openQuestions: [],
    openTensions: [],
    nodeAssessments: nodeIds.map((nodeId, index) => ({
      nodeId,
      title: graph.nodes[index]!.title,
      nodeType: graph.nodes[index]!.nodeType,
      status: graph.nodes[index]!.status,
      sourceAuthority: index === 0 ? "authored" : index === 1 ? "conversation" : "chat",
      salienceScore: 90 - index * 10,
      salienceFactors: { authority: 1, crossDocument: 0, recurrence: 0, graphCentrality: 1, semanticRole: 1 },
      documentIds: [sourceSegments[index]!.documentId],
      writingDocumentIds: index === 0 ? [writing.id] : [],
      conversationDocumentIds: index === 1 ? [conversation.id] : [],
      chatDocumentIds: index === 2 ? [chat.id] : []
    })),
    quality: {
      constellationCount: 1,
      trajectoryCount: 1,
      mappedNodeCount: 3,
      mappedNodeShare: 1,
      overlapNodeCount: 0,
      highSalienceNodeCount: 3,
      mappedHighSalienceNodeCount: 3,
      mappedHighSalienceShare: 1,
      authoredNodeCount: 1,
      mappedAuthoredNodeCount: 1,
      mappedAuthoredShare: 1,
      unmappedNodeIds: [],
      unmappedHighSalienceNodeIds: [],
      acceptedUnmappedHighSalienceNodeIds: [],
      unmappedAuthoredNodeIds: [],
      proposalRepairs: [],
      warnings: []
    }
  };

  writeJson(path.join(paths.normalizedUnifiedDir, "corpus.json"), corpus);
  writeJson(path.join(paths.compiledDir, "consolidated_thought_graph.json"), graph);
  writeJson(path.join(paths.compiledDir, "thought_macro_map.json"), macroMap);
  return paths;
}

function sourceId(segmentId: string): string {
  return `S${createHash("sha256").update(segmentId).digest("hex").slice(0, 11)}`;
}

test("renderSourceArchive links the completed semantic graph bidirectionally to complete source text", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-linked-archive-"));
  try {
    const paths = setupFixture(tempRoot);
    const summary = renderSourceArchive(paths);
    const archiveDir = path.join(paths.exportsDir, "source_archive");
    const semantic = readFileSync(path.join(archiveDir, "A_SEMANTIC_MAP.md"), "utf8");
    const sources = readFileSync(path.join(archiveDir, "B_SOURCE_TEXTS.md"), "utf8");
    const instructions = readFileSync(
      path.join(archiveDir, "C_CUSTOM_GPT_INSTRUCTIONS.txt"),
      "utf8"
    );

    assert.equal(summary.markdownFileCount, 2);
    assert.equal(summary.semanticNodeCount, 3);
    assert.equal(summary.semanticEdgeCount, 2);
    assert.equal(summary.graphAnchoredSourceSegmentCount, 3);
    assert.match(semantic, /Atlas spojuje autorskou tezi/);
    assert.match(semantic, /Autorský text formuluje hlavní tezi/);
    assert.match(semantic, /Vazby: podporuje>N222222222222/);
    assert.match(semantic, new RegExp(`Zdroje: ${sourceId("conversation:synthetic-garden:turn:user")}`));
    assert.match(sources, /Úvaha/);
    assert.match(sources, /Úplný původní text\./);
    assert.match(sources, /Přesná syntetická formulace o měření půdy\./);
    assert.match(sources, /Syntetická chatová zpráva o zálivce\./);
    assert.match(sources, /Myšlenky: N222222222222/);
    assert.doesNotMatch(sources, /ODPOVĚĎ ASISTENTA/);
    assert.doesNotMatch(sources, /ZPRÁVA JINÉHO ČLOVĚKA/);
    assert.match(instructions, /PUBLIC DEMO PLACEHOLDER/);
    assert.match(instructions, /original Custom GPT system prompt is intentionally omitted/);
    assert.doesNotMatch(instructions, /A_SEMANTIC_MAP\.md je navigační a interpretační vrstva/);
    assert.doesNotMatch(instructions, /B_SOURCE_TEXTS\.md je zdrojová vrstva/);
    assert.doesNotMatch(instructions, /Shrnutí v mapě je syntéza/);
    assert.doesNotMatch(instructions, /Jsi partner pro práci s uživatelovým myšlenkovým archivem/);
    assert.doesNotMatch(instructions, /osobnost|styl odpovědi/i);

    const manifest = JSON.parse(readFileSync(path.join(archiveDir, "export-manifest.json"), "utf8")) as {
      schemaVersion: string;
      architecture: { callsLlm: boolean; semanticToSourceLink: string };
      completeness: { allConsolidatedNodesRenderedExactlyOnce: boolean; allPrimarySourceSegmentsIndexedExactlyOnce: boolean };
    };
    assert.equal(manifest.schemaVersion, "linked-source-archive-v3");
    assert.equal(manifest.architecture.callsLlm, false);
    assert.equal(manifest.completeness.allConsolidatedNodesRenderedExactlyOnce, true);
    assert.equal(manifest.completeness.allPrimarySourceSegmentsIndexedExactlyOnce, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("renderSourceArchive fails instead of consuming the required two-file reserve", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-linked-archive-budget-"));
  try {
    const paths = setupFixture(tempRoot);
    assert.throws(
      () => renderSourceArchive(paths, {
        budget: {
          targetMaxBytesPerFile: 300,
          hardMaxBytesPerFile: 10_000,
          targetMaxEstimatedTokensPerFile: 100,
          hardMaxEstimatedTokensPerFile: 5_000
        }
      }),
      /does not preserve the required reserve/
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
