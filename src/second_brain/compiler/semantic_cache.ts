import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import type { ProjectPaths } from "../system/paths.js";
import type { UnifiedCorpus, UnifiedDocument, UnifiedSegment } from "../types/domain.js";
import type {
  ThoughtSemanticReusePolicy,
  ThoughtBatchItem,
  ThoughtBatchItemResult,
  ThoughtBatchOutput
} from "./types.js";

// Version 7 invalidates contributions whose local context predates bounded
// neighbor text. Otherwise old oversized-context results could be silently
// reused after the prompt contract changed.
const SEMANTIC_CACHE_VERSION = 7;
const SEGMENT_INDEX_VERSION = 3;
const SEGMENT_DIFF_SAMPLE_LIMIT = 25;

/**
 * The item cache is the durable unit of semantic incrementality.
 *
 * Batch checkpoints remain useful for recovering one interrupted run, but they
 * are too sensitive to corpus shape changes. This cache is keyed by the stable
 * segment payload plus local context and compiler contract, so a changed OpenAI
 * export bundle does not force unchanged segments back through Codex.
 */
export type SemanticContributionCache = {
  version: number;
  generatedAt: string;
  compilerContracts: Record<string, ThoughtCompilerContract>;
  entries: Record<string, SemanticContributionCacheEntry>;
};

export type ThoughtCompilerContract = {
  version: number;
  model: string | null;
  reasoningEffort: string | null;
};

export type SemanticContributionCacheEntry = {
  cacheKey: string;
  inputId: string;
  documentId: string;
  sourceKind: UnifiedSegment["sourceKind"];
  segmentTextHash: string;
  localContextHash: string;
  documentFrameHintHash: string;
  semanticInputHash: string;
  compilerContractHash: string;
  compilerContract: ThoughtCompilerContract;
  batchId: string;
  item: ThoughtBatchItemResult;
  updatedAt: string;
};

export type SegmentIndexArtifact = {
  version: number;
  generatedAt: string;
  corpusHash: string;
  documents: Record<string, SegmentIndexDocument>;
  segments: Record<string, SegmentIndexSegment>;
  stats: {
    documentCount: number;
    segmentCount: number;
    primarySegmentCount: number;
    primarySegmentsWithCachedContributions: number;
  };
  diff: SegmentIndexDiffSummary;
};

export type SegmentIndexDiffCounts = {
  unchangedCount: number;
  addedCount: number;
  changedCount: number;
  removedCount: number;
};

export type SegmentIndexDiffSummary = {
  previousGeneratedAt: string | null;
  previousCorpusHash: string | null;
  documents: SegmentIndexDiffCounts & {
    addedDocumentIds: string[];
    changedDocumentIds: string[];
    removedDocumentIds: string[];
  };
  primarySegments: SegmentIndexDiffCounts & {
    bySourceKind: Record<UnifiedSegment["sourceKind"], SegmentIndexDiffCounts>;
    addedSegmentIdsSample: string[];
    changedSegmentIdsSample: string[];
    removedSegmentIdsSample: string[];
  };
};

export type SegmentIndexDocument = {
  documentId: string;
  sourceKind: UnifiedDocument["sourceKind"];
  sourcePath: string;
  title: string;
  time: string | null;
  contentHash: string;
  primarySegmentIds: string[];
  metadata: UnifiedDocument["metadata"];
};

export type SegmentIndexSegment = {
  segmentId: string;
  documentId: string;
  sourceKind: UnifiedSegment["sourceKind"];
  segmentKind: UnifiedSegment["segmentKind"];
  signalKind: UnifiedSegment["signalKind"];
  sequenceIndex: number;
  time: string | null;
  textHash: string;
  sourcePath: string;
  sourceItemId: string | null;
  conversationId?: string;
  bundleName?: string;
  turnId?: string;
  messageId?: string;
  localContextHash?: string;
  documentFrameHintHash?: string;
  semanticInputHash?: string;
  semanticCacheKey?: string;
  semanticCompilerContractHash?: string;
  semanticCompilerModel?: string | null;
  semanticCompilerReasoningEffort?: string | null;
  hasSemanticContribution: boolean;
};

export type IncrementalSemanticPlan = {
  cachedOutputs: ThoughtBatchOutput[];
  pendingItems: ThoughtBatchItem[];
  reusableItemCount: number;
  reusedCurrentContractCount: number;
  reusedPriorContractCount: number;
  pendingItemCount: number;
  cachePath: string;
  segmentIndexPath: string;
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

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildSemanticInputHash(params: {
  inputId: string;
  textHash: string;
  localContextHash: string;
  documentFrameHintHash: string;
}): string {
  return hashStable({
    version: SEMANTIC_CACHE_VERSION,
    inputId: params.inputId,
    textHash: params.textHash,
    localContextHash: params.localContextHash,
    documentFrameHintHash: params.documentFrameHintHash
  });
}

function migrateLegacyCacheEntries(
  entries: Record<string, SemanticContributionCacheEntry> | undefined,
  legacyContract: ThoughtCompilerContract
): Record<string, SemanticContributionCacheEntry> {
  const migrated: Record<string, SemanticContributionCacheEntry> = {};
  const legacyContractHash = hashStable(legacyContract);

  for (const [cacheKey, entry] of Object.entries(entries ?? {})) {
    migrated[cacheKey] = {
      ...entry,
      semanticInputHash:
        entry.semanticInputHash ??
        buildSemanticInputHash({
          inputId: entry.inputId,
          textHash: entry.segmentTextHash,
          localContextHash: entry.localContextHash,
          documentFrameHintHash: entry.documentFrameHintHash
        }),
      compilerContractHash: entry.compilerContractHash ?? legacyContractHash,
      compilerContract: entry.compilerContract ?? legacyContract
    };
  }

  return migrated;
}

export function buildThoughtCompilerContract(options: {
  model?: string | null;
  reasoningEffort?: string | null;
}): ThoughtCompilerContract {
  return {
    version: SEMANTIC_CACHE_VERSION,
    model: options.model ?? null,
    reasoningEffort: options.reasoningEffort ?? null
  };
}

function getSemanticCacheDir(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "semantic-cache");
}

export function getSemanticContributionCachePath(paths: ProjectPaths): string {
  return path.join(getSemanticCacheDir(paths), "contribution_cache.json");
}

export function getSegmentIndexPath(paths: ProjectPaths): string {
  return path.join(getSemanticCacheDir(paths), "source_segment_index.json");
}

function loadPreviousSegmentIndexArtifact(paths: ProjectPaths): SegmentIndexArtifact | null {
  const target = getSegmentIndexPath(paths);
  if (!existsSync(target)) {
    return null;
  }

  return JSON.parse(readFileSync(target, "utf8")) as SegmentIndexArtifact;
}

export function loadSegmentIndexArtifact(paths: ProjectPaths): SegmentIndexArtifact | null {
  return loadPreviousSegmentIndexArtifact(paths);
}

export function loadSemanticContributionCache(
  paths: ProjectPaths,
  compilerContract: ThoughtCompilerContract
): SemanticContributionCache {
  const target = getSemanticContributionCachePath(paths);
  if (!existsSync(target)) {
    const contractHash = hashStable(compilerContract);
    return {
      version: SEMANTIC_CACHE_VERSION,
      generatedAt: new Date().toISOString(),
      compilerContracts: {
        [contractHash]: compilerContract
      },
      entries: {}
    };
  }

  const rawCache = JSON.parse(readFileSync(target, "utf8")) as
    | SemanticContributionCache
    | {
        version: number;
        generatedAt: string;
        compilerContract?: ThoughtCompilerContract;
        entries?: Record<string, SemanticContributionCacheEntry>;
      };
  const contractHash = hashStable(compilerContract);

  if (rawCache.version === 1) {
    const legacyCache = rawCache as {
      version: number;
      generatedAt: string;
      compilerContract?: ThoughtCompilerContract;
      entries?: Record<string, SemanticContributionCacheEntry>;
    };
    const legacyContract = legacyCache.compilerContract ?? compilerContract;
    const legacyContractHash = hashStable(legacyContract);
    return {
      version: SEMANTIC_CACHE_VERSION,
      generatedAt: legacyCache.generatedAt ?? new Date().toISOString(),
      compilerContracts: {
        [legacyContractHash]: legacyContract,
        [contractHash]: compilerContract
      },
      entries: migrateLegacyCacheEntries(legacyCache.entries, legacyContract)
    };
  }

  if (rawCache.version !== SEMANTIC_CACHE_VERSION) {
    return {
      version: SEMANTIC_CACHE_VERSION,
      generatedAt: new Date().toISOString(),
      compilerContracts: {
        [contractHash]: compilerContract
      },
      entries: {}
    };
  }

  const cache = rawCache as SemanticContributionCache;
  return {
    ...cache,
    compilerContracts: {
      ...cache.compilerContracts,
      [contractHash]: compilerContract
    }
  };
}

export function buildSemanticCacheKey(
  item: ThoughtBatchItem,
  compilerContract: ThoughtCompilerContract
): {
  cacheKey: string;
  segmentTextHash: string;
  localContextHash: string;
  documentFrameHintHash: string;
  compilerContractHash: string;
} {
  const segmentTextHash = hashText(item.text);
  const localContextHash = hashStable(item.localContext ?? null);
  const documentFrameHintHash = hashStable(item.documentFrameHint ?? null);
  const compilerContractHash = hashStable(compilerContract);

  return {
    segmentTextHash,
    localContextHash,
    documentFrameHintHash,
    compilerContractHash,
    cacheKey: hashStable({
      version: SEMANTIC_CACHE_VERSION,
      inputId: item.inputId,
      documentId: item.documentId,
      sourceKind: item.sourceKind,
      segmentTextHash,
      localContextHash,
      documentFrameHintHash,
      compilerContractHash
    })
  };
}

function entryMatchesSemanticInput(
  entry: SemanticContributionCacheEntry,
  item: ThoughtBatchItem,
  key: ReturnType<typeof buildSemanticCacheKey>
): boolean {
  return (
    entry.inputId === item.inputId &&
    entry.documentId === item.documentId &&
    entry.sourceKind === item.sourceKind &&
    entry.segmentTextHash === key.segmentTextHash &&
    entry.localContextHash === key.localContextHash &&
    entry.documentFrameHintHash === key.documentFrameHintHash
  );
}

// Mixed reuse deliberately trusts the previously active segment assignment
// before it looks for a newer contract match elsewhere in the cache. That
// keeps additive updates stable instead of silently "upgrading" old segments
// because a different experiment happened to populate another cache entry.
function resolveSemanticContributionEntry(params: {
  item: ThoughtBatchItem;
  cache: SemanticContributionCache;
  compilerContract: ThoughtCompilerContract;
  reusePolicy: ThoughtSemanticReusePolicy;
  previousArtifact: SegmentIndexArtifact | null;
}): {
  entry: SemanticContributionCacheEntry | null;
  semanticInputHash: string;
  semanticCacheKey: string | null;
  reuseSource: "current_contract" | "previous_active_contract" | null;
} {
  const key = buildSemanticCacheKey(params.item, params.compilerContract);
  const semanticInputHash = buildSemanticInputHash({
    inputId: params.item.inputId,
    textHash: key.segmentTextHash,
    localContextHash: key.localContextHash,
    documentFrameHintHash: key.documentFrameHintHash
  });

  if (params.reusePolicy === "mixed") {
    const previousSegment = params.previousArtifact?.segments[params.item.inputId];
    if (
      previousSegment?.semanticInputHash === semanticInputHash &&
      previousSegment.semanticCacheKey
    ) {
      const previousEntry = params.cache.entries[previousSegment.semanticCacheKey];
      if (previousEntry && entryMatchesSemanticInput(previousEntry, params.item, key)) {
        return {
          entry: previousEntry,
          semanticInputHash,
          semanticCacheKey: previousSegment.semanticCacheKey,
          reuseSource: "previous_active_contract"
        };
      }
    }
  }

  const currentEntry = params.cache.entries[key.cacheKey];
  if (currentEntry && entryMatchesSemanticInput(currentEntry, params.item, key)) {
    return {
      entry: currentEntry,
      semanticInputHash,
      semanticCacheKey: key.cacheKey,
      reuseSource: "current_contract"
    };
  }

  return {
    entry: null,
    semanticInputHash,
    semanticCacheKey: null,
    reuseSource: null
  };
}

export function planIncrementalSemanticCompile(
  paths: ProjectPaths,
  items: ThoughtBatchItem[],
  cache: SemanticContributionCache,
  compilerContract: ThoughtCompilerContract,
  reusePolicy: ThoughtSemanticReusePolicy
): IncrementalSemanticPlan {
  const previousArtifact = loadPreviousSegmentIndexArtifact(paths);
  const cachedOutputs: ThoughtBatchOutput[] = [];
  const pendingItems: ThoughtBatchItem[] = [];
  let reusedCurrentContractCount = 0;
  let reusedPriorContractCount = 0;

  for (const item of items) {
    const resolved = resolveSemanticContributionEntry({
      item,
      cache,
      compilerContract,
      reusePolicy,
      previousArtifact
    });

    if (resolved.entry && resolved.semanticCacheKey) {
      cachedOutputs.push({
        batchId: resolved.entry.batchId,
        items: [resolved.entry.item]
      });
      if (resolved.reuseSource === "current_contract") {
        reusedCurrentContractCount += 1;
      } else if (resolved.reuseSource === "previous_active_contract") {
        reusedPriorContractCount += 1;
      }
      continue;
    }

    pendingItems.push(item);
  }

  return {
    cachedOutputs,
    pendingItems,
    reusableItemCount: cachedOutputs.length,
    reusedCurrentContractCount,
    reusedPriorContractCount,
    pendingItemCount: pendingItems.length,
    cachePath: getSemanticContributionCachePath(paths),
    segmentIndexPath: getSegmentIndexPath(paths)
  };
}

export function upsertSemanticContributionCacheEntries(
  cache: SemanticContributionCache,
  batch: ThoughtBatchOutput,
  batchItems: ThoughtBatchItem[],
  compilerContract: ThoughtCompilerContract
): void {
  const batchItemByInputId = new Map(batchItems.map((item) => [item.inputId, item]));
  const now = new Date().toISOString();
  const compilerContractHash = hashStable(compilerContract);
  cache.compilerContracts[compilerContractHash] = compilerContract;

  for (const itemResult of batch.items) {
    const batchItem = batchItemByInputId.get(itemResult.inputId);
    if (!batchItem) {
      continue;
    }

    const key = buildSemanticCacheKey(batchItem, compilerContract);
    cache.entries[key.cacheKey] = {
      cacheKey: key.cacheKey,
      inputId: batchItem.inputId,
      documentId: batchItem.documentId,
      sourceKind: batchItem.sourceKind,
      segmentTextHash: key.segmentTextHash,
      localContextHash: key.localContextHash,
      documentFrameHintHash: key.documentFrameHintHash,
      semanticInputHash: buildSemanticInputHash({
        inputId: batchItem.inputId,
        textHash: key.segmentTextHash,
        localContextHash: key.localContextHash,
        documentFrameHintHash: key.documentFrameHintHash
      }),
      compilerContractHash: key.compilerContractHash,
      compilerContract,
      batchId: batch.batchId,
      item: itemResult,
      updatedAt: now
    };
  }

  cache.generatedAt = now;
}

export function writeSemanticContributionCache(
  paths: ProjectPaths,
  cache: SemanticContributionCache
): void {
  const target = getSemanticContributionCachePath(paths);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

export function writeSegmentIndexArtifact(
  paths: ProjectPaths,
  corpus: UnifiedCorpus,
  corpusHash: string,
  items: ThoughtBatchItem[],
  cache: SemanticContributionCache,
  compilerContract: ThoughtCompilerContract,
  reusePolicy: ThoughtSemanticReusePolicy
): SegmentIndexArtifact {
  const previousArtifact = loadPreviousSegmentIndexArtifact(paths);
  const primarySegmentIdsByDocumentId = new Map<string, string[]>();
  const semanticMetadataByInputId = new Map<
    string,
    {
      semanticCacheKey: string;
      localContextHash: string;
      documentFrameHintHash: string;
      semanticInputHash: string;
      semanticCompilerContractHash: string;
      semanticCompilerModel: string | null;
      semanticCompilerReasoningEffort: string | null;
    }
  >();

  for (const item of items) {
    const ids = primarySegmentIdsByDocumentId.get(item.documentId) ?? [];
    ids.push(item.inputId);
    primarySegmentIdsByDocumentId.set(item.documentId, ids);

    const key = buildSemanticCacheKey(item, compilerContract);
    const resolved = resolveSemanticContributionEntry({
      item,
      cache,
      compilerContract,
      reusePolicy,
      previousArtifact
    });
    if (resolved.entry && resolved.semanticCacheKey) {
      semanticMetadataByInputId.set(item.inputId, {
        semanticCacheKey: resolved.semanticCacheKey,
        localContextHash: key.localContextHash,
        documentFrameHintHash: key.documentFrameHintHash,
        semanticInputHash: resolved.semanticInputHash,
        semanticCompilerContractHash: resolved.entry.compilerContractHash,
        semanticCompilerModel: resolved.entry.compilerContract.model,
        semanticCompilerReasoningEffort: resolved.entry.compilerContract.reasoningEffort
      });
    }
  }

  const documents: Record<string, SegmentIndexDocument> = {};
  for (const document of corpus.documents) {
    documents[document.id] = {
      documentId: document.id,
      sourceKind: document.sourceKind,
      sourcePath: document.sourcePath,
      title: document.title,
      time: document.time,
      contentHash: hashStable({
        primaryText: document.primaryText,
        contextText: document.contextText,
        metadata: document.metadata
      }),
      primarySegmentIds: primarySegmentIdsByDocumentId.get(document.id) ?? [],
      metadata: document.metadata
    };
  }

  const segments: Record<string, SegmentIndexSegment> = {};
  let primarySegmentsWithCachedContributions = 0;
  for (const segment of corpus.segments) {
    const semanticMetadata = semanticMetadataByInputId.get(segment.id);
    const semanticCacheKey = semanticMetadata?.semanticCacheKey;
    const hasSemanticContribution = semanticCacheKey
      ? Boolean(cache.entries[semanticCacheKey])
      : false;

    if (semanticCacheKey && hasSemanticContribution) {
      primarySegmentsWithCachedContributions += 1;
    }

    segments[segment.id] = {
      segmentId: segment.id,
      documentId: segment.documentId,
      sourceKind: segment.sourceKind,
      segmentKind: segment.segmentKind,
      signalKind: segment.signalKind,
      sequenceIndex: segment.sequenceIndex,
      time: segment.time,
      textHash: hashText(segment.text),
      sourcePath: segment.sourceRef.sourcePath,
      sourceItemId: segment.sourceRef.sourceItemId,
      conversationId: segment.sourceRef.conversationId,
      bundleName: segment.sourceRef.bundleName,
      turnId: segment.sourceRef.turnId,
      messageId: segment.sourceRef.messageId,
      localContextHash: semanticMetadata?.localContextHash,
      documentFrameHintHash: semanticMetadata?.documentFrameHintHash,
      semanticInputHash: semanticMetadata?.semanticInputHash,
      semanticCacheKey,
      semanticCompilerContractHash: semanticMetadata?.semanticCompilerContractHash,
      semanticCompilerModel: semanticMetadata?.semanticCompilerModel,
      semanticCompilerReasoningEffort: semanticMetadata?.semanticCompilerReasoningEffort,
      hasSemanticContribution
    };
  }

  const diff = buildSegmentIndexDiffSummary(previousArtifact, documents, segments);

  const artifact: SegmentIndexArtifact = {
    version: SEGMENT_INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    corpusHash,
    documents,
    segments,
    stats: {
      documentCount: corpus.documents.length,
      segmentCount: corpus.segments.length,
      primarySegmentCount: corpus.stats.primarySegmentCount,
      primarySegmentsWithCachedContributions
    },
    diff
  };

  const target = getSegmentIndexPath(paths);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

function createEmptyDiffCounts(): SegmentIndexDiffCounts {
  return {
    unchangedCount: 0,
    addedCount: 0,
    changedCount: 0,
    removedCount: 0
  };
}

function pushSample(target: string[], value: string): void {
  if (target.length < SEGMENT_DIFF_SAMPLE_LIMIT) {
    target.push(value);
  }
}

function buildSegmentIndexDiffSummary(
  previousArtifact: SegmentIndexArtifact | null,
  documents: Record<string, SegmentIndexDocument>,
  segments: Record<string, SegmentIndexSegment>
): SegmentIndexDiffSummary {
  const previousDocuments = previousArtifact?.documents ?? {};
  const previousSegments = previousArtifact?.segments ?? {};
  const documentDiff = {
    ...createEmptyDiffCounts(),
    addedDocumentIds: [] as string[],
    changedDocumentIds: [] as string[],
    removedDocumentIds: [] as string[]
  };
  const primarySegmentDiff = {
    ...createEmptyDiffCounts(),
    bySourceKind: {
      writing: createEmptyDiffCounts(),
      conversation: createEmptyDiffCounts(),
      chat: createEmptyDiffCounts()
    } satisfies Record<UnifiedSegment["sourceKind"], SegmentIndexDiffCounts>,
    addedSegmentIdsSample: [] as string[],
    changedSegmentIdsSample: [] as string[],
    removedSegmentIdsSample: [] as string[]
  };

  for (const [documentId, document] of Object.entries(documents)) {
    const previous = previousDocuments[documentId];
    if (!previous) {
      documentDiff.addedCount += 1;
      documentDiff.addedDocumentIds.push(documentId);
      continue;
    }

    if (previous.contentHash === document.contentHash) {
      documentDiff.unchangedCount += 1;
    } else {
      documentDiff.changedCount += 1;
      documentDiff.changedDocumentIds.push(documentId);
    }
  }

  for (const documentId of Object.keys(previousDocuments)) {
    if (documents[documentId]) {
      continue;
    }

    documentDiff.removedCount += 1;
    documentDiff.removedDocumentIds.push(documentId);
  }

  const currentPrimarySegments = Object.values(segments).filter((segment) => segment.signalKind === "primary");
  const previousPrimarySegments = Object.values(previousSegments).filter((segment) => segment.signalKind === "primary");
  const previousPrimaryById = new Map(previousPrimarySegments.map((segment) => [segment.segmentId, segment]));

  for (const segment of currentPrimarySegments) {
    const previous = previousPrimaryById.get(segment.segmentId);
    const sourceKindDiff = primarySegmentDiff.bySourceKind[segment.sourceKind];

    if (!previous) {
      primarySegmentDiff.addedCount += 1;
      sourceKindDiff.addedCount += 1;
      pushSample(primarySegmentDiff.addedSegmentIdsSample, segment.segmentId);
      continue;
    }

    if (previous.semanticInputHash === segment.semanticInputHash) {
      primarySegmentDiff.unchangedCount += 1;
      sourceKindDiff.unchangedCount += 1;
    } else {
      primarySegmentDiff.changedCount += 1;
      sourceKindDiff.changedCount += 1;
      pushSample(primarySegmentDiff.changedSegmentIdsSample, segment.segmentId);
    }
  }

  for (const segment of previousPrimarySegments) {
    if (segments[segment.segmentId]) {
      continue;
    }

    primarySegmentDiff.removedCount += 1;
    primarySegmentDiff.bySourceKind[segment.sourceKind].removedCount += 1;
    pushSample(primarySegmentDiff.removedSegmentIdsSample, segment.segmentId);
  }

  return {
    previousGeneratedAt: previousArtifact?.generatedAt ?? null,
    previousCorpusHash: previousArtifact?.corpusHash ?? null,
    documents: documentDiff,
    primarySegments: primarySegmentDiff
  };
}
