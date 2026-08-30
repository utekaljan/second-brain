import assert from "node:assert/strict";
import test from "node:test";

import type {
  ConsolidatedThoughtGraph,
  ConsolidatedThoughtNode,
  ThoughtClaim,
  ThoughtGraph,
  ThoughtNode,
  ThoughtNodeState
} from "../compiler/types.js";
import type { ProjectPaths } from "../system/paths.js";
import type { SourceKind, UnifiedCorpus, UnifiedSegment } from "../types/domain.js";
import { buildRealRunDiagnosticsReport } from "./real_run_diagnostics.js";

function createPaths(): ProjectPaths {
  return {
    root: "/tmp/project",
    inputDir: "/tmp/project/input",
    conversationsDir: "/tmp/project/input/conversations",
    writingsDir: "/tmp/project/input/writings",
    chatsDir: "/tmp/project/input/chats",
    outputDir: "/tmp/project/output",
    normalizedDir: "/tmp/project/output/normalized",
    compiledDir: "/tmp/project/output/compiled",
    normalizedConversationsDir: "/tmp/project/output/normalized/conversations",
    normalizedWritingsDir: "/tmp/project/output/normalized/writings",
    normalizedChatsDir: "/tmp/project/output/normalized/chats",
    normalizedUnifiedDir: "/tmp/project/output/normalized/unified",
    manifestsDir: "/tmp/project/output/manifests",
    wikiDir: "/tmp/project/output/wiki",
    wikiThoughtsDir: "/tmp/project/output/wiki/thoughts",
    wikiQuestionsDir: "/tmp/project/output/wiki/questions",
    wikiThesesDir: "/tmp/project/output/wiki/theses",
    wikiThreadsDir: "/tmp/project/output/wiki/threads",
    wikiThemesDir: "/tmp/project/output/wiki/themes",
    wikiTensionsDir: "/tmp/project/output/wiki/tensions",
    wikiChronologyDir: "/tmp/project/output/wiki/chronology",
    wikiReferencesDir: "/tmp/project/output/wiki/references",
    wikiIndexesDir: "/tmp/project/output/wiki/indexes",
    exportsDir: "/tmp/project/output/exports",
    exportsMergedDir: "/tmp/project/output/exports/merged",
    exportsGptDir: "/tmp/project/output/exports/gpt",
    siteDir: "/tmp/project/output/site",
    siteAssetsDir: "/tmp/project/output/site/assets",
    stateDir: "/tmp/project/output/state",
    stateRunsDir: "/tmp/project/output/state/runs",
    stateHashesDir: "/tmp/project/output/state/hashes",
    stateCheckpointsDir: "/tmp/project/output/state/checkpoints",
    stateAuditsDir: "/tmp/project/output/state/audits"
  };
}

function createSegment(id: string, documentId: string, sourceKind: SourceKind): UnifiedSegment {
  return {
    id,
    documentId,
    sourceKind,
    segmentKind: sourceKind === "writing" ? "writing_paragraph" : "conversation_user_turn",
    signalKind: "primary",
    authorKind: "self",
    authorLabel: "Alex",
    sequenceIndex: 1,
    time: "2026-01-01T00:00:00.000Z",
    timeUnix: 1,
    timePrecision: "second",
    sourcePriority: sourceKind === "writing" ? 100 : 80,
    segmentLabel: "segment:1",
    text: `Meaningful ${sourceKind} segment`,
    textPreview: `Meaningful ${sourceKind} segment`,
    sourceRef: {
      sourceKind,
      sourcePath: `/input/${sourceKind}.txt`,
      documentId,
      documentTitle: documentId,
      locator: "segment:1",
      sourceItemId: "segment:1"
    }
  };
}

function createCorpus(): UnifiedCorpus {
  const segments = [
    createSegment("writing:test:paragraph:1", "writing:test", "writing"),
    createSegment("conversation:test:turn:1", "conversation:test", "conversation")
  ];
  const documents = segments.map((segment) => ({
    id: segment.documentId,
    sourceKind: segment.sourceKind,
    sourcePath: segment.sourceRef.sourcePath,
    slug: segment.documentId,
    title: segment.documentId,
    time: segment.time,
    timeUnix: segment.timeUnix,
    timePrecision: segment.timePrecision,
    sourcePriority: segment.sourcePriority,
    primaryText: segment.text,
    contextText: null,
    primarySegmentCount: 1,
    contextSegmentCount: 0,
    metadata: {}
  }));
  const timeline = segments.map((segment, index) => ({
    chronologyIndex: index,
    segmentId: segment.id,
    documentId: segment.documentId,
    sourceKind: segment.sourceKind,
    segmentKind: segment.segmentKind,
    signalKind: segment.signalKind,
    authorKind: segment.authorKind,
    documentTitle: segment.documentId,
    segmentLabel: segment.segmentLabel,
    time: segment.time,
    timeUnix: segment.timeUnix,
    timePrecision: segment.timePrecision,
    textPreview: segment.textPreview
  }));
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    options: {
      ownerNames: ["Alex"],
      includeOtherContext: true,
      includeAssistantContext: true,
      includeToolContext: false,
      contextWindow: 1,
      includedSourceKinds: ["writing", "conversation"]
    },
    documents,
    segments,
    timeline,
    primaryTimeline: timeline,
    stats: {
      documentCount: 2,
      segmentCount: 2,
      primarySegmentCount: 2,
      contextSegmentCount: 0,
      documentsBySourceKind: { writing: 1, conversation: 1, chat: 0 },
      segmentsBySourceKind: { writing: 1, conversation: 1, chat: 0 }
    }
  };
}

function createThoughtNode(id: string, sourceKind: SourceKind): ThoughtNode {
  return {
    id,
    canonicalKey: id,
    nodeType: "thesis",
    title: id,
    summary: id,
    status: "active",
    firstSeen: "2026-01-01",
    lastSeen: "2026-01-01",
    currentStateId: null,
    sourceRefs: [],
    evidence: [],
    relatedNodeIds: [],
    signalBySourceKind: {
      writing: sourceKind === "writing" ? 1 : 0,
      conversation: sourceKind === "conversation" ? 1 : 0,
      chat: 0
    },
    aliases: []
  };
}

function createConsolidatedNode(options: {
  id: string;
  title: string;
  sourceKind: SourceKind;
  memberNodeIds: string[];
}): ConsolidatedThoughtNode {
  const documentId = `${options.sourceKind}:test`;
  return {
    id: options.id,
    canonicalKey: options.id,
    title: options.title,
    summary: options.title,
    nodeType: "thesis",
    status: "active",
    firstSeen: "2026-01-01",
    lastSeen: "2026-01-01",
    sourceRefs: [
      {
        sourceKind: options.sourceKind,
        sourcePath: `/input/${options.sourceKind}.txt`,
        documentId,
        documentTitle: documentId,
        locator: "segment:1",
        sourceItemId: "segment:1"
      }
    ],
    relatedNodeIds: [],
    aliases: [],
    signalBySourceKind: {
      writing: options.sourceKind === "writing" ? 1 : 0,
      conversation: options.sourceKind === "conversation" ? 1 : 0,
      chat: 0
    },
    memberNodeIds: options.memberNodeIds,
    memberCanonicalKeys: options.memberNodeIds,
    memberClaimIds: [],
    memberStateIds: [],
    currentStateIds: [],
    memberWorldlineIds: [],
    consolidationReasons: []
  };
}

test("buildRealRunDiagnosticsReport reports provenance and inspectable quality signals", () => {
  const thoughtNodes = [
    createThoughtNode("thought:writing", "writing"),
    createThoughtNode("thought:conversation-a", "conversation"),
    createThoughtNode("thought:conversation-b", "conversation")
  ];
  const consolidatedNodes = [
    createConsolidatedNode({
      id: "consolidated:writing",
      title: "Kalibrace senzoru vlhkosti",
      sourceKind: "writing",
      memberNodeIds: ["thought:writing"]
    }),
    createConsolidatedNode({
      id: "consolidated:conversation-a",
      title: "Kalibrace senzoru vlhkosti půdy",
      sourceKind: "conversation",
      memberNodeIds: ["thought:conversation-a"]
    }),
    createConsolidatedNode({
      id: "consolidated:conversation-merge",
      title: "Téma",
      sourceKind: "conversation",
      memberNodeIds: ["thought:conversation-a", "thought:conversation-b"]
    })
  ];
  const thoughtGraph = {
    nodeCount: thoughtNodes.length,
    edgeCount: 0,
    nodes: thoughtNodes,
    edges: []
  } as unknown as ThoughtGraph;
  const consolidatedGraph = {
    nodeCount: consolidatedNodes.length,
    edgeCount: 2,
    nodes: consolidatedNodes,
    edges: [
      { id: "edge:1", from: consolidatedNodes[0]!.id, to: consolidatedNodes[1]!.id },
      { id: "edge:2", from: consolidatedNodes[0]!.id, to: consolidatedNodes[2]!.id }
    ]
  } as unknown as ConsolidatedThoughtGraph;
  const claims = [
    {
      id: "claim:writing",
      nodeId: "thought:writing",
      inputId: "writing:test:paragraph:1"
    }
  ] as ThoughtClaim[];
  const nodeStates = [
    { id: "state:writing", nodeId: "thought:writing" },
    { id: "state:conversation-a", nodeId: "thought:conversation-a" },
    { id: "state:conversation-b", nodeId: "thought:conversation-b" }
  ] as ThoughtNodeState[];

  const report = buildRealRunDiagnosticsReport(createPaths(), {
    corpus: createCorpus(),
    documentFrames: null,
    thoughtGraph,
    consolidatedGraph,
    claims,
    nodeStates,
    compileManifest: {
      status: "completed",
      incremental: {
        mode: "incremental_cache",
        reusePolicy: "mixed",
        semanticItems: {
          totalPrimarySegmentCount: 2,
          reusedCount: 1,
          newCount: 1
        }
      }
    },
    consolidationDiagnostics: {
      mode: "incremental",
      recommendation: {
        broaderPathUsed: false,
        broaderConsolidationRerunRecommended: false,
        reasons: []
      }
    },
    affectedScope: { mode: "incremental", fallbackMode: "none", fallbackReasons: [], stats: {} },
    frameAuditSummary: { documentsWithErrors: 0, documentsWithWarningsOnly: 0 },
    conversationTurnAuditSummary: { suspiciousRemainingTurnCount: 0, passing: true },
    gptExportManifest: null
  });

  assert.equal(report.provenance.anchoredPrimarySegmentCount, 1);
  assert.equal(report.provenance.coverageShare, 0.5);
  assert.equal(report.attention.level, "watch");
  assert.equal(report.graph.consolidated.componentCount, 1);
  assert.ok(report.qualitySignals.nearDuplicateTitles.length >= 1);
  assert.equal(report.qualitySignals.conversationOnlyOneOffs.length, 1);
  assert.equal(report.qualitySignals.weakProvenanceMerges.length, 1);
});
