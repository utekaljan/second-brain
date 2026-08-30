import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { CodexCliClient, CodexReasoningEffort } from "../codex/client.js";
import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import type { ProjectPaths } from "../system/paths.js";
import type { UnifiedCorpus, UnifiedDocument, UnifiedSegment } from "../types/domain.js";
import { slugify } from "../utils/text.js";
import type {
  ThoughtSemanticReusePolicy,
  ThoughtBatchItem,
  ThoughtDocumentFrame,
  ThoughtDocumentFrameArtifact,
  ThoughtDocumentFrameSourceKind,
  ThoughtDocumentOutline,
  ThoughtDocumentOutlineRole,
  ThoughtDocumentOutlineStep,
  ThoughtDocumentFrameScope,
  ThoughtDocumentSubframe
} from "./types.js";

const THOUGHT_COMPILER_DEFAULTS = SECOND_BRAIN_DEFAULTS.thoughtCompiler;
const OUTPUT_LANGUAGE = SECOND_BRAIN_DEFAULTS.language;
// Version 4 fixes conversation contiguity to use primary-turn order and tightens
// the contract against singleton turn relabeling. Older cached frames must not
// survive this semantic change.
const DOCUMENT_FRAME_CACHE_VERSION = 4;

type FrameExtractionClient = Pick<CodexCliClient, "execSemanticBatch">;
const SUBFRAME_SINGLETON_RATIO_THRESHOLD = 0.67;
const SUBFRAME_COVERAGE_RATIO_THRESHOLD = 0.67;

type RawDocumentFrameOutput = {
  documentId: string;
  documentSummary: string;
  frames: Array<{
    label: string;
    summary: string;
    outlineRole: ThoughtDocumentOutlineRole;
    outlineRationale: string;
    returnTargetSegmentId: string | null;
    segmentIds: string[];
    subframes: Array<{
      label: string;
      summary: string;
      segmentIds: string[];
    }>;
  }>;
};

type SourceLocalDocument = UnifiedDocument & { sourceKind: ThoughtDocumentFrameSourceKind };
type OrderedSourceLocalSegment = UnifiedSegment & { sourceKind: ThoughtDocumentFrameSourceKind };

type DocumentFrameCacheEntry = {
  cacheKey: string;
  documentId: string;
  segmentHash: string;
  contractHash: string;
  frames: ThoughtDocumentFrame[];
  subframes: ThoughtDocumentSubframe[];
  outlines: ThoughtDocumentOutline[];
  updatedAt: string;
};

type DocumentFrameCache = {
  version: number;
  generatedAt: string;
  entries: Record<string, DocumentFrameCacheEntry>;
};

type ResolvedDocumentFrameCacheEntry = {
  entry: DocumentFrameCacheEntry | null;
  cacheKey: string;
  segmentHash: string;
  contractHash: string;
  model: string | null;
  reasoningEffort: string | null;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function getDocumentFrameCachePath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "semantic-cache", "document_frame_cache.json");
}

function loadDocumentFrameCache(paths: ProjectPaths): DocumentFrameCache {
  const target = getDocumentFrameCachePath(paths);
  if (!existsSync(target)) {
    return {
      version: DOCUMENT_FRAME_CACHE_VERSION,
      generatedAt: new Date().toISOString(),
      entries: {}
    };
  }

  const cache = JSON.parse(readFileSync(target, "utf8")) as DocumentFrameCache;
  if (cache.version !== DOCUMENT_FRAME_CACHE_VERSION) {
    return {
      version: DOCUMENT_FRAME_CACHE_VERSION,
      generatedAt: new Date().toISOString(),
      entries: {}
    };
  }

  return cache;
}

function writeDocumentFrameCache(paths: ProjectPaths, cache: DocumentFrameCache): void {
  const target = getDocumentFrameCachePath(paths);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function buildDocumentFrameCacheKey(
  document: SourceLocalDocument,
  segments: OrderedSourceLocalSegment[],
  options?: {
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
  }
): {
  cacheKey: string;
  segmentHash: string;
  contractHash: string;
} {
  const segmentHash = hashStable({
    documentId: document.id,
    title: document.title,
    segments: segments.map((segment) => ({
      id: segment.id,
      sequenceIndex: segment.sequenceIndex,
      text: segment.text
    }))
  });
  const contractHash = hashStable({
    version: DOCUMENT_FRAME_CACHE_VERSION,
    sourceKind: document.sourceKind,
    model: options?.model ?? SECOND_BRAIN_DEFAULTS.codex.defaultModel ?? null,
    reasoningEffort:
      options?.reasoningEffort ?? SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort ?? null,
    maxFramesPerWriting: THOUGHT_COMPILER_DEFAULTS.maxFramesPerWriting,
    maxSubframesPerFrame: THOUGHT_COMPILER_DEFAULTS.maxSubframesPerFrame,
    outputLanguage: OUTPUT_LANGUAGE.output
  });

  return {
    segmentHash,
    contractHash,
    cacheKey: hashStable({
      version: DOCUMENT_FRAME_CACHE_VERSION,
      documentId: document.id,
      segmentHash,
      contractHash
    })
  };
}

function resolveReusableDocumentFrameCacheEntry(
  document: SourceLocalDocument,
  segments: OrderedSourceLocalSegment[],
  cache: DocumentFrameCache | null,
  options?: {
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
    reusePolicy?: ThoughtSemanticReusePolicy;
    previousArtifact?: ThoughtDocumentFrameArtifact | null;
  }
): ResolvedDocumentFrameCacheEntry {
  // Document-frame reuse follows the same policy as semantic segment reuse:
  // mixed mode keeps the previously active local structure for unchanged
  // documents so later model changes do not cascade into needless segment
  // recompilation through changed frame hints.
  const key = buildDocumentFrameCacheKey(document, segments, options);
  const model = options?.model ?? SECOND_BRAIN_DEFAULTS.codex.defaultModel ?? null;
  const reasoningEffort =
    options?.reasoningEffort ?? SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort ?? null;
  const currentEntry = cache?.entries[key.cacheKey];

  if (
    currentEntry &&
    currentEntry.documentId === document.id &&
    currentEntry.segmentHash === key.segmentHash &&
    currentEntry.contractHash === key.contractHash
  ) {
    return {
      entry: currentEntry,
      cacheKey: key.cacheKey,
      segmentHash: key.segmentHash,
      contractHash: key.contractHash,
      model,
      reasoningEffort
    };
  }

  if (options?.reusePolicy === "mixed") {
    const binding = options.previousArtifact?.cacheBindings?.[document.id];
    if (binding && binding.segmentHash === key.segmentHash) {
      const previousEntry = cache?.entries[binding.cacheKey];
      if (
        previousEntry &&
        previousEntry.documentId === document.id &&
        previousEntry.segmentHash === binding.segmentHash &&
        previousEntry.contractHash === binding.contractHash
      ) {
        return {
          entry: previousEntry,
          cacheKey: binding.cacheKey,
          segmentHash: binding.segmentHash,
          contractHash: binding.contractHash,
          model: binding.model,
          reasoningEffort: binding.reasoningEffort
        };
      }
    }
  }

  return {
    entry: null,
    cacheKey: key.cacheKey,
    segmentHash: key.segmentHash,
    contractHash: key.contractHash,
    model,
    reasoningEffort
  };
}

/**
 * Structured-output contract for one source-local frame extraction.
 *
 * The model is asked for a tiny number of broad frames, not for another layer
 * of thought nodes. This is the key reset relative to the failed graph-first
 * vertical attempt.
 */
export const THOUGHT_DOCUMENT_FRAME_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    documentId: { type: "string" },
    frames: {
      type: "array",
      maxItems: THOUGHT_COMPILER_DEFAULTS.maxFramesPerWriting,
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          summary: { type: "string" },
          outlineRole: {
            type: "string",
            enum: ["opening", "development", "branch", "return", "conclusion"]
          },
          outlineRationale: { type: "string" },
          returnTargetSegmentId: {
            anyOf: [{ type: "string" }, { type: "null" }]
          },
          segmentIds: {
            type: "array",
            items: { type: "string" }
          },
          subframes: {
            type: "array",
            maxItems: THOUGHT_COMPILER_DEFAULTS.maxSubframesPerFrame,
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                summary: { type: "string" },
                segmentIds: {
                  type: "array",
                  items: { type: "string" }
                }
              },
              required: ["label", "summary", "segmentIds"],
              additionalProperties: false
            }
          }
        },
        required: [
          "label",
          "summary",
          "outlineRole",
          "outlineRationale",
          "returnTargetSegmentId",
          "segmentIds",
          "subframes"
        ],
        additionalProperties: false
      }
    },
    documentSummary: { type: "string" }
  },
  required: ["documentId", "documentSummary", "frames"],
  additionalProperties: false
} as const;

function ensureDocumentFrameSchemaFile(target: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    target,
    `${JSON.stringify(THOUGHT_DOCUMENT_FRAME_OUTPUT_SCHEMA, null, 2)}\n`,
    "utf8"
  );
}

function getSourceLocalPrimarySegments(
  corpus: UnifiedCorpus,
  documentId: string,
  sourceKind: ThoughtDocumentFrameSourceKind
): OrderedSourceLocalSegment[] {
  return corpus.segments
    .filter(
      (segment): segment is OrderedSourceLocalSegment =>
        segment.documentId === documentId &&
        segment.sourceKind === sourceKind &&
        segment.signalKind === "primary"
    )
    .slice()
    .sort((left, right) => left.sequenceIndex - right.sequenceIndex);
}

function estimateFramePromptTokens(segments: OrderedSourceLocalSegment[]): number {
  const characters = segments.reduce((sum, segment) => sum + segment.text.length, 0);
  return Math.ceil(characters / THOUGHT_COMPILER_DEFAULTS.charactersPerToken);
}

function resolveFrameScope(
  totalSegmentCount: number,
  coveredSegmentCount: number
): ThoughtDocumentFrameScope {
  return coveredSegmentCount >= Math.max(1, totalSegmentCount - 1) ? "document" : "section";
}

function buildFallbackFrame(
  document: SourceLocalDocument,
  segments: OrderedSourceLocalSegment[]
): {
  frames: ThoughtDocumentFrame[];
  subframes: ThoughtDocumentSubframe[];
  outlines: ThoughtDocumentOutline[];
} {
  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];
  const frameId = `frame:${document.id}:01:${slugify(document.title) || "hlavni-ramec"}`;
  const outlineId = `outline:${document.id}`;
  const isConversation = document.sourceKind === "conversation";

  return {
    frames: [
      {
        id: frameId,
        documentId: document.id,
        sourceKind: document.sourceKind,
        label: document.title,
        summary: isConversation
          ? `Hlavní lokální rámec threadu ${document.title}.`
          : `Hlavní myšlenkový rámec textu ${document.title}.`,
        scope: "document",
        segmentIds: segments.map((segment) => segment.id),
        startSequenceIndex: firstSegment?.sequenceIndex ?? 0,
        endSequenceIndex: lastSegment?.sequenceIndex ?? 0,
        subframeIds: []
      }
    ],
    subframes: [],
    outlines: [
      {
        id: outlineId,
        documentId: document.id,
        sourceKind: document.sourceKind,
        label: document.title,
        summary: isConversation
          ? `Lokální outline threadu ${document.title}.`
          : `Lokální outline textu ${document.title}.`,
        frameIds: [frameId],
        steps: [
          {
            frameId,
            orderIndex: 0,
            role: "opening",
            returnsToFrameId: null,
            rationale: isConversation
              ? "Thread nese jednu hlavní linii bez dalších výrazných větví."
              : "Text nese jednu hlavní linii bez dalších větví."
          }
        ]
      }
    ]
  };
}

function sanitizeSegmentIds(
  segmentIds: string[],
  validSegmentIds: Set<string>
): string[] {
  return Array.from(
    new Set(
      segmentIds
        .map((segmentId) => segmentId.trim())
        .filter((segmentId) => segmentId.length > 0 && validSegmentIds.has(segmentId))
    )
  );
}

function buildFrameId(
  documentId: string,
  frameIndex: number,
  label: string
): string {
  return `frame:${documentId}:${String(frameIndex + 1).padStart(2, "0")}:${slugify(label) || "ramec"}`;
}

function buildSubframeId(
  frameId: string,
  subframeIndex: number,
  label: string
): string {
  return `${frameId}:subframe:${String(subframeIndex + 1).padStart(2, "0")}:${slugify(label) || "vetev"}`;
}

function extractLongestContiguousSegmentRun(
  segmentIds: string[],
  primaryPositionBySegmentId: Map<string, number>
): string[] {
  if (segmentIds.length <= 1) {
    return segmentIds;
  }

  const ordered = segmentIds
    .map((segmentId) => ({
      segmentId,
      primaryPosition: primaryPositionBySegmentId.get(segmentId) ?? Number.MAX_SAFE_INTEGER
    }))
    .sort((left, right) => left.primaryPosition - right.primaryPosition);

  let bestRun = ordered.length > 0 ? [ordered[0]!] : [];
  let currentRun = ordered.length > 0 ? [ordered[0]!] : [];

  for (let index = 1; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    const previous = ordered[index - 1]!;
    if (current.primaryPosition === previous.primaryPosition + 1) {
      currentRun.push(current);
      continue;
    }

    if (currentRun.length > bestRun.length) {
      bestRun = currentRun.slice();
    }
    currentRun = [current];
  }

  if (currentRun.length > bestRun.length) {
    bestRun = currentRun;
  }

  return bestRun.map((entry) => entry.segmentId);
}

function shouldSuppressParagraphLikeSubframes(
  frameSegmentIds: string[],
  subframes: Array<{ segmentIds: string[] }>
): boolean {
  if (frameSegmentIds.length < 3 || subframes.length < 2) {
    return false;
  }

  const singletonCount = subframes.filter((subframe) => subframe.segmentIds.length === 1).length;
  const coveredSegments = new Set(subframes.flatMap((subframe) => subframe.segmentIds));
  const coverageRatio = coveredSegments.size / frameSegmentIds.length;
  const singletonRatio = singletonCount / subframes.length;

  return (
    coverageRatio >= SUBFRAME_COVERAGE_RATIO_THRESHOLD &&
    singletonRatio >= SUBFRAME_SINGLETON_RATIO_THRESHOLD
  );
}

function materializeDocumentFrames(
  document: SourceLocalDocument,
  segments: OrderedSourceLocalSegment[],
  output: RawDocumentFrameOutput
): {
  frames: ThoughtDocumentFrame[];
  subframes: ThoughtDocumentSubframe[];
  outlines: ThoughtDocumentOutline[];
} {
  if (segments.length === 0) {
    return { frames: [], subframes: [], outlines: [] };
  }

  const sequenceIndexBySegmentId = new Map<string, number>(
    segments.map((segment) => [segment.id, segment.sequenceIndex])
  );
  const orderedSegmentIds = segments.map((segment) => segment.id);
  const primaryPositionBySegmentId = new Map(
    orderedSegmentIds.map((segmentId, index) => [segmentId, index])
  );
  const validSegmentIds = new Set(orderedSegmentIds);

  const cleanedFrames = output.frames
    .map((frame, frameIndex) => ({
      frameIndex,
      label: frame.label.trim(),
      summary: frame.summary.trim(),
      outlineRole: frame.outlineRole,
      outlineRationale: frame.outlineRationale.trim(),
      returnTargetSegmentId:
        typeof frame.returnTargetSegmentId === "string" &&
        validSegmentIds.has(frame.returnTargetSegmentId.trim())
          ? frame.returnTargetSegmentId.trim()
          : null,
      segmentIds: sanitizeSegmentIds(frame.segmentIds, validSegmentIds),
      subframes: frame.subframes.map((subframe, subframeIndex) => ({
        subframeIndex,
        label: subframe.label.trim(),
        summary: subframe.summary.trim(),
        segmentIds: sanitizeSegmentIds(subframe.segmentIds, validSegmentIds)
      }))
    }))
    .filter((frame) => frame.label.length > 0 && frame.segmentIds.length > 0)
    .sort((left, right) => {
      const leftStart = sequenceIndexBySegmentId.get(left.segmentIds[0] ?? "") ?? Number.MAX_SAFE_INTEGER;
      const rightStart = sequenceIndexBySegmentId.get(right.segmentIds[0] ?? "") ?? Number.MAX_SAFE_INTEGER;
      if (leftStart !== rightStart) {
        return leftStart - rightStart;
      }
      return left.frameIndex - right.frameIndex;
    });

  if (cleanedFrames.length === 0) {
    return buildFallbackFrame(document, segments);
  }

  // Every segment should belong to exactly one main frame. If the model
  // overlaps frames, keep the earliest stronger frame and rebuild membership
  // deterministically from that primary assignment.
  const primaryFrameIndexBySegmentId = new Map<string, number>();
  cleanedFrames.forEach((frame, frameIndex) => {
    for (const segmentId of frame.segmentIds) {
      if (!primaryFrameIndexBySegmentId.has(segmentId)) {
        primaryFrameIndexBySegmentId.set(segmentId, frameIndex);
      }
    }
  });

  // If the model missed a segment entirely, attach it to the nearest frame by
  // sequence distance rather than dropping part of the writing on the floor.
  for (const segment of segments) {
    if (primaryFrameIndexBySegmentId.has(segment.id)) {
      continue;
    }

    let bestFrameIndex = 0;
    let bestDistance = Number.MAX_SAFE_INTEGER;
    cleanedFrames.forEach((frame, frameIndex) => {
      const start = sequenceIndexBySegmentId.get(frame.segmentIds[0] ?? "") ?? segment.sequenceIndex;
      const end =
        sequenceIndexBySegmentId.get(frame.segmentIds[frame.segmentIds.length - 1] ?? "") ??
        segment.sequenceIndex;
      const distance =
        segment.sequenceIndex < start
          ? start - segment.sequenceIndex
          : segment.sequenceIndex > end
            ? segment.sequenceIndex - end
            : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestFrameIndex = frameIndex;
      }
    });
    primaryFrameIndexBySegmentId.set(segment.id, bestFrameIndex);
  }

  const materializedFrames: ThoughtDocumentFrame[] = [];
  const materializedSubframes: ThoughtDocumentSubframe[] = [];
  const outlineStepDrafts: Array<{
    frameId: string;
    role: ThoughtDocumentOutlineRole;
    rationale: string;
    returnTargetSegmentId: string | null;
  }> = [];

  cleanedFrames.forEach((frame, frameIndex) => {
    const assignedSegmentIds = orderedSegmentIds.filter(
      (segmentId) => primaryFrameIndexBySegmentId.get(segmentId) === frameIndex
    );
    if (assignedSegmentIds.length === 0) {
      return;
    }

    const frameId = buildFrameId(document.id, materializedFrames.length, frame.label);
    const startSequenceIndex =
      sequenceIndexBySegmentId.get(assignedSegmentIds[0] ?? "") ?? 0;
    const endSequenceIndex =
      sequenceIndexBySegmentId.get(assignedSegmentIds[assignedSegmentIds.length - 1] ?? "") ?? 0;
    const allowedSegments = new Set(assignedSegmentIds);
    const rawSubframes = frame.subframes
      .map((subframe) => {
        const filteredSegmentIds = orderedSegmentIds.filter(
          (segmentId) => allowedSegments.has(segmentId) && subframe.segmentIds.includes(segmentId)
        );
        const contiguousSegmentIds = extractLongestContiguousSegmentRun(
          filteredSegmentIds,
          primaryPositionBySegmentId
        );

        return {
          label: subframe.label,
          summary: subframe.summary,
          segmentIds: contiguousSegmentIds
        };
      })
      .filter((subframe) => subframe.label.length > 0 && subframe.segmentIds.length > 0);

    // If subframes degrade into one label per paragraph, keep only the broader
    // frame. The local frame layer should prefer fewer real branches over fake
    // depth caused by output slot pressure.
    const usableSubframes = shouldSuppressParagraphLikeSubframes(
      assignedSegmentIds,
      rawSubframes
    )
      ? []
      : rawSubframes;

    const subframeIds: string[] = [];
    for (const subframe of usableSubframes) {
      const subframeId = buildSubframeId(frameId, subframeIds.length, subframe.label);
      const subframeStartSequenceIndex =
        sequenceIndexBySegmentId.get(subframe.segmentIds[0] ?? "") ?? startSequenceIndex;
      const subframeEndSequenceIndex =
        sequenceIndexBySegmentId.get(subframe.segmentIds[subframe.segmentIds.length - 1] ?? "") ??
        endSequenceIndex;

    materializedSubframes.push({
        id: subframeId,
        frameId,
        documentId: document.id,
        sourceKind: document.sourceKind,
        label: subframe.label,
        summary: subframe.summary,
        segmentIds: subframe.segmentIds,
        startSequenceIndex: subframeStartSequenceIndex,
        endSequenceIndex: subframeEndSequenceIndex
      });
      subframeIds.push(subframeId);
    }

    materializedFrames.push({
      id: frameId,
      documentId: document.id,
      sourceKind: document.sourceKind,
      label: frame.label,
      summary: frame.summary,
      scope: resolveFrameScope(segments.length, assignedSegmentIds.length),
      segmentIds: assignedSegmentIds,
      startSequenceIndex,
      endSequenceIndex,
      subframeIds
    });
    outlineStepDrafts.push({
      frameId,
      role: frame.outlineRole,
      rationale: frame.outlineRationale || `Lokální role rámce ${frame.label} v textu ${document.title}.`,
      returnTargetSegmentId: frame.returnTargetSegmentId
    });
  });

  if (materializedFrames.length === 0) {
    return buildFallbackFrame(document, segments);
  }

  const parentFrameIdBySegmentId = new Map<string, string>();
  for (const frame of materializedFrames) {
    for (const segmentId of frame.segmentIds) {
      parentFrameIdBySegmentId.set(segmentId, frame.id);
    }
  }

  const outlineSteps: ThoughtDocumentOutlineStep[] = outlineStepDrafts.map((draft, index) => {
    let role = draft.role;
    let returnsToFrameId =
      role === "return" && draft.returnTargetSegmentId
        ? (parentFrameIdBySegmentId.get(draft.returnTargetSegmentId) ?? null)
        : null;

    if (index === 0) {
      role = "opening";
      returnsToFrameId = null;
    } else if (role === "return") {
      const currentFrameId = draft.frameId;
      if (
        returnsToFrameId === null ||
        returnsToFrameId === currentFrameId ||
        !outlineStepDrafts.slice(0, index).some((candidate) => candidate.frameId === returnsToFrameId)
      ) {
        role = "development";
        returnsToFrameId = null;
      }
    }

    return {
      frameId: draft.frameId,
      orderIndex: index,
      role,
      returnsToFrameId,
      rationale: draft.rationale
    };
  });

  if (outlineSteps.length > 1) {
    const last = outlineSteps[outlineSteps.length - 1];
    if (last && last.role === "development") {
      last.role = "conclusion";
    }
  }

  const documentSummary = output.documentSummary.trim().length > 0
    ? output.documentSummary.trim()
    : document.sourceKind === "conversation"
      ? `Lokální outline threadu ${document.title}.`
      : `Lokální outline textu ${document.title}.`;

  return {
    frames: materializedFrames,
    subframes: materializedSubframes,
    outlines: [
      {
        id: `outline:${document.id}`,
        documentId: document.id,
        sourceKind: document.sourceKind,
        label: document.title,
        summary: documentSummary,
        frameIds: materializedFrames.map((frame) => frame.id),
        steps: outlineSteps
      }
    ]
  };
}

function buildSourceDocumentFramePayload(
  document: SourceLocalDocument,
  segments: OrderedSourceLocalSegment[]
): string {
  const payload = {
    documentId: document.id,
    title: document.title,
    time: document.time,
    primarySegmentCount: segments.length,
    estimatedInputTokens: estimateFramePromptTokens(segments),
    segments: segments.map((segment) => ({
      segmentId: segment.id,
      segmentLabel: segment.segmentLabel,
      sequenceIndex: segment.sequenceIndex,
      text: segment.text
    }))
  };

  return JSON.stringify(payload, null, 2);
}

/**
 * Build one writing-level prompt that asks for broad frames rather than for
 * paragraph-by-paragraph nodes.
 */
export function buildWritingDocumentFramePrompt(
  document: SourceLocalDocument,
  segments: OrderedSourceLocalSegment[]
): string {
  const payload = buildSourceDocumentFramePayload(document, segments);

  return [
    "Určuješ širší document frames uvnitř jednoho user-authored writingu.",
    "Neextrahuj další thought nodes. Hledej nejdřív větší lokální argumentační celky textu.",
    "Vedle samotných frame zachyť i krátkou lokální outline celého textu: jak text otevírá téma, rozvíjí ho, větví se, případně se vrací k dřívější větvi a jak uzavírá celek.",
    `Všechny přirozenojazyčné výstupní hodnoty piš v jazyce ${OUTPUT_LANGUAGE.outputLabel} (${OUTPUT_LANGUAGE.output}).`,
    "Pole documentSummary má stručně shrnout jeden celý text jako jeden lokální celek, ne jen vyjmenovat frame labels.",
    `Vrať nejvýše ${THOUGHT_COMPILER_DEFAULTS.maxFramesPerWriting} hlavní frames.`,
    "Hlavní frame má být širší než jedna teze nebo jeden odstavec, ale už dost konkrétní, aby zastřešil soudržnou část textu.",
    "Pokud text nese v zásadě jednu hlavní linii, vrať jen jeden frame.",
    "Každý hlavní frame musí pokrýt alespoň jeden segmentId z payloadu a dohromady mají frames pokrýt celý writing.",
    "Nevyráběj mikro-label pro každý odstavec. Nepřejmenovávej každý paragraph na samostatné téma.",
    `Pro každý frame vrať nejvýše ${THOUGHT_COMPILER_DEFAULTS.maxSubframesPerFrame} subframes a jen tehdy, když jde o skutečnou vnitřní větev nebo osu, ne o kosmetické přeznačení.`,
    "Subframes jsou volitelné. Když frame nemá zřetelné vnitřní větve, vrať prázdné subframes.",
    "Subframe má být souvislý lokální blok segmentů uvnitř jednoho frame, ne motiv sesbíraný z nesousedících míst textu.",
    "Když by subframes jen kopírovaly jednotlivé odstavce, nevracej je vůbec.",
    "Frames vrať v pořadí, v jakém se mají číst jako lokální outline textu.",
    "Každý frame musí mít outlineRole: opening, development, branch, return, nebo conclusion.",
    "outlineRationale má krátce vysvětlit, proč frame hraje tuto roli v celku textu.",
    "returnTargetSegmentId vyplň jen když outlineRole = return a frame se vrací k dřívější větvi; jinak vrať null.",
    "segmentIds musí být přesné identifikátory z payloadu.",
    "Vrať pouze JSON podle schema. Žádný doprovodný text.",
    "",
    "Writing payload:",
    payload
  ].join("\n");
}

/**
 * Build one conversation-level prompt that asks for broad thread phases and
 * local branches rather than for individual turn labels.
 */
export function buildConversationDocumentFramePrompt(
  document: SourceLocalDocument,
  segments: OrderedSourceLocalSegment[]
): string {
  const payload = buildSourceDocumentFramePayload(document, segments);

  return [
    "Určuješ širší document frames uvnitř jedné uživatelské conversation/threadu.",
    "Neextrahuj další thought nodes. Hledej nejdřív širší lokální fáze, větve nebo návraty uvnitř jednoho threadu.",
    "Vedle samotných frame zachyť i krátkou lokální outline celého threadu: jak se otevírá hlavní směr, jak se rozvíjí, kde se případně větví, vrací a jak se uzavírá nebo utichá.",
    `Všechny přirozenojazyčné výstupní hodnoty piš v jazyce ${OUTPUT_LANGUAGE.outputLabel} (${OUTPUT_LANGUAGE.output}).`,
    "Pole documentSummary má stručně shrnout jeden celý thread jako jeden lokální celek, ne jen vyjmenovat frame labels.",
    `Vrať nejvýše ${THOUGHT_COMPILER_DEFAULTS.maxFramesPerWriting} hlavní frames.`,
    "Hlavní frame má být širší než jeden user turn. Má zastřešit soudržnou místní linii, fázi nebo větev threadu.",
    "Pokud thread ve skutečnosti drží jednu hlavní souvislou linii, vrať jen jeden frame.",
    "Pokud je thread spíš volná směs krátkých utilitárních dotazů bez silného společného spine, nepředstírej falešnou hloubku: raději vrať 1-2 hrubé utility fáze než umělé větvení.",
    "Každý hlavní frame musí pokrýt alespoň jeden segmentId z payloadu a dohromady mají frames pokrýt celý thread.",
    "Nevyráběj mikro-label pro každý user turn. Nepřejmenovávej každé malé přehození tématu na samostatný frame.",
    `Pro každý frame vrať nejvýše ${THOUGHT_COMPILER_DEFAULTS.maxSubframesPerFrame} subframes a jen tehdy, když jde o skutečnou místní větev nebo fázi, ne o kosmetické přeznačení sousedních turnů.`,
    "Subframes jsou volitelné. Když frame nemá zřetelné vnitřní větve, vrať prázdné subframes.",
    "Subframe má být souvislý lokální blok segmentů uvnitř jednoho frame, ne motiv sesbíraný z nesousedících míst threadu.",
    "Jednosegmentový subframe je výjimka: použij ho jen pro neobvykle hutný user turn, který zakládá skutečnou lokální větev. Krátkou otázku nebo běžný posun dialogu samostatně neoznačuj.",
    "Toleruj krátké odbočky bez nutnosti vytvářet nový frame, pokud thread pořád zjevně sleduje jednu místní linii.",
    "Nevytvářej branch nebo return jen proto, že thread náhodně přeskakuje mezi nesouvisejícími mini-dotazy.",
    "Frames vrať v pořadí, v jakém se mají číst jako lokální outline threadu.",
    "Každý frame musí mít outlineRole: opening, development, branch, return, nebo conclusion.",
    "outlineRationale má krátce vysvětlit, proč frame hraje tuto roli v celku threadu.",
    "returnTargetSegmentId vyplň jen když outlineRole = return a pozdější fáze se vrací k dřívější místní větvi; jinak vrať null.",
    "segmentIds musí být přesné identifikátory z payloadu.",
    "Vrať pouze JSON podle schema. Žádný doprovodný text.",
    "",
    "Conversation payload:",
    payload
  ].join("\n");
}

function buildSourceDocumentFramePrompt(
  document: SourceLocalDocument,
  segments: OrderedSourceLocalSegment[]
): string {
  return document.sourceKind === "conversation"
    ? buildConversationDocumentFramePrompt(document, segments)
    : buildWritingDocumentFramePrompt(document, segments);
}

/**
 * Extract broader source-local frames for all supported local-source documents
 * before segment-level thought compilation runs.
 */
export function extractSourceDocumentFrames(
  corpus: UnifiedCorpus,
  corpusHash: string,
  sourceCorpusPath: string,
  paths: ProjectPaths,
  client: FrameExtractionClient,
  options?: {
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
    forceRefresh?: boolean;
    reusePolicy?: ThoughtSemanticReusePolicy;
    previousArtifact?: ThoughtDocumentFrameArtifact | null;
  }
): ThoughtDocumentFrameArtifact {
  const sourceDocuments = corpus.documents
    .filter(
      (document): document is SourceLocalDocument =>
        document.sourceKind === "writing" || document.sourceKind === "conversation"
    )
    .slice()
    .sort((left, right) => {
      if (left.sourceKind !== right.sourceKind) {
        return left.sourceKind.localeCompare(right.sourceKind);
      }
      return left.id.localeCompare(right.id);
    });

  const frames: ThoughtDocumentFrame[] = [];
  const subframes: ThoughtDocumentSubframe[] = [];
  const outlines: ThoughtDocumentOutline[] = [];
  const cacheBindings: NonNullable<ThoughtDocumentFrameArtifact["cacheBindings"]> = {};
  const schemaPath = `${paths.compiledDir}/thought-document-frame.schema.json`;
  const cache = options?.forceRefresh ? null : loadDocumentFrameCache(paths);
  ensureDocumentFrameSchemaFile(schemaPath);

  for (const document of sourceDocuments) {
    const segments = getSourceLocalPrimarySegments(corpus, document.id, document.sourceKind);
    if (segments.length === 0) {
      continue;
    }

    const resolvedCacheEntry = resolveReusableDocumentFrameCacheEntry(
      document,
      segments,
      cache,
      options
    );
    if (resolvedCacheEntry.entry) {
      frames.push(...resolvedCacheEntry.entry.frames);
      subframes.push(...resolvedCacheEntry.entry.subframes);
      outlines.push(...(resolvedCacheEntry.entry.outlines ?? []));
      cacheBindings[document.id] = {
        cacheKey: resolvedCacheEntry.cacheKey,
        segmentHash: resolvedCacheEntry.segmentHash,
        contractHash: resolvedCacheEntry.contractHash,
        model: resolvedCacheEntry.model,
        reasoningEffort: resolvedCacheEntry.reasoningEffort
      };
      continue;
    }

    const result = client.execSemanticBatch<RawDocumentFrameOutput>({
      prompt: buildSourceDocumentFramePrompt(document, segments),
      outputSchemaPath: schemaPath,
      model: options?.model ?? SECOND_BRAIN_DEFAULTS.codex.defaultModel ?? undefined,
      reasoningEffort:
        options?.reasoningEffort ?? SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort,
      workingDir: paths.root,
      extraWritableDirs: [paths.outputDir]
    });

    if (result.parsed.documentId !== document.id) {
      throw new Error(
        `Document frame output mismatch. Expected ${document.id}, received ${result.parsed.documentId}.`
      );
    }

    const materialized = materializeDocumentFrames(document, segments, result.parsed);
    frames.push(...materialized.frames);
    subframes.push(...materialized.subframes);
    outlines.push(...materialized.outlines);

    if (cache) {
      cache.entries[resolvedCacheEntry.cacheKey] = {
        cacheKey: resolvedCacheEntry.cacheKey,
        documentId: document.id,
        segmentHash: resolvedCacheEntry.segmentHash,
        contractHash: resolvedCacheEntry.contractHash,
        frames: materialized.frames,
        subframes: materialized.subframes,
        outlines: materialized.outlines,
        updatedAt: new Date().toISOString()
      };
      // A full corpus can require hundreds of independent frame calls. Persist
      // each validated document immediately so an auth/quota/process failure
      // resumes at the next document instead of discarding the whole pass.
      cache.generatedAt = new Date().toISOString();
      writeDocumentFrameCache(paths, cache);
    }

    cacheBindings[document.id] = {
      cacheKey: resolvedCacheEntry.cacheKey,
      segmentHash: resolvedCacheEntry.segmentHash,
      contractHash: resolvedCacheEntry.contractHash,
      model: resolvedCacheEntry.model,
      reasoningEffort: resolvedCacheEntry.reasoningEffort
    };
  }

  if (cache) {
    cache.generatedAt = new Date().toISOString();
    writeDocumentFrameCache(paths, cache);
  }

  return {
    generatedAt: new Date().toISOString(),
    sourceCorpusPath,
    corpusHash,
    model: options?.model ?? SECOND_BRAIN_DEFAULTS.codex.defaultModel ?? null,
    reasoningEffort:
      options?.reasoningEffort ?? SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort ?? null,
    documentCount: sourceDocuments.length,
    frameCount: frames.length,
    subframeCount: subframes.length,
    frames: frames.sort((left, right) => left.id.localeCompare(right.id)),
    subframes: subframes.sort((left, right) => left.id.localeCompare(right.id)),
    outlines: outlines.sort((left, right) => left.documentId.localeCompare(right.documentId)),
    cacheBindings
  };
}

/**
 * Backward-compatible alias kept while the repo migrates away from the older
 * writings-only naming.
 */
export function extractWritingDocumentFrames(
  corpus: UnifiedCorpus,
  corpusHash: string,
  sourceCorpusPath: string,
  paths: ProjectPaths,
  client: FrameExtractionClient,
  options?: {
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
    forceRefresh?: boolean;
    reusePolicy?: ThoughtSemanticReusePolicy;
    previousArtifact?: ThoughtDocumentFrameArtifact | null;
  }
): ThoughtDocumentFrameArtifact {
  return extractSourceDocumentFrames(corpus, corpusHash, sourceCorpusPath, paths, client, options);
}

/**
 * Build per-segment frame hints consumed by the later segment-level compiler.
 *
 * The segment compiler should not have to rediscover the broader writing
 * structure. It should receive that local parent frame explicitly.
 */
export function buildDocumentFrameHintLookup(
  artifact: ThoughtDocumentFrameArtifact
): Map<string, ThoughtBatchItem["documentFrameHint"]> {
  const subframesByFrameId = new Map<string, ThoughtDocumentSubframe[]>();
  for (const subframe of artifact.subframes) {
    const bucket = subframesByFrameId.get(subframe.frameId) ?? [];
    bucket.push(subframe);
    subframesByFrameId.set(subframe.frameId, bucket);
  }

  const lookup = new Map<string, ThoughtBatchItem["documentFrameHint"]>();
  for (const frame of artifact.frames) {
    const matchingSubframes = (subframesByFrameId.get(frame.id) ?? []).sort((left, right) =>
      left.id.localeCompare(right.id)
    );

    for (const segmentId of frame.segmentIds) {
      lookup.set(segmentId, {
        frameId: frame.id,
        label: frame.label,
        summary: frame.summary,
        scope: frame.scope,
        subframeHints: matchingSubframes
          .filter((subframe) => subframe.segmentIds.includes(segmentId))
          .map((subframe) => ({
            subframeId: subframe.id,
            label: subframe.label,
            summary: subframe.summary
          }))
      });
    }
  }

  return lookup;
}
