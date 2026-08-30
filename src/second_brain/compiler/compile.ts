import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  CodexCliClient,
  CodexCliError,
  type CodexFailureKind,
  type CodexReasoningEffort
} from "../codex/client.js";
import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import type { ProjectPaths } from "../system/paths.js";
import type { UnifiedCorpus } from "../types/domain.js";
import { ThrottledProgressReporter, type ProgressWriter } from "../utils/progress.js";
import { slugify } from "../utils/text.js";
import {
  buildThoughtCompilerBatchItems,
  buildThoughtCompilerBatches,
  buildThoughtCompilerBatchesFromItems
} from "./batching.js";
import { extractSourceDocumentFrames } from "./document_frames.js";
import { buildThoughtCompilationArtifacts } from "./merge.js";
import { buildExistingNodeHints, buildThoughtBatchPrompt } from "./prompt.js";
import { THOUGHT_BATCH_OUTPUT_SCHEMA } from "./schema.js";
import {
  buildThoughtCompilerContract,
  getSegmentIndexPath,
  getSemanticContributionCachePath,
  type SegmentIndexArtifact,
  loadSemanticContributionCache,
  planIncrementalSemanticCompile,
  upsertSemanticContributionCacheEntries,
  writeSegmentIndexArtifact,
  writeSemanticContributionCache,
  type SemanticContributionCache
} from "./semantic_cache.js";
import {
  computeStableUnifiedCorpusHash,
  ensureThoughtCompilerRunLayout,
  getThoughtCompilerRunPaths,
  loadLatestThoughtDocumentFrameArtifact,
  loadThoughtBatchOutputs,
  loadThoughtCompilerCheckpoint,
  loadThoughtDocumentFrameArtifact,
  writeThoughtBatchOutput,
  writeThoughtCompilationArtifacts,
  writeThoughtCompilerRunState,
} from "./state.js";
import type {
  ThoughtBatchOutput,
  ThoughtCompilerBatch,
  ThoughtCompilerIncrementalMode,
  ThoughtCompilerIncrementalSummary,
  ThoughtCompilerInvocationSummary,
  ThoughtSemanticReusePolicy,
  ThoughtCompilerRunState,
  ThoughtCompilerRunStatus,
  ThoughtRelationProposal,
  ThoughtNodeCandidate,
  ThoughtCompilerSource
} from "./types.js";

const THOUGHT_COMPILER_DEFAULTS = SECOND_BRAIN_DEFAULTS.thoughtCompiler;
const MAX_STRUCTURED_OUTPUT_RETRIES = 2;
const MIN_WRITING_ITEMS_FOR_DENSITY_CHECK = 3;
const MIN_AUTHORED_WRITING_AVG_CANDIDATES = 1.5;
const MIN_AUTHORED_WRITING_CHARS_FOR_DENSITY_CHECK = 220;

type SemanticClient = Pick<CodexCliClient, "execSemanticBatch">;

/**
 * Runtime options for one thought-node compiler invocation.
 */
export type CompileThoughtNodesOptions = {
  batchSize?: number;
  maxBatches?: number | null;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  semanticReusePolicy?: ThoughtSemanticReusePolicy;
  forceNewRun?: boolean;
  ignoreCheckpoint?: boolean;
  forceSingletonRepairBatchId?: string | null;
  progress?: ProgressWriter;
};

// The compiler always starts from the unified corpus. This keeps the Codex
// stage simple: by the time we get here, source-specific parsing is over and we
// can think only in terms of normalized documents/segments.
function loadThoughtCompilerSource(paths: ProjectPaths): ThoughtCompilerSource {
  const corpusPath = path.join(paths.normalizedUnifiedDir, "corpus.json");
  if (!existsSync(corpusPath)) {
    throw new Error(
      `Unified corpus not found at ${corpusPath}. Run normalization before thought compilation.`
    );
  }

  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as UnifiedCorpus;
  return {
    corpus,
    corpusHash: computeStableUnifiedCorpusHash(corpusPath),
    corpusPath
  };
}

// One run state corresponds to one stable normalized corpus hash and one batch
// layout. If either changes, we intentionally start a new run rather than
// trying to resume against mismatched inputs.
function createInitialRunState(source: ThoughtCompilerSource, batchSize: number, options: CompileThoughtNodesOptions, totalBatchCount: number): ThoughtCompilerRunState {
  const now = new Date().toISOString();
  const resolvedModel = options.model ?? SECOND_BRAIN_DEFAULTS.codex.defaultModel;
  const resolvedReasoningEffort =
    options.reasoningEffort ?? SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort;
  const compilerContract = buildThoughtCompilerContract({
    model: resolvedModel,
    reasoningEffort: resolvedReasoningEffort
  });

  return {
    runId: `thought-compiler-${now.replace(/[:.]/g, "-")}`,
    sourceCorpusPath: source.corpusPath,
    corpusHash: source.corpusHash,
    batchSize,
    softInputTokenBudget: THOUGHT_COMPILER_DEFAULTS.softInputTokenBudget,
    totalBatchCount,
    completedBatchIds: [],
    lastSuccessfulBatchId: null,
    lastSuccessfulInputId: null,
    status: "in_progress",
    failureKind: null,
    failureMessage: null,
    compilerContractVersion: compilerContract.version,
    model: resolvedModel,
    reasoningEffort: resolvedReasoningEffort,
    startedAt: now,
    updatedAt: now,
    completedAt: null
  };
}

function resumeOrCreateRunState(
  paths: ProjectPaths,
  source: ThoughtCompilerSource,
  batches: ThoughtCompilerBatch[],
  options: CompileThoughtNodesOptions
): ThoughtCompilerRunState {
  const batchSize = options.batchSize ?? THOUGHT_COMPILER_DEFAULTS.batchSize;
  const resolvedModel = options.model ?? SECOND_BRAIN_DEFAULTS.codex.defaultModel;
  const resolvedReasoningEffort =
    options.reasoningEffort ?? SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort;
  const compilerContract = buildThoughtCompilerContract({
    model: resolvedModel,
    reasoningEffort: resolvedReasoningEffort
  });
  // `ignoreCheckpoint` is used when the semantic contract changed but valid
  // document frames should remain reusable. It must bypass batch completion
  // state here as well as in incremental planning, otherwise pending items are
  // silently skipped by a completed checkpoint from the previous contract.
  const existing =
    options.forceNewRun || options.ignoreCheckpoint
      ? null
      : loadThoughtCompilerCheckpoint(paths);

  if (
    existing &&
    existing.corpusHash === source.corpusHash &&
    existing.batchSize === batchSize &&
    existing.totalBatchCount === batches.length &&
    existing.compilerContractVersion === compilerContract.version &&
    existing.model === resolvedModel &&
    existing.reasoningEffort === resolvedReasoningEffort
  ) {
    // Resume is intentionally strict about the corpus and batch layout, but a
    // completed run is still reusable. Model/effort must also match so one run
    // never silently reuses semantic output from a different compiler contract.
    return {
      ...existing,
      status: "in_progress",
      updatedAt: new Date().toISOString()
    };
  }

  return createInitialRunState(source, batchSize, options, batches.length);
}

function ensureBatchSchemaFile(target: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(THOUGHT_BATCH_OUTPUT_SCHEMA, null, 2)}\n`, "utf8");
}

// Sanitize model output aggressively before persisting it. This is where we
// normalize canonical keys, strip empty aliases, and dedupe relation proposals
// so later deterministic merge logic gets a stable input shape.
function sanitizeNodeCandidate(candidate: ThoughtNodeCandidate): ThoughtNodeCandidate {
  const canonicalKey = slugify(candidate.canonicalKey || candidate.title);
  const relatedCanonicalKeys = Array.from(
    new Set(
      candidate.relatedCanonicalKeys
        .map((value) => slugify(value))
        .filter((value) => value.length > 0 && value !== canonicalKey)
    )
  ).sort((left, right) => left.localeCompare(right));
  const relationProposalsByKey = new Map<string, ThoughtRelationProposal>();
  for (const proposal of candidate.relationProposals ?? []) {
    const targetCanonicalKey = slugify(proposal.targetCanonicalKey);
    if (targetCanonicalKey.length === 0 || targetCanonicalKey === canonicalKey) {
      continue;
    }

    relationProposalsByKey.set(`${proposal.type}:${targetCanonicalKey}`, {
      targetCanonicalKey,
      type: proposal.type,
      rationale: proposal.rationale.trim()
    });
  }

  const relationProposals = Array.from(relationProposalsByKey.values()).sort((left, right) => {
    if (left.type !== right.type) {
      return left.type.localeCompare(right.type);
    }

    return left.targetCanonicalKey.localeCompare(right.targetCanonicalKey);
  });

  const documentFrameId = candidate.documentFrameId?.trim() || null;
  const documentSubframeId = candidate.documentSubframeId?.trim() || null;
  const frameRole = candidate.frameRole ?? null;

  return {
    canonicalKey: canonicalKey || "untitled-thought",
    title: candidate.title.trim() || candidate.canonicalKey.trim() || "Nezařazená myšlenka",
    nodeType: candidate.nodeType,
    status: candidate.status,
    summary: candidate.summary.trim(),
    rationale: candidate.rationale.trim(),
    claim: candidate.claim?.trim() || undefined,
    identityAliases: (candidate.identityAliases ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
    documentFrameId,
    documentSubframeId,
    frameRole,
    relatedCanonicalKeys,
    relationProposals
  };
}

// Codex must return one row per input item and keep the original order. If that
// contract drifts, later checkpointing and provenance become unreliable.
function validateThoughtBatchOutput(
  batch: ThoughtCompilerBatch,
  output: ThoughtBatchOutput
): ThoughtBatchOutput {
  if (output.batchId !== batch.batchId) {
    throw new Error(
      `Batch output batchId mismatch. Expected ${batch.batchId}, received ${output.batchId}.`
    );
  }

  const expectedInputIds = batch.items.map((item) => item.inputId);
  const actualInputIds = output.items.map((item) => item.inputId);

  if (expectedInputIds.length !== actualInputIds.length) {
    throw new Error(
      `Batch ${batch.batchId} returned ${actualInputIds.length} items for ${expectedInputIds.length} inputs.`
    );
  }

  for (let index = 0; index < expectedInputIds.length; index += 1) {
    if (expectedInputIds[index] !== actualInputIds[index]) {
      throw new Error(
        `Batch ${batch.batchId} returned inputId ${actualInputIds[index]} at index ${index}, expected ${expectedInputIds[index]}.`
      );
    }
  }

  const batchItemByInputId = new Map(batch.items.map((item) => [item.inputId, item]));

  const sanitizedOutput = {
    batchId: output.batchId,
    items: output.items.map((item) => ({
      inputId: item.inputId,
      nodeCandidates: item.nodeCandidates.map((candidate) => {
        const sanitizedCandidate = sanitizeNodeCandidate(candidate);
        const batchItem = batchItemByInputId.get(item.inputId);
        const frameHint = batchItem?.documentFrameHint ?? null;

        if (!frameHint) {
          return {
            ...sanitizedCandidate,
            documentFrameId: null,
            documentSubframeId: null,
            frameRole: null
          };
        }

        const validSubframeIds = new Set(
          frameHint.subframeHints.map((subframe) => subframe.subframeId)
        );
        const documentFrameId =
          sanitizedCandidate.documentFrameId === frameHint.frameId
            ? sanitizedCandidate.documentFrameId
            : frameHint.frameId;
        const documentSubframeId =
          sanitizedCandidate.documentSubframeId &&
          validSubframeIds.has(sanitizedCandidate.documentSubframeId)
            ? sanitizedCandidate.documentSubframeId
            : null;

        return {
          ...sanitizedCandidate,
          documentFrameId,
          documentSubframeId
        };
      })
    }))
  };

  validateSemanticBatchDensity(batch, sanitizedOutput);
  return sanitizedOutput;
}

function validateSemanticBatchDensity(
  batch: ThoughtCompilerBatch,
  output: ThoughtBatchOutput
): void {
  const itemByInputId = new Map(batch.items.map((item) => [item.inputId, item]));
  const authoredWritingRows = output.items
    .map((item) => ({
      item,
      batchItem: itemByInputId.get(item.inputId)
    }))
    .filter(
      (row): row is { item: ThoughtBatchOutput["items"][number]; batchItem: ThoughtCompilerBatch["items"][number] } =>
        row.batchItem?.sourceKind === "writing" &&
        row.batchItem.text.trim().length >= MIN_AUTHORED_WRITING_CHARS_FOR_DENSITY_CHECK
    );

  if (authoredWritingRows.length >= MIN_WRITING_ITEMS_FOR_DENSITY_CHECK) {
    const candidateCount = authoredWritingRows.reduce(
      (total, row) => total + row.item.nodeCandidates.length,
      0
    );
    const average = candidateCount / authoredWritingRows.length;
    if (average < MIN_AUTHORED_WRITING_AVG_CANDIDATES) {
      const sparseInputIds = authoredWritingRows
        .filter((row) => row.item.nodeCandidates.length <= 1)
        .map((row) => row.item.inputId)
        .slice(0, 8);
      throw new Error(
        `Batch ${batch.batchId} failed semantic quality density check: authored writing segments averaged ${average.toFixed(2)} node candidates; expected at least ${MIN_AUTHORED_WRITING_AVG_CANDIDATES.toFixed(2)}. Sparse inputs: ${sparseInputIds.join(", ")}`
      );
    }
  }

}

function isRetriableBatchOutputError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    (error.message.includes("returned") &&
      (error.message.includes("items for") || error.message.includes("expected"))) ||
    error.message.includes("failed semantic quality density check")
  );
}

function buildDensityRepairTarget(
  batch: ThoughtCompilerBatch,
  error: Error
): string | null {
  if (!error.message.includes("failed semantic quality density check")) {
    return null;
  }

  const eligibleItemCount = batch.items.filter(
    (item) =>
      item.sourceKind === "writing" &&
      item.text.trim().length >= MIN_AUTHORED_WRITING_CHARS_FOR_DENSITY_CHECK
  ).length;
  const requiredCandidateCount = Math.ceil(
    eligibleItemCount * MIN_AUTHORED_WRITING_AVG_CANDIDATES
  );
  return `Across the ${eligibleItemCount} eligible authored-writing rows, return at least ${requiredCandidateCount} semantically distinct nodeCandidates in total.`;
}

function executeValidatedBatch(
  client: SemanticClient,
  batch: ThoughtCompilerBatch,
  currentGraph: ReturnType<typeof buildThoughtCompilationArtifacts>["graph"],
  runPaths: ReturnType<typeof getThoughtCompilerRunPaths>,
  paths: ProjectPaths,
  options: CompileThoughtNodesOptions,
  progress: ThrottledProgressReporter
): ThoughtBatchOutput {
  let validatedOutput: ThoughtBatchOutput | null = null;
  let lastRetryableError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_STRUCTURED_OUTPUT_RETRIES; attempt += 1) {
    const prompt = buildThoughtBatchPrompt(batch, {
      existingNodeHints: buildExistingNodeHints(currentGraph.nodes)
    });
    const densityRepairTarget = lastRetryableError
      ? buildDensityRepairTarget(batch, lastRetryableError)
      : null;
    const retrySuffix =
      attempt === 0
        ? ""
        : [
            "",
            "CRITICAL OUTPUT REPAIR:",
            `Your previous response for ${batch.batchId} violated the structured or semantic-density contract.`,
            `Previous validator error: ${lastRetryableError?.message ?? "unknown validation failure"}`,
            densityRepairTarget,
            `Return exactly ${batch.items.length} items in the exact same inputId order as provided.`,
            "Do not add, merge, duplicate, or omit any input rows.",
            "The density target is a batch-level minimum, not a command to duplicate every row. Concentrate additional candidates in the sparse inputIds named by the validator, and only where the text contains genuinely distinct durable signals.",
            "For authored writing paragraphs, do not collapse distinct theses, tensions, revisions, and framing questions into one broad candidate.",
            `When a writing paragraph carries multiple durable signals, return 2-${THOUGHT_COMPILER_DEFAULTS.maxCandidatesPerInput} nodeCandidates rather than one generic umbrella node.`,
            "For long reflective conversation turns, separately preserve durable theses, limits or counterarguments, revisions, consequences, and open questions when more than one is present.",
            "For very long reflective turns, rescan the full text for a main claim, its limit or counterargument, an open question, and a distinct consequence before returning.",
            "Do not inflate operational requests, search instructions, formatting requests, thanks, or transitional dialogue merely to satisfy density."
          ]
            .filter((line): line is string => line !== null)
            .join("\n");
    const result = client.execSemanticBatch<ThoughtBatchOutput>({
      prompt: `${prompt}${retrySuffix}`,
      outputSchemaPath: runPaths.schemaPath,
      model: options.model ?? SECOND_BRAIN_DEFAULTS.codex.defaultModel ?? undefined,
      reasoningEffort:
        options.reasoningEffort ?? SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort,
      workingDir: paths.root,
      extraWritableDirs: [paths.outputDir]
    });

    try {
      validatedOutput = validateThoughtBatchOutput(batch, result.parsed);
      lastRetryableError = null;
      break;
    } catch (error) {
      if (
        attempt < MAX_STRUCTURED_OUTPUT_RETRIES &&
        isRetriableBatchOutputError(error)
      ) {
        lastRetryableError = error;
        progress.phase(
          "compile",
          `retrying ${batch.batchId} after invalid batch output (${attempt + 1}/${MAX_STRUCTURED_OUTPUT_RETRIES}): ${error.message}`
        );
        continue;
      }

      throw error;
    }
  }

  if (!validatedOutput) {
    throw lastRetryableError ?? new Error(`Batch ${batch.batchId} did not produce valid output.`);
  }

  return validatedOutput;
}

function mergeFallbackOutputs(
  batch: ThoughtCompilerBatch,
  outputs: ThoughtBatchOutput[]
): ThoughtBatchOutput {
  return {
    batchId: batch.batchId,
    items: outputs.flatMap((output) => output.items)
  };
}

function executeBatchViaSingletonRepair(
  client: SemanticClient,
  batch: ThoughtCompilerBatch,
  currentGraph: ReturnType<typeof buildThoughtCompilationArtifacts>["graph"],
  runPaths: ReturnType<typeof getThoughtCompilerRunPaths>,
  paths: ProjectPaths,
  options: CompileThoughtNodesOptions,
  progress: ThrottledProgressReporter
): ThoughtBatchOutput {
  progress.phase(
    "compile",
    `forcing singleton repair for ${batch.batchId}`
  );

  const singletonOutputs = batch.items.map((item, index) =>
    executeValidatedBatch(
      client,
      {
        batchId: `${batch.batchId}-repair-${String(index + 1).padStart(2, "0")}`,
        batchIndex: batch.batchIndex,
        estimatedInputTokens: item.estimatedTokens,
        items: [item]
      },
      currentGraph,
      runPaths,
      paths,
      options,
      progress
    )
  );

  return mergeFallbackOutputs(batch, singletonOutputs);
}

function deriveFailureStatus(kind: CodexFailureKind): ThoughtCompilerRunStatus {
  if (kind === "auth") {
    return "paused_auth";
  }
  if (kind === "quota") {
    return "paused_quota";
  }
  return "failed";
}

// CLI output is intentionally small and operational. The detailed artifact
// inspection happens through JSON files on disk, not by bloating terminal output.
function finalizeSummary(
  runPaths: ReturnType<typeof getThoughtCompilerRunPaths>,
  state: ThoughtCompilerRunState,
  processedBatchCount: number,
  reusedSemanticItemCount: number,
  pendingSemanticItemCount: number,
  semanticCachePath: string | null,
  segmentIndexPath: string | null,
  compileManifestPath: string | null,
  incremental: ThoughtCompilerIncrementalSummary
): ThoughtCompilerInvocationSummary {
  return {
    runId: state.runId,
    status: state.status,
    success: state.status === "completed",
    corpusHash: state.corpusHash,
    totalBatchCount: state.totalBatchCount,
    completedBatchCount: state.completedBatchIds.length,
    processedBatchCount,
    reusedSemanticItemCount,
    pendingSemanticItemCount,
    remainingBatchCount: state.totalBatchCount - state.completedBatchIds.length,
    lastSuccessfulBatchId: state.lastSuccessfulBatchId,
    failureKind: state.failureKind,
    failureMessage: state.failureMessage,
    checkpointPath: runPaths.checkpointPath,
    runStatePath: runPaths.runStatePath,
    nodesPath: runPaths.nodesPath,
    edgesPath: runPaths.edgesPath,
    graphPath: runPaths.graphPath,
    semanticCachePath,
    segmentIndexPath,
    compileManifestPath,
    incremental
  };
}

function deriveIncrementalMode(options: CompileThoughtNodesOptions, canResumeExactBatchRun: boolean): ThoughtCompilerIncrementalMode {
  if (options.forceNewRun) {
    return "force_new_run";
  }

  if (canResumeExactBatchRun) {
    return "exact_run_resume";
  }

  return "incremental_cache";
}

function buildIncrementalSummary(params: {
  mode: ThoughtCompilerIncrementalMode;
  reusePolicy: ThoughtSemanticReusePolicy;
  primarySegmentCount: number;
  reusedSemanticItemCount: number;
  reusedCurrentContractCount: number;
  reusedPriorContractCount: number;
  pendingSemanticItemCount: number;
  segmentIndexArtifact: SegmentIndexArtifact;
}): ThoughtCompilerIncrementalSummary {
  const semanticItems =
    params.mode === "exact_run_resume"
      ? null
      : {
          totalPrimarySegmentCount: params.primarySegmentCount,
          reusedCount: params.reusedSemanticItemCount,
          reusedCurrentContractCount: params.reusedCurrentContractCount,
          reusedPriorContractCount: params.reusedPriorContractCount,
          newCount: params.pendingSemanticItemCount
        };

  return {
    mode: params.mode,
    reusePolicy: params.reusePolicy,
    semanticItems,
    sourceDiff: params.segmentIndexArtifact.diff
  };
}

function writeCompileManifest(
  target: string,
  summary: ThoughtCompilerInvocationSummary
): string {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return target;
}

function checkpointMatchesBatchLayout(
  checkpoint: ThoughtCompilerRunState | null,
  source: ThoughtCompilerSource,
  batchSize: number,
  batches: ThoughtCompilerBatch[],
  compilerContractVersion: number,
  model: string | null,
  reasoningEffort: CodexReasoningEffort | null
): boolean {
  return Boolean(
    checkpoint &&
      checkpoint.corpusHash === source.corpusHash &&
      checkpoint.batchSize === batchSize &&
      checkpoint.totalBatchCount === batches.length &&
      checkpoint.compilerContractVersion === compilerContractVersion &&
      checkpoint.model === model &&
      checkpoint.reasoningEffort === reasoningEffort
  );
}

function upsertCompletedOutputsIntoCache(
  cache: SemanticContributionCache,
  outputs: ThoughtBatchOutput[],
  allItems: ThoughtCompilerBatch["items"],
  compilerContract: ReturnType<typeof buildThoughtCompilerContract>
): void {
  for (const output of outputs) {
    upsertSemanticContributionCacheEntries(cache, output, allItems, compilerContract);
  }
}

function canReuseCompiledDocumentFrameArtifact(params: {
  artifact: ReturnType<typeof loadThoughtDocumentFrameArtifact>;
  reusePolicy: ThoughtSemanticReusePolicy;
  model: string | null;
  reasoningEffort: CodexReasoningEffort | null;
  checkpoint: ThoughtCompilerRunState | null;
  corpusHash: string;
}): boolean {
  if (!params.artifact || params.artifact.corpusHash !== params.corpusHash) {
    return false;
  }

  if (params.reusePolicy === "mixed") {
    return true;
  }

  if (
    params.checkpoint &&
    params.checkpoint.corpusHash === params.corpusHash &&
    params.checkpoint.model === params.model &&
    params.checkpoint.reasoningEffort === params.reasoningEffort
  ) {
    return true;
  }

  return (
    (params.artifact.model ?? null) === params.model &&
    (params.artifact.reasoningEffort ?? null) === params.reasoningEffort
  );
}

/**
 * Run or resume the first Codex-based thought-node compiler pass.
 */
export function compileThoughtNodes(
  paths: ProjectPaths,
  client: SemanticClient,
  options: CompileThoughtNodesOptions = {}
): ThoughtCompilerInvocationSummary {
  const progress = new ThrottledProgressReporter(options.progress);
  progress.phase("compile", "loading unified corpus");
  const source = loadThoughtCompilerSource(paths);
  const resolvedModel = options.model ?? SECOND_BRAIN_DEFAULTS.codex.defaultModel ?? null;
  const resolvedReasoningEffort =
    options.reasoningEffort ?? SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort ?? null;
  const semanticReusePolicy =
    options.semanticReusePolicy ?? SECOND_BRAIN_DEFAULTS.thoughtCompiler.semanticReusePolicy;
  const compilerContract = buildThoughtCompilerContract({
    model: resolvedModel,
    reasoningEffort: resolvedReasoningEffort
  });
  const existingCheckpoint =
    options.forceNewRun || options.ignoreCheckpoint ? null : loadThoughtCompilerCheckpoint(paths);
  progress.phase("compile", "loading or extracting source-local document frames");
  const compiledDocumentFrames = options.forceNewRun
    ? null
    : loadThoughtDocumentFrameArtifact(paths, source.corpusHash);
  const documentFrames =
    canReuseCompiledDocumentFrameArtifact({
      artifact: compiledDocumentFrames,
      reusePolicy: semanticReusePolicy,
      model: resolvedModel,
      reasoningEffort: resolvedReasoningEffort,
      checkpoint: existingCheckpoint,
      corpusHash: source.corpusHash
    })
      ? compiledDocumentFrames
      : extractSourceDocumentFrames(source.corpus, source.corpusHash, source.corpusPath, paths, client, {
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          forceRefresh: options.forceNewRun,
          reusePolicy: semanticReusePolicy,
          previousArtifact: options.forceNewRun ? null : loadLatestThoughtDocumentFrameArtifact(paths)
        });
  const batchSize = options.batchSize ?? THOUGHT_COMPILER_DEFAULTS.batchSize;
  const allItems = buildThoughtCompilerBatchItems(source.corpus, documentFrames);
  const fullBatches = buildThoughtCompilerBatches(source.corpus, {
    batchSize,
    softInputTokenBudget: THOUGHT_COMPILER_DEFAULTS.softInputTokenBudget,
      documentFrames
  });
  const canResumeExactBatchRun = checkpointMatchesBatchLayout(
    existingCheckpoint,
    source,
    batchSize,
    fullBatches,
    compilerContract.version,
    resolvedModel,
    resolvedReasoningEffort
  );
  const semanticCache = loadSemanticContributionCache(paths, compilerContract);
  const incrementalPlan =
    canResumeExactBatchRun || options.forceNewRun
      ? null
      : planIncrementalSemanticCompile(
          paths,
          allItems,
          semanticCache,
          compilerContract,
          semanticReusePolicy
        );
  const batches = incrementalPlan
    ? buildThoughtCompilerBatchesFromItems(incrementalPlan.pendingItems, {
        batchSize,
        softInputTokenBudget: THOUGHT_COMPILER_DEFAULTS.softInputTokenBudget
      })
    : fullBatches;
  const reusedSemanticItemCount = incrementalPlan?.reusableItemCount ?? 0;
  const reusedCurrentContractCount = incrementalPlan?.reusedCurrentContractCount ?? 0;
  const reusedPriorContractCount = incrementalPlan?.reusedPriorContractCount ?? 0;
  const pendingSemanticItemCount = incrementalPlan?.pendingItemCount ?? allItems.length;
  progress.phase(
    "compile",
    incrementalPlan
      ? `prepared ${batches.length} incremental semantic batches from ${pendingSemanticItemCount} uncached primary segments (${reusedSemanticItemCount} reused; ${reusedPriorContractCount} from prior contract)`
      : `prepared ${batches.length} semantic batches from ${source.corpus.stats.primarySegmentCount} primary segments`
  );
  const state = resumeOrCreateRunState(paths, source, batches, options);
  const runPaths = getThoughtCompilerRunPaths(paths, state.runId);

  ensureThoughtCompilerRunLayout(runPaths);
  ensureBatchSchemaFile(runPaths.schemaPath);
  writeThoughtCompilerRunState(runPaths, state);

  const completedBatchIds = new Set(state.completedBatchIds);
  if (state.completedBatchIds.length > 0) {
    progress.phase(
      "compile",
      `resuming run ${state.runId} from ${state.completedBatchIds.length}/${batches.length} completed batches`
    );
  } else {
    progress.phase("compile", `starting run ${state.runId}`);
  }
  const runCompletedOutputs = loadThoughtBatchOutputs(runPaths);
  upsertCompletedOutputsIntoCache(
    semanticCache,
    runCompletedOutputs,
    allItems,
    compilerContract
  );
  const completedOutputs = [
    ...(incrementalPlan?.cachedOutputs ?? []),
    ...runCompletedOutputs
  ];
  // We rebuild the current compiled view from persisted batch outputs on every
  // resume. This avoids depending on any hidden in-memory state from prior runs.
  let currentArtifacts = buildThoughtCompilationArtifacts(
    source.corpus,
    state,
    completedOutputs,
    documentFrames
  );
  let currentGraph = currentArtifacts.graph;
  let processedBatchCount = 0;
  let pendingError: Error | null = null;

  for (const batch of batches) {
    if (completedBatchIds.has(batch.batchId)) {
      continue;
    }

    if (
      typeof options.maxBatches === "number" &&
      options.maxBatches >= 0 &&
      processedBatchCount >= options.maxBatches
    ) {
      state.status = "paused_manual";
      state.updatedAt = new Date().toISOString();
      break;
    }

    try {
      let validatedOutput: ThoughtBatchOutput;
      if (options.forceSingletonRepairBatchId === batch.batchId) {
        validatedOutput = executeBatchViaSingletonRepair(
          client,
          batch,
          currentGraph,
          runPaths,
          paths,
          options,
          progress
        );
      } else {
        try {
          validatedOutput = executeValidatedBatch(
            client,
            batch,
            currentGraph,
            runPaths,
            paths,
            options,
            progress
          );
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message.includes("failed semantic quality density check") ||
            !isRetriableBatchOutputError(error) ||
            batch.items.length <= 1
          ) {
            throw error;
          }

          progress.phase(
            "compile",
            `falling back to singleton repair for ${batch.batchId} after repeated malformed structured output`
          );

          validatedOutput = executeBatchViaSingletonRepair(
            client,
            batch,
            currentGraph,
            runPaths,
            paths,
            options,
            progress
          );
        }
      }

      writeThoughtBatchOutput(runPaths, validatedOutput);
      upsertSemanticContributionCacheEntries(
        semanticCache,
        validatedOutput,
        batch.items,
        compilerContract
      );
      writeSemanticContributionCache(paths, semanticCache);
      completedOutputs.push(validatedOutput);
      state.completedBatchIds.push(batch.batchId);
      completedBatchIds.add(batch.batchId);
      state.lastSuccessfulBatchId = batch.batchId;
      state.lastSuccessfulInputId = batch.items[batch.items.length - 1]?.inputId ?? null;
      state.failureKind = null;
      state.failureMessage = null;
      state.updatedAt = new Date().toISOString();
      processedBatchCount += 1;

      currentArtifacts = buildThoughtCompilationArtifacts(
        source.corpus,
        state,
        completedOutputs,
        documentFrames
      );
      currentGraph = currentArtifacts.graph;
      // Persist after every successful batch. This is the core contract that
      // makes auth/quota pauses safe to recover from.
      writeThoughtCompilationArtifacts(runPaths, currentArtifacts);
      writeThoughtCompilerRunState(runPaths, state);
      progress.item(
        "compile",
        "semantic-batches",
        state.completedBatchIds.length,
        batches.length,
        batch.batchId
      );
    } catch (error) {
      const now = new Date().toISOString();
      state.updatedAt = now;

      if (error instanceof CodexCliError) {
        state.status = deriveFailureStatus(error.kind);
        state.failureKind = error.kind;
        state.failureMessage = error.message;
      } else if (error instanceof Error) {
        state.status = "failed";
        state.failureKind = "other";
        state.failureMessage = error.message;
      } else {
        state.status = "failed";
        state.failureKind = "other";
        state.failureMessage = "Unknown compiler failure.";
      }

      pendingError = error instanceof Error ? error : new Error(String(error));
      progress.phase(
        "compile",
        `stopped at ${state.completedBatchIds.length}/${batches.length}: ${state.status}`
      );
      break;
    }
  }

  if (state.completedBatchIds.length === batches.length) {
    state.status = "completed";
    state.completedAt = new Date().toISOString();
    state.updatedAt = state.completedAt;
  } else if (state.status === "in_progress") {
    // If the user limited the run with --max-batches we treat it as an expected
    // manual pause, not as an error.
    state.status = "paused_manual";
    state.updatedAt = new Date().toISOString();
  }

  currentArtifacts = buildThoughtCompilationArtifacts(
    source.corpus,
    state,
    completedOutputs,
    documentFrames
  );
  writeThoughtCompilationArtifacts(runPaths, currentArtifacts);
  writeSemanticContributionCache(paths, semanticCache);
  const segmentIndexArtifact = writeSegmentIndexArtifact(
    paths,
    source.corpus,
    source.corpusHash,
    allItems,
    semanticCache,
    compilerContract,
    semanticReusePolicy
  );
  writeThoughtCompilerRunState(runPaths, state);

  progress.phase(
    "compile",
    `${state.status}: ${state.completedBatchIds.length}/${batches.length} batches complete`
  );

  const incremental = buildIncrementalSummary({
    mode: deriveIncrementalMode(options, canResumeExactBatchRun),
    reusePolicy: semanticReusePolicy,
    primarySegmentCount: source.corpus.stats.primarySegmentCount,
    reusedSemanticItemCount,
    reusedCurrentContractCount,
    reusedPriorContractCount,
    pendingSemanticItemCount,
    segmentIndexArtifact
  });
  const compileManifestPath = path.join(paths.manifestsDir, "compile_manifest.json");

  const summary = finalizeSummary(
    runPaths,
    state,
    processedBatchCount,
    reusedSemanticItemCount,
    pendingSemanticItemCount,
    getSemanticContributionCachePath(paths),
    getSegmentIndexPath(paths),
    compileManifestPath,
    incremental
  );
  writeCompileManifest(compileManifestPath, summary);

  if (pendingError) {
    return summary;
  }

  return summary;
}
