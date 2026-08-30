import test from "node:test";
import assert from "node:assert/strict";

import {
  buildThoughtCompilerBatchItems,
  buildThoughtCompilerBatches,
  estimateTextTokens
} from "./batching.js";
import type { UnifiedCorpus } from "../types/domain.js";

function createUnifiedCorpus(primaryTexts: string[]): UnifiedCorpus {
  const segments = primaryTexts.map((text, index) => {
    const itemNumber = index + 1;
    const id = `writing:test-${itemNumber}:paragraph:1`;

    return {
      id,
      documentId: `writing:test-${itemNumber}`,
      sourceKind: "writing" as const,
      segmentKind: "writing_paragraph" as const,
      signalKind: "primary" as const,
      authorKind: "self" as const,
      authorLabel: "self",
      sequenceIndex: 1,
      time: `2024-01-${String(itemNumber).padStart(2, "0")}T00:00:00.000Z`,
      timeUnix: Date.parse(`2024-01-${String(itemNumber).padStart(2, "0")}T00:00:00.000Z`),
      timePrecision: "day" as const,
      sourcePriority: 100,
      segmentLabel: `Paragraph ${itemNumber}`,
      text,
      textPreview: text,
      sourceRef: {
        sourceKind: "writing" as const,
        sourcePath: `/input/writings/test-${itemNumber}.txt`,
        documentId: `writing:test-${itemNumber}`,
        documentTitle: `Test ${itemNumber}`,
        locator: "paragraph:1",
        sourceItemId: "paragraph:1"
      }
    };
  });

  return {
    generatedAt: "2026-04-20T00:00:00.000Z",
    options: {
      ownerNames: ["Alex"],
      includeOtherContext: true,
      includeAssistantContext: true,
      includeToolContext: false,
      contextWindow: 1,
      includedSourceKinds: ["writing", "conversation", "chat"]
    },
    documents: segments.map((segment, index) => ({
      id: segment.documentId,
      sourceKind: "writing" as const,
      sourcePath: `/input/writings/test-${index + 1}.txt`,
      slug: `test-${index + 1}`,
      title: `Test ${index + 1}`,
      time: segment.time,
      timeUnix: segment.timeUnix,
      timePrecision: "day" as const,
      sourcePriority: 100,
      primaryText: segment.text,
      contextText: null,
      primarySegmentCount: 1,
      contextSegmentCount: 0,
      metadata: {
        fileLabel: `test-${index + 1}`,
        wordCount: segment.text.split(/\s+/).length
      }
    })),
    segments,
    timeline: segments.map((segment, index) => ({
      chronologyIndex: index,
      segmentId: segment.id,
      documentId: segment.documentId,
      sourceKind: segment.sourceKind,
      segmentKind: segment.segmentKind,
      signalKind: segment.signalKind,
      authorKind: segment.authorKind,
      documentTitle: `Test ${index + 1}`,
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
      documentTitle: `Test ${index + 1}`,
      segmentLabel: segment.segmentLabel,
      time: segment.time,
      timeUnix: segment.timeUnix,
      timePrecision: segment.timePrecision,
      textPreview: segment.textPreview
    })),
    stats: {
      documentCount: segments.length,
      segmentCount: segments.length,
      primarySegmentCount: segments.length,
      contextSegmentCount: 0,
      documentsBySourceKind: {
        writing: segments.length,
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

test("estimateTextTokens gives a stable lightweight token estimate", () => {
  assert.equal(estimateTextTokens(""), 1);
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(estimateTextTokens("abcdefgh"), 2);
});

test("buildThoughtCompilerBatches respects batch-size limits while preserving chronology", () => {
  const corpus = createUnifiedCorpus([
    "Prvni segment",
    "Druhy segment",
    "Treti segment",
    "Ctvrty segment",
    "Paty segment"
  ]);

  const batches = buildThoughtCompilerBatches(corpus, {
    batchSize: 2,
    softInputTokenBudget: 1000
  });

  assert.deepEqual(
    batches.map((batch) => batch.items.map((item) => item.inputId)),
    [
      [
        "writing:test-1:paragraph:1",
        "writing:test-2:paragraph:1"
      ],
      [
        "writing:test-3:paragraph:1",
        "writing:test-4:paragraph:1"
      ],
      ["writing:test-5:paragraph:1"]
    ]
  );
});

test("buildThoughtCompilerBatches also splits on token budget", () => {
  const longText = "slovo ".repeat(400);
  const corpus = createUnifiedCorpus([longText, longText, "kratky"]);

  const batches = buildThoughtCompilerBatches(corpus, {
    batchSize: 10,
    softInputTokenBudget: 250
  });

  assert.equal(batches.length, 3);
  assert.deepEqual(
    batches.map((batch) => batch.items.length),
    [1, 1, 1]
  );
});

test("buildThoughtCompilerBatchItems bounds neighboring local context", () => {
  const corpus = createUnifiedCorpus([
    `previous-start ${"p".repeat(6000)} previous-end`,
    "middle",
    `next-start ${"n".repeat(6000)} next-end`
  ]);

  corpus.segments.forEach((segment, index) => {
    segment.documentId = "writing:shared";
    segment.sequenceIndex = index + 1;
  });
  corpus.primaryTimeline.forEach((entry) => {
    entry.documentId = "writing:shared";
  });

  const middle = buildThoughtCompilerBatchItems(corpus).find(
    (item) => item.text === "middle"
  );

  assert.equal(middle?.localContext?.previousText?.startsWith("[context truncated]"), true);
  assert.equal(middle?.localContext?.previousText?.endsWith("previous-end"), true);
  assert.equal(middle?.localContext?.nextText?.startsWith("next-start"), true);
  assert.equal(middle?.localContext?.nextText?.endsWith("[context truncated]"), true);
  assert.equal((middle?.localContext?.previousText?.length ?? 0) < 2100, true);
  assert.equal((middle?.localContext?.nextText?.length ?? 0) < 2100, true);
});
