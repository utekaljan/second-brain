import assert from "node:assert/strict";
import test from "node:test";

import type {
  ConsolidatedThoughtNode,
  ThoughtDocumentFrameArtifact,
  ThoughtNode
} from "../compiler/types.js";
import type { UnifiedCorpus } from "../types/domain.js";
import type { ProjectPaths } from "../system/paths.js";
import { buildDocumentFrameAuditReport } from "./document_frame_audit.js";

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

test("buildDocumentFrameAuditReport flags uncovered and paragraph-like frame patterns", () => {
  const paths = createPaths();
  const corpus: UnifiedCorpus = {
    generatedAt: "2026-04-29T00:00:00.000Z",
    options: {
      ownerNames: [],
      includeOtherContext: true,
      includeAssistantContext: true,
      includeToolContext: false,
      contextWindow: 1,
      includedSourceKinds: ["writing"]
    },
    stats: {
      documentCount: 1,
      segmentCount: 4,
      primarySegmentCount: 4,
      contextSegmentCount: 0,
      documentsBySourceKind: { writing: 1, conversation: 0, chat: 0 },
      segmentsBySourceKind: { writing: 4, conversation: 0, chat: 0 }
    },
    documents: [
      {
        id: "writing:test",
        sourceKind: "writing",
        sourcePath: "/tmp/project/input/writings/test.txt",
        slug: "test",
        title: "Test writing",
        time: "2024-01-01",
        timeUnix: 1,
        timePrecision: "day",
        sourcePriority: 100,
        primaryText: "A\n\nB\n\nC\n\nD",
        contextText: null,
        primarySegmentCount: 4,
        contextSegmentCount: 0,
        metadata: {}
      }
    ],
    segments: [
      1, 2, 3, 4
    ].map((index) => ({
      id: `writing:test:paragraph:${index}`,
      documentId: "writing:test",
      sourceKind: "writing" as const,
      segmentKind: "writing_paragraph" as const,
      signalKind: "primary" as const,
      authorKind: "self" as const,
      authorLabel: null,
      sequenceIndex: index,
      time: "2024-01-01",
      timeUnix: 1,
      timePrecision: "day" as const,
      sourcePriority: 100,
      segmentLabel: `paragraph:${index}`,
      text: `Paragraph ${index}`,
      textPreview: `Paragraph ${index}`,
      sourceRef: {
        sourceKind: "writing",
        sourcePath: "/tmp/project/input/writings/test.txt",
        documentId: "writing:test",
        documentTitle: "Test writing",
        locator: `paragraph:${index}`,
        sourceItemId: `paragraph:${index}`
      }
    })),
    timeline: [1, 2, 3, 4].map((index) => ({
      chronologyIndex: index - 1,
      segmentId: `writing:test:paragraph:${index}`,
      documentId: "writing:test",
      sourceKind: "writing" as const,
      segmentKind: "writing_paragraph" as const,
      signalKind: "primary" as const,
      authorKind: "self" as const,
      documentTitle: "Test writing",
      segmentLabel: `paragraph:${index}`,
      time: "2024-01-01",
      timeUnix: 1,
      timePrecision: "day" as const,
      textPreview: `Paragraph ${index}`
    })),
    primaryTimeline: [1, 2, 3, 4].map((index) => ({
      chronologyIndex: index - 1,
      segmentId: `writing:test:paragraph:${index}`,
      documentId: "writing:test",
      sourceKind: "writing" as const,
      segmentKind: "writing_paragraph" as const,
      signalKind: "primary" as const,
      authorKind: "self" as const,
      documentTitle: "Test writing",
      segmentLabel: `paragraph:${index}`,
      time: "2024-01-01",
      timeUnix: 1,
      timePrecision: "day" as const,
      textPreview: `Paragraph ${index}`
    }))
  };

  const documentFrames: ThoughtDocumentFrameArtifact = {
    generatedAt: "2026-04-29T00:00:00.000Z",
    sourceCorpusPath: "/tmp/project/output/normalized/unified/corpus.json",
    corpusHash: "hash",
    documentCount: 1,
    frameCount: 2,
    subframeCount: 3,
    frames: [
      {
        id: "frame:1",
        documentId: "writing:test",
        sourceKind: "writing",
        label: "Frame one",
        summary: "Frame one",
        scope: "section",
        segmentIds: [
          "writing:test:paragraph:1",
          "writing:test:paragraph:2",
          "writing:test:paragraph:3"
        ],
        startSequenceIndex: 1,
        endSequenceIndex: 3,
        subframeIds: ["subframe:1", "subframe:2", "subframe:3"]
      },
      {
        id: "frame:2",
        documentId: "writing:test",
        sourceKind: "writing",
        label: "Frame two",
        summary: "Frame two",
        scope: "section",
        segmentIds: ["writing:test:paragraph:2"],
        startSequenceIndex: 2,
        endSequenceIndex: 2,
        subframeIds: []
      }
    ],
    subframes: [
      {
        id: "subframe:1",
        frameId: "frame:1",
        documentId: "writing:test",
        sourceKind: "writing",
        label: "Subframe one",
        summary: "Subframe one",
        segmentIds: ["writing:test:paragraph:1"],
        startSequenceIndex: 1,
        endSequenceIndex: 1
      },
      {
        id: "subframe:2",
        frameId: "frame:1",
        documentId: "writing:test",
        sourceKind: "writing",
        label: "Subframe two",
        summary: "Subframe two",
        segmentIds: ["writing:test:paragraph:2"],
        startSequenceIndex: 2,
        endSequenceIndex: 2
      },
      {
        id: "subframe:3",
        frameId: "frame:1",
        documentId: "writing:test",
        sourceKind: "writing",
        label: "Subframe three",
        summary: "Subframe three",
        segmentIds: ["writing:test:paragraph:3"],
        startSequenceIndex: 3,
        endSequenceIndex: 3
      }
    ]
  };

  const thoughtNodes: ThoughtNode[] = [
    {
      id: "thought:test",
      canonicalKey: "test",
      nodeType: "thesis",
      title: "Test",
      summary: "Test",
      status: "active",
      firstSeen: "2024-01-01",
      lastSeen: "2024-01-01",
      currentStateId: null,
      sourceRefs: [],
      evidence: [],
      relatedNodeIds: [],
      signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
      aliases: [],
      frameMemberships: []
    }
  ];

  const consolidatedNodes: ConsolidatedThoughtNode[] = [];

  const report = buildDocumentFrameAuditReport(paths, {
    corpusPath: "/tmp/project/output/normalized/unified/corpus.json",
    corpus,
    documentFramesPath: "/tmp/project/output/compiled/thought_document_frames.json",
    documentFrames,
    thoughtNodesPath: "/tmp/project/output/compiled/thought_nodes.json",
    thoughtNodes,
    consolidatedNodesPath: null,
    consolidatedNodes
  });

  assert.equal(report.summary.documentsWithErrors, 1);
  assert.equal(report.summary.documentsWithWarningsOnly, 0);
  assert.equal(report.documents[0]?.uncoveredSegmentIds.length, 1);
  assert.equal(report.documents[0]?.multiplyAssignedSegmentIds.length, 1);
  assert.ok(
    report.documents[0]?.issues.some((issue) => issue.code === "paragraph_like_subframe_pressure")
  );
});

test("buildDocumentFrameAuditReport audits conversation outlines in primary-turn order", () => {
  const paths = createPaths();
  const segmentIds = [1, 2, 3, 4, 5, 6].map((index) => `conversation:test:turn:user-${index}`);
  const corpus: UnifiedCorpus = {
    generatedAt: "2026-07-10T00:00:00.000Z",
    options: {
      ownerNames: [],
      includeOtherContext: true,
      includeAssistantContext: true,
      includeToolContext: false,
      contextWindow: 1,
      includedSourceKinds: ["conversation"]
    },
    stats: {
      documentCount: 1,
      segmentCount: 6,
      primarySegmentCount: 6,
      contextSegmentCount: 0,
      documentsBySourceKind: { writing: 0, conversation: 1, chat: 0 },
      segmentsBySourceKind: { writing: 0, conversation: 6, chat: 0 }
    },
    documents: [
      {
        id: "conversation:test",
        sourceKind: "conversation",
        sourcePath: "/tmp/project/input/conversations/test.json",
        slug: "test",
        title: "Test conversation",
        time: "2026-01-01",
        timeUnix: 1,
        timePrecision: "second",
        sourcePriority: 80,
        primaryText: "One\nTwo\nThree\nFour\nFive\nSix",
        contextText: null,
        primarySegmentCount: 6,
        contextSegmentCount: 0,
        metadata: {}
      }
    ],
    segments: segmentIds.map((id, index) => ({
      id,
      documentId: "conversation:test",
      sourceKind: "conversation" as const,
      segmentKind: "conversation_user_turn" as const,
      signalKind: "primary" as const,
      authorKind: "self" as const,
      authorLabel: "Alex",
      sequenceIndex: index * 2 + 1,
      time: "2026-01-01",
      timeUnix: 1,
      timePrecision: "second" as const,
      sourcePriority: 80,
      segmentLabel: `turn:user-${index + 1}`,
      text: `Turn ${index + 1}`,
      textPreview: `Turn ${index + 1}`,
      sourceRef: {
        sourceKind: "conversation",
        sourcePath: "/tmp/project/input/conversations/test.json",
        documentId: "conversation:test",
        documentTitle: "Test conversation",
        locator: `turn:user-${index + 1}`,
        sourceItemId: `user-${index + 1}`
      }
    })),
    timeline: segmentIds.map((segmentId, index) => ({
      chronologyIndex: index,
      segmentId,
      documentId: "conversation:test",
      sourceKind: "conversation" as const,
      segmentKind: "conversation_user_turn" as const,
      signalKind: "primary" as const,
      authorKind: "self" as const,
      documentTitle: "Test conversation",
      segmentLabel: `turn:user-${index + 1}`,
      time: "2026-01-01",
      timeUnix: 1,
      timePrecision: "second" as const,
      textPreview: `Turn ${index + 1}`
    })),
    primaryTimeline: segmentIds.map((segmentId, index) => ({
      chronologyIndex: index,
      segmentId,
      documentId: "conversation:test",
      sourceKind: "conversation" as const,
      segmentKind: "conversation_user_turn" as const,
      signalKind: "primary" as const,
      authorKind: "self" as const,
      documentTitle: "Test conversation",
      segmentLabel: `turn:user-${index + 1}`,
      time: "2026-01-01",
      timeUnix: 1,
      timePrecision: "second" as const,
      textPreview: `Turn ${index + 1}`
    }))
  };
  const frameOneId = "frame:conversation:test:01:opening";
  const frameTwoId = "frame:conversation:test:02:development";
  const documentFrames: ThoughtDocumentFrameArtifact = {
    generatedAt: "2026-07-10T00:00:00.000Z",
    sourceCorpusPath: "/tmp/project/output/normalized/unified/corpus.json",
    corpusHash: "hash",
    documentCount: 1,
    frameCount: 2,
    subframeCount: 3,
    frames: [
      {
        id: frameOneId,
        documentId: "conversation:test",
        sourceKind: "conversation",
        label: "Opening",
        summary: "Opening phase",
        scope: "section",
        segmentIds: segmentIds.slice(0, 3),
        startSequenceIndex: 1,
        endSequenceIndex: 5,
        subframeIds: ["subframe:1", "subframe:2", "subframe:3"]
      },
      {
        id: frameTwoId,
        documentId: "conversation:test",
        sourceKind: "conversation",
        label: "Development",
        summary: "Development phase",
        scope: "section",
        segmentIds: segmentIds.slice(3),
        startSequenceIndex: 7,
        endSequenceIndex: 11,
        subframeIds: []
      }
    ],
    subframes: segmentIds.slice(0, 3).map((segmentId, index) => ({
      id: `subframe:${index + 1}`,
      frameId: frameOneId,
      documentId: "conversation:test",
      sourceKind: "conversation" as const,
      label: `Branch ${index + 1}`,
      summary: `Branch ${index + 1}`,
      segmentIds: [segmentId],
      startSequenceIndex: index * 2 + 1,
      endSequenceIndex: index * 2 + 1
    })),
    outlines: [
      {
        id: "outline:conversation:test",
        documentId: "conversation:test",
        sourceKind: "conversation",
        label: "Test conversation",
        summary: "One coherent conversation.",
        frameIds: [frameOneId, frameTwoId],
        steps: [
          {
            frameId: frameOneId,
            orderIndex: 0,
            role: "opening",
            returnsToFrameId: null,
            rationale: "Opens the thread."
          },
          {
            frameId: frameTwoId,
            orderIndex: 1,
            role: "conclusion",
            returnsToFrameId: null,
            rationale: "Concludes the thread."
          }
        ]
      }
    ]
  };
  const thoughtNodes: ThoughtNode[] = [
    {
      id: "thought:conversation",
      canonicalKey: "conversation",
      nodeType: "thread",
      title: "Conversation",
      summary: "Conversation",
      status: "active",
      firstSeen: "2026-01-01",
      lastSeen: "2026-01-01",
      currentStateId: null,
      sourceRefs: [],
      evidence: [],
      relatedNodeIds: [],
      signalBySourceKind: { writing: 0, conversation: 1, chat: 0 },
      aliases: [],
      frameMemberships: [
        {
          documentId: "conversation:test",
          frameId: frameOneId,
          frameLabel: "Opening",
          subframeId: null,
          subframeLabel: null,
          frameRole: "main_claim",
          occurrenceCount: 1
        }
      ]
    }
  ];

  const report = buildDocumentFrameAuditReport(paths, {
    corpusPath: "/tmp/project/output/normalized/unified/corpus.json",
    corpus,
    documentFramesPath: "/tmp/project/output/compiled/thought_document_frames.json",
    documentFrames,
    thoughtNodesPath: "/tmp/project/output/compiled/thought_nodes.json",
    thoughtNodes,
    consolidatedNodesPath: null,
    consolidatedNodes: []
  });

  assert.equal(report.summary.writingDocumentCount, 0);
  assert.equal(report.summary.conversationDocumentCount, 1);
  assert.equal(report.summary.documentsWithErrors, 0);
  assert.equal(report.summary.documentsWithWarningsOnly, 1);
  assert.equal(report.summary.totalOutlines, 1);
  assert.equal(report.summary.granularFramePropagationBySourceKind.conversation.eligibleNodeCount, 1);
  assert.equal(report.summary.granularFramePropagationBySourceKind.conversation.nodesWithMemberships, 1);
  assert.ok(
    !report.documents[0]?.issues.some((issue) => issue.code === "main_frame_non_contiguous")
  );
  assert.ok(
    report.documents[0]?.issues.some(
      (issue) => issue.code === "conversation_turn_like_subframe_pressure"
    )
  );
});
