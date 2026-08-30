import type { UnifiedCorpus, UnifiedSegment } from "../types/domain.js";
import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import { buildDocumentFrameHintLookup } from "./document_frames.js";
import type {
  ThoughtBatchItem,
  ThoughtCompilerBatch,
  ThoughtDocumentFrameArtifact
} from "./types.js";

const THOUGHT_COMPILER_DEFAULTS = SECOND_BRAIN_DEFAULTS.thoughtCompiler;

/**
 * Estimate prompt cost cheaply enough for batch shaping without needing a tokenizer dependency.
 */
export function estimateTextTokens(text: string): number {
  const normalizedLength = text.trim().length;
  if (normalizedLength === 0) {
    return 1;
  }

  return Math.ceil(normalizedLength / THOUGHT_COMPILER_DEFAULTS.charactersPerToken);
}

function truncateLocalContext(text: string | undefined, side: "start" | "end"): string | null {
  if (!text) {
    return null;
  }

  const limit = THOUGHT_COMPILER_DEFAULTS.maxLocalContextCharacters;
  if (text.length <= limit) {
    return text;
  }

  return side === "start"
    ? `${text.slice(0, limit).trimEnd()}\n[context truncated]`
    : `[context truncated]\n${text.slice(-limit).trimStart()}`;
}

export function buildThoughtCompilerBatchItems(
  corpus: UnifiedCorpus,
  documentFrames?: ThoughtDocumentFrameArtifact | null
): ThoughtBatchItem[] {
  const segmentById = new Map<string, UnifiedSegment>(
    corpus.segments.map((segment) => [segment.id, segment])
  );
  const primarySegmentsByDocumentId = new Map<string, UnifiedSegment[]>();
  const frameHintLookup = documentFrames ? buildDocumentFrameHintLookup(documentFrames) : new Map();

  for (const segment of corpus.segments) {
    if (segment.signalKind !== "primary") {
      continue;
    }
    const bucket = primarySegmentsByDocumentId.get(segment.documentId) ?? [];
    bucket.push(segment);
    primarySegmentsByDocumentId.set(segment.documentId, bucket);
  }

  return corpus.primaryTimeline.map((entry) => {
    const segment = segmentById.get(entry.segmentId);
    if (!segment) {
      // If this ever fires, normalization produced an internally inconsistent
      // corpus and the compiler should stop immediately rather than silently
      // skipping source material.
      throw new Error(`Primary timeline references unknown segment: ${entry.segmentId}`);
    }

    const documentSegments = (primarySegmentsByDocumentId.get(segment.documentId) ?? [])
      .slice()
      .sort((left, right) => left.sequenceIndex - right.sequenceIndex);
    const currentIndex = documentSegments.findIndex(
      (documentSegment) => documentSegment.id === segment.id
    );
    const previousSegment = currentIndex > 0 ? documentSegments[currentIndex - 1] : undefined;
    const nextSegment =
      currentIndex >= 0 && currentIndex < documentSegments.length - 1
        ? documentSegments[currentIndex + 1]
        : undefined;
    const previousText = truncateLocalContext(previousSegment?.text, "end");
    const nextText = truncateLocalContext(nextSegment?.text, "start");
    const localContext =
      previousSegment || nextSegment
        ? {
            previousSegmentLabel: previousSegment?.segmentLabel ?? null,
            previousText,
            nextSegmentLabel: nextSegment?.segmentLabel ?? null,
            nextText
          }
        : undefined;
    const documentFrameHint = frameHintLookup.get(segment.id) ?? null;
    const contextTokens =
      estimateTextTokens(previousText ?? "") + estimateTextTokens(nextText ?? "");
    const frameHintTokens = estimateTextTokens(
      documentFrameHint
        ? JSON.stringify({
            label: documentFrameHint.label,
            summary: documentFrameHint.summary,
            subframes: documentFrameHint.subframeHints.map((subframe: { label: string; summary: string }) => ({
              label: subframe.label,
              summary: subframe.summary
            }))
          })
        : ""
    );

    return {
      inputId: segment.id,
      documentId: segment.documentId,
      sourceKind: segment.sourceKind,
      documentTitle: entry.documentTitle,
      chronologyIndex: entry.chronologyIndex,
      time: entry.time,
      segmentLabel: entry.segmentLabel,
      text: segment.text,
      textPreview: segment.textPreview,
      localContext,
      documentFrameHint,
      estimatedTokens:
        estimateTextTokens(segment.text) +
        contextTokens +
        frameHintTokens +
        THOUGHT_COMPILER_DEFAULTS.perSegmentOverheadTokens
    };
  });
}

export function buildThoughtCompilerBatchesFromItems(
  items: ThoughtBatchItem[],
  options?: {
    batchSize?: number;
    softInputTokenBudget?: number;
  }
): ThoughtCompilerBatch[] {
  const batchSize = options?.batchSize ?? THOUGHT_COMPILER_DEFAULTS.batchSize;
  const softInputTokenBudget =
    options?.softInputTokenBudget ?? THOUGHT_COMPILER_DEFAULTS.softInputTokenBudget;
  const batches: ThoughtCompilerBatch[] = [];
  let currentItems: ThoughtBatchItem[] = [];
  let currentEstimatedTokens = 0;

  const flushBatch = (): void => {
    if (currentItems.length === 0) {
      return;
    }

    // Batch ids are stable within one corpus ordering so checkpoint state and
    // batch artifact filenames remain easy to line up during resume/debugging.
    const batchIndex = batches.length + 1;
    batches.push({
      batchId: `batch-${String(batchIndex).padStart(4, "0")}`,
      batchIndex,
      estimatedInputTokens: currentEstimatedTokens,
      items: currentItems
    });
    currentItems = [];
    currentEstimatedTokens = 0;
  };

  for (const item of items) {
    const wouldExceedCount = currentItems.length >= batchSize;
    const wouldExceedTokens =
      currentItems.length > 0 &&
      currentEstimatedTokens + item.estimatedTokens > softInputTokenBudget;

    // We preserve chronology order at all costs. The batching strategy is
    // greedy on purpose because temporal order matters more here than perfect
    // token packing efficiency.
    if (wouldExceedCount || wouldExceedTokens) {
      flushBatch();
    }

    currentItems.push(item);
    currentEstimatedTokens += item.estimatedTokens;
  }

  flushBatch();
  return batches;
}

/**
 * Build semantic batches from the unified primary timeline.
 *
 * The greedy strategy is intentionally simple: keep chronology order stable,
 * respect both item count and token budget, and avoid hidden batching magic.
 */
export function buildThoughtCompilerBatches(
  corpus: UnifiedCorpus,
  options?: {
    batchSize?: number;
    softInputTokenBudget?: number;
    documentFrames?: ThoughtDocumentFrameArtifact | null;
  }
): ThoughtCompilerBatch[] {
  const items = buildThoughtCompilerBatchItems(corpus, options?.documentFrames ?? null);

  return buildThoughtCompilerBatchesFromItems(items, {
    batchSize: options?.batchSize,
    softInputTokenBudget: options?.softInputTokenBudget
  });
}
