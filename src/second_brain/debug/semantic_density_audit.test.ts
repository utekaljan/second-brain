import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getProjectPaths } from "../system/paths.js";
import type { ThoughtClaim } from "../compiler/types.js";
import type { UnifiedCorpus, UnifiedSegment } from "../types/domain.js";
import { runSemanticDensityAudit } from "./semantic_density_audit.js";

function createCorpus(): UnifiedCorpus {
  const segments: UnifiedSegment[] = Array.from({ length: 3 }, (_, index) => {
    const itemNumber = index + 1;
    const text =
      "Tento authored odstavec obsahuje hlavni tezi, druhou vrstvu napeti a vyvojovou korekci, aby byl dost dlouhy pro density audit a nemohl byt legitimne zplosten do jedne obecne poznamky. Zaroven pridava dalsi formulaci otazky, prakticky dusledek a zpetnou revizi puvodniho postoje.";
    return {
      id: `writing:test:paragraph:${itemNumber}`,
      documentId: "writing:test",
      sourceKind: "writing",
      segmentKind: "writing_paragraph",
      signalKind: "primary",
      authorKind: "self",
      authorLabel: "self",
      sequenceIndex: itemNumber,
      time: "2026-01-01T00:00:00.000Z",
      timeUnix: Date.parse("2026-01-01T00:00:00.000Z"),
      timePrecision: "day",
      sourcePriority: 100,
      segmentLabel: `Paragraph ${itemNumber}`,
      text,
      textPreview: text,
      sourceRef: {
        sourceKind: "writing",
        sourcePath: "/tmp/test.txt",
        documentId: "writing:test",
        documentTitle: "Test",
        locator: `paragraph:${itemNumber}`,
        sourceItemId: `paragraph:${itemNumber}`
      }
    };
  });

  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    options: {
      ownerNames: ["Alex"],
      includeOtherContext: true,
      includeAssistantContext: true,
      includeToolContext: false,
      contextWindow: 1,
      includedSourceKinds: ["writing", "conversation", "chat"]
    },
    documents: [
      {
        id: "writing:test",
        sourceKind: "writing",
        sourcePath: "/tmp/test.txt",
        slug: "test",
        title: "Test",
        time: "2026-01-01T00:00:00.000Z",
        timeUnix: Date.parse("2026-01-01T00:00:00.000Z"),
        timePrecision: "day",
        sourcePriority: 100,
        primaryText: segments.map((segment) => segment.text).join("\n\n"),
        contextText: null,
        primarySegmentCount: segments.length,
        contextSegmentCount: 0,
        metadata: {
          fileLabel: "test",
          wordCount: 90
        }
      }
    ],
    segments,
    timeline: segments.map((segment, index) => ({
      chronologyIndex: index,
      segmentId: segment.id,
      documentId: segment.documentId,
      sourceKind: segment.sourceKind,
      segmentKind: segment.segmentKind,
      signalKind: segment.signalKind,
      authorKind: segment.authorKind,
      documentTitle: "Test",
      segmentLabel: segment.segmentLabel,
      time: segment.time,
      timeUnix: segment.timeUnix,
      timePrecision: segment.timePrecision,
      textPreview: segment.textPreview
    })),
    primaryTimeline: segments.map((segment, index) => ({
      chronologyIndex: index,
      segmentId: segment.id,
      documentId: segment.documentId,
      sourceKind: segment.sourceKind,
      segmentKind: segment.segmentKind,
      signalKind: segment.signalKind,
      authorKind: segment.authorKind,
      documentTitle: "Test",
      segmentLabel: segment.segmentLabel,
      time: segment.time,
      timeUnix: segment.timeUnix,
      timePrecision: segment.timePrecision,
      textPreview: segment.textPreview
    })),
    stats: {
      documentCount: 1,
      segmentCount: segments.length,
      primarySegmentCount: segments.length,
      contextSegmentCount: 0,
      documentsBySourceKind: {
        writing: 1,
        conversation: 0,
        chat: 0
      },
      segmentsBySourceKind: {
        writing: segments.length,
        conversation: 0,
        chat: 0
      }
    }
  };
}

function claimsPerSegment(count: number): ThoughtClaim[] {
  return Array.from({ length: 3 }).flatMap((_, segmentIndex) =>
    Array.from({ length: count }).map((__, claimIndex) => {
      const itemNumber = segmentIndex + 1;
      const claimNumber = claimIndex + 1;
      return {
        id: `claim:test-${itemNumber}-${claimNumber}`,
        nodeId: `thought:test-${itemNumber}-${claimNumber}`,
        canonicalKey: `test-${itemNumber}-${claimNumber}`,
        inputId: `writing:test:paragraph:${itemNumber}`,
        batchId: "batch-0001",
        chronologyIndex: segmentIndex,
        time: "2026-01-01T00:00:00.000Z",
        sourceKind: "writing",
        nodeType: "thesis",
        status: "active",
        title: `Test ${itemNumber}.${claimNumber}`,
        summary: "Summary",
        claim: "Claim",
        rationale: "Rationale",
        documentFrameId: null,
        documentSubframeId: null,
        frameRole: null,
        relatedCanonicalKeys: [],
        sourceRef: {
          sourceKind: "writing",
          sourcePath: "/tmp/test.txt",
          documentId: "writing:test",
          documentTitle: "Test",
          locator: `paragraph:${itemNumber}`,
          sourceItemId: `paragraph:${itemNumber}`
        },
        relationProposals: []
      } satisfies ThoughtClaim;
    })
  );
}

function createLongConversationCorpus(): UnifiedCorpus {
  const base = createCorpus();
  const longText = `${base.segments[0]!.text} ${base.segments[0]!.text} ${base.segments[0]!.text}`;
  const segments: UnifiedSegment[] = Array.from({ length: 4 }, (_, index) => {
    const itemNumber = index + 1;
    return {
      ...base.segments[0]!,
      id: `conversation:test:turn:${itemNumber}`,
      documentId: "conversation:test",
      sourceKind: "conversation",
      segmentKind: "conversation_user_turn",
      sequenceIndex: itemNumber,
      sourcePriority: 50,
      segmentLabel: `User turn ${itemNumber}`,
      text: longText,
      textPreview: longText,
      sourceRef: {
        sourceKind: "conversation",
        sourcePath: "/tmp/conversations.json",
        documentId: "conversation:test",
        documentTitle: "Test Conversation",
        locator: `turn:${itemNumber}`,
        sourceItemId: `turn:${itemNumber}`,
        conversationId: "test",
        bundleName: "conversations.json",
        turnId: String(itemNumber)
      }
    };
  });
  const timeline = segments.map((segment, index) => ({
    chronologyIndex: index,
    segmentId: segment.id,
    documentId: segment.documentId,
    sourceKind: segment.sourceKind,
    segmentKind: segment.segmentKind,
    signalKind: segment.signalKind,
    authorKind: segment.authorKind,
    documentTitle: "Test Conversation",
    segmentLabel: segment.segmentLabel,
    time: segment.time,
    timeUnix: segment.timeUnix,
    timePrecision: segment.timePrecision,
    textPreview: segment.textPreview
  }));

  return {
    ...base,
    segments,
    timeline,
    primaryTimeline: timeline,
    stats: {
      ...base.stats,
      documentCount: 1,
      segmentCount: segments.length,
      primarySegmentCount: segments.length,
      documentsBySourceKind: { writing: 0, conversation: 1, chat: 0 },
      segmentsBySourceKind: { writing: 0, conversation: segments.length, chat: 0 }
    }
  };
}

function conversationClaimsPerSegment(): ThoughtClaim[] {
  return Array.from({ length: 4 }, (_, index) => {
    const itemNumber = index + 1;
    return {
      ...claimsPerSegment(1)[0]!,
      id: `claim:conversation-${itemNumber}`,
      nodeId: `thought:conversation-${itemNumber}`,
      canonicalKey: `conversation-${itemNumber}`,
      inputId: `conversation:test:turn:${itemNumber}`,
      chronologyIndex: index,
      sourceKind: "conversation",
      title: `Conversation ${itemNumber}`,
      sourceRef: {
        sourceKind: "conversation",
        sourcePath: "/tmp/conversations.json",
        documentId: "conversation:test",
        documentTitle: "Test Conversation",
        locator: `turn:${itemNumber}`,
        sourceItemId: `turn:${itemNumber}`,
        conversationId: "test",
        bundleName: "conversations.json",
        turnId: String(itemNumber)
      }
    };
  });
}

test("runSemanticDensityAudit fails sparse authored writing claims and passes dense claims", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-density-audit-"));

  try {
    writeFileSync(path.join(tempRoot, "package.json"), "{}\n", "utf8");
    mkdirSync(path.join(tempRoot, "input"), { recursive: true });
    const paths = getProjectPaths(tempRoot);
    mkdirSync(paths.normalizedUnifiedDir, { recursive: true });
    mkdirSync(paths.compiledDir, { recursive: true });
    writeFileSync(
      path.join(paths.normalizedUnifiedDir, "corpus.json"),
      `${JSON.stringify(createCorpus(), null, 2)}\n`,
      "utf8"
    );

    const claimsPath = path.join(paths.compiledDir, "thought_claims.json");
    writeFileSync(claimsPath, `${JSON.stringify(claimsPerSegment(1), null, 2)}\n`, "utf8");
    assert.equal(runSemanticDensityAudit(paths).summary.passing, false);

    writeFileSync(claimsPath, `${JSON.stringify(claimsPerSegment(2), null, 2)}\n`, "utf8");
    assert.equal(runSemanticDensityAudit(paths).summary.passing, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runSemanticDensityAudit reports sparse long conversations without failing the run", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-density-conversation-"));

  try {
    writeFileSync(path.join(tempRoot, "package.json"), "{}\n", "utf8");
    mkdirSync(path.join(tempRoot, "input"), { recursive: true });
    const paths = getProjectPaths(tempRoot);
    mkdirSync(paths.normalizedUnifiedDir, { recursive: true });
    mkdirSync(paths.compiledDir, { recursive: true });
    writeFileSync(
      path.join(paths.normalizedUnifiedDir, "corpus.json"),
      `${JSON.stringify(createLongConversationCorpus(), null, 2)}\n`,
      "utf8"
    );
    writeFileSync(
      path.join(paths.compiledDir, "thought_claims.json"),
      `${JSON.stringify(conversationClaimsPerSegment(), null, 2)}\n`,
      "utf8"
    );

    const summary = runSemanticDensityAudit(paths).summary;
    assert.equal(summary.passing, true);
    assert.equal(summary.failingBatchCount, 0);
    assert.equal(summary.conversationWatchBatchCount, 1);
    assert.equal(summary.veryLongConversationWatchBatchCount, 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
