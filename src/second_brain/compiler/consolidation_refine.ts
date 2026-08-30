import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import {
  CodexCliClient,
  CodexCliError,
  type CodexFailureKind,
  type CodexReasoningEffort
} from "../codex/client.js";
import type { ProjectPaths } from "../system/paths.js";
import type { SourceKind, UnifiedCorpus, UnifiedSourceRef } from "../types/domain.js";
import { ThrottledProgressReporter, type ProgressWriter } from "../utils/progress.js";
import { slugify } from "../utils/text.js";
import { computeConsolidatedGraphSemanticHash } from "../structure/artifact_identity.js";
import { hashStableSet } from "../utils/stable_hash.js";
import { buildStableConsolidatedFamilyId } from "./consolidation_identity.js";
import {
  ensureThoughtConsolidationRunLayout,
  getThoughtConsolidationRunPaths,
  loadThoughtConsolidationCheckpoint,
  writeThoughtConsolidationRunState
} from "./state.js";
import { loadSegmentIndexArtifact } from "./semantic_cache.js";
import type {
  ConsolidatedThoughtEdge,
  ConsolidatedThoughtGraph,
  ConsolidatedThoughtNode,
  ConsolidationReviewCandidate,
  ConsolidationReviewDecision,
  ConsolidationSynthesisResult,
  ThoughtCompilationArtifacts,
  ThoughtConsolidationAffectedScope,
  ThoughtConsolidationArtifacts,
  ThoughtConsolidationDiagnostics,
  ThoughtConsolidationFailureKind,
  ThoughtConsolidationFamilyIndex,
  ThoughtConsolidationIncrementalSummary,
  ThoughtConsolidationRunState,
  ThoughtNodeFrameMembership,
  ThoughtNodeStatus,
  ThoughtNodeType,
  ThoughtRelationType
} from "./types.js";

const THOUGHT_CONSOLIDATION_DEFAULTS = SECOND_BRAIN_DEFAULTS.thoughtConsolidation;
const CONSOLIDATION_PROMPT_VERSION = 2;
const OUTPUT_LANGUAGE = SECOND_BRAIN_DEFAULTS.language;

type ReviewBatchOutput = {
  batchId: string;
  items: ConsolidationReviewDecision[];
};

type SynthesisBatchOutput = {
  batchId: string;
  items: ConsolidationSynthesisResult[];
};

type ReviewDecisionCacheEntry = {
  caseId: string;
  inputHash: string;
  model: string | null;
  reasoningEffort: string | null;
  decision: ConsolidationReviewDecision;
  updatedAt: string;
};

type SynthesisCacheEntry = {
  clusterId: string;
  inputHash: string;
  model: string | null;
  reasoningEffort: string | null;
  result: ConsolidationSynthesisResult;
  updatedAt: string;
};

type ReviewBatchRunResult = {
  decisions: ConsolidationReviewDecision[];
  reusedDecisionCount: number;
  generatedDecisionCount: number;
};

type SynthesisBatchRunResult = {
  results: ConsolidationSynthesisResult[];
  reusedSynthesisCount: number;
  generatedSynthesisCount: number;
};

type SynthesisPromptItem = {
  clusterId: string;
  nodeType: ThoughtNodeType;
  status: ThoughtNodeStatus;
  sourceDocumentIds: string[];
  memberTitles: string[];
  memberCanonicalKeys: string[];
  aliases: string[];
  claims: Array<{
    claim: string;
    rationale: string;
    excerpt: string;
    source: string;
  }>;
};

type PairSummary = {
  leftNodeId: string;
  rightNodeId: string;
  semanticWeight: number;
  revisionWeight: number;
  blockingWeight: number;
  relationTypes: Set<ThoughtRelationType>;
};

type PositiveNeighborSummary = {
  sharedCount: number;
  jaccard: number;
};

type UnionFindLikeNode = {
  parent: number[];
};

const REVIEW_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    batchId: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          caseId: { type: "string" },
          decision: { type: "string", enum: ["merge_family", "keep_separate"] },
          rationale: { type: "string" }
        },
        required: ["caseId", "decision", "rationale"],
        additionalProperties: false
      }
    }
  },
  required: ["batchId", "items"],
  additionalProperties: false
} as const;

const SYNTHESIS_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    batchId: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          clusterId: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" }
        },
        required: ["clusterId", "title", "summary"],
        additionalProperties: false
      }
    }
  },
  required: ["batchId", "items"],
  additionalProperties: false
} as const;

// This second-stage review still operates on already semantic units, so lexical
// overlap here is only a candidate filter for expensive LLM adjudication.
const STOPWORDS = new Set([
  "a",
  "aby",
  "ale",
  "ani",
  "as",
  "at",
  "bez",
  "by",
  "byt",
  "co",
  "cim",
  "do",
  "i",
  "ja",
  "je",
  "jsme",
  "jsou",
  "k",
  "kdyz",
  "ktery",
  "ma",
  "me",
  "mezi",
  "mi",
  "muze",
  "na",
  "nad",
  "ne",
  "nebo",
  "neni",
  "nez",
  "o",
  "od",
  "po",
  "pod",
  "pro",
  "proto",
  "se",
  "si",
  "tak",
  "take",
  "to",
  "tohle",
  "toto",
  "u",
  "uz",
  "v",
  "ve",
  "vsak",
  "vse",
  "z",
  "za",
  "ze",
  "the",
  "and",
  "for",
  "from",
  "of",
  "that",
  "this",
  "with"
]);

function tokenize(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function jaccard(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 1;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function relationKey(from: string, to: string, type: ThoughtRelationType): string {
  if (
    type === "co_occurs" ||
    type === "semantic_related" ||
    type === "tensions_with" ||
    type === "context_split"
  ) {
    const ordered = [from, to].sort((left, right) => left.localeCompare(right));
    return `${type}:${ordered[0] ?? from}:${ordered[1] ?? to}`;
  }

  return `${type}:${from}:${to}`;
}

function compareTimes(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left.localeCompare(right);
}

function dedupeSourceRefs(sourceRefs: UnifiedSourceRef[]): UnifiedSourceRef[] {
  const seen = new Set<string>();
  return sourceRefs.filter((sourceRef) => {
    const key = JSON.stringify(sourceRef);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function sourceRefKey(sourceRef: UnifiedSourceRef): string {
  return [
    sourceRef.sourceKind,
    sourceRef.documentId,
    sourceRef.sourcePath,
    sourceRef.sourceItemId ?? "",
    sourceRef.locator
  ].join("|");
}

function createSourceKindCounter(): Record<SourceKind, number> {
  return {
    writing: 0,
    conversation: 0,
    chat: 0
  };
}

function writeSchemaFile(targetDir: string, filename: string, payload: unknown): string {
  mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, filename);
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return target;
}

function writeJsonArtifact(target: string, payload: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readJsonArtifact<T>(target: string, fallback: T): T {
  if (!existsSync(target)) {
    return fallback;
  }

  return JSON.parse(readFileSync(target, "utf8")) as T;
}

function getReviewDecisionCachePath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "consolidation_review_cache.json");
}

function getSynthesisCachePath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "consolidation_synthesis_cache.json");
}

function getConsolidationDiagnosticsJsonPath(paths: ProjectPaths): string {
  return path.join(paths.stateAuditsDir, "consolidation_diagnostics.json");
}

function getConsolidationDiagnosticsMarkdownPath(paths: ProjectPaths): string {
  return path.join(paths.stateAuditsDir, "consolidation_diagnostics.md");
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function buildConsolidationDiagnosticsMarkdown(
  diagnostics: ThoughtConsolidationDiagnostics
): string {
  return [
    "# Consolidation Diagnostics",
    "",
    `Generated at: ${diagnostics.generatedAt}`,
    `Mode: ${diagnostics.mode}`,
    `Source run: ${diagnostics.sourceRunId}`,
    "",
    "## Reuse",
    "",
    `- Review decisions: ${diagnostics.reuse.reusedReviewDecisionCount} reused / ${diagnostics.reuse.generatedReviewDecisionCount} generated`,
    `- Synthesis outputs: ${diagnostics.reuse.reusedSynthesisCount} reused / ${diagnostics.reuse.generatedSynthesisCount} generated`,
    `- Synthesis reuse share: ${diagnostics.reuse.synthesisReuseShare.toFixed(3)}`,
    `- Generated synthesis share: ${diagnostics.reuse.generatedSynthesisShare.toFixed(3)}`,
    "",
    "## Semantic Delta",
    "",
    `- Total primary segments: ${diagnostics.semanticInput.totalPrimarySegmentCount}`,
    `- Unchanged primary segments: ${diagnostics.semanticInput.unchangedPrimarySegmentCount}`,
    `- Added primary segments: ${diagnostics.semanticInput.addedPrimarySegmentCount}`,
    `- Changed primary segments: ${diagnostics.semanticInput.changedPrimarySegmentCount}`,
    `- Removed primary segments: ${diagnostics.semanticInput.removedPrimarySegmentCount}`,
    `- New primary segment share: ${diagnostics.semanticInput.newPrimarySegmentShare.toFixed(3)}`,
    "",
    ...(diagnostics.affectedScope
      ? [
          "## Affected Scope",
          "",
          `- Mode: ${diagnostics.affectedScope.mode}`,
          `- Local recompute families: ${diagnostics.affectedScope.localRecomputeFamilyCount}`,
          `- Local recompute share: ${diagnostics.affectedScope.localRecomputeFamilyShare.toFixed(3)}`,
          `- Affected families: ${diagnostics.affectedScope.affectedFamilyCount}`,
          `- Reused families: ${diagnostics.affectedScope.reusedFamilyCount}`,
          `- Affected family share: ${diagnostics.affectedScope.affectedFamilyShare.toFixed(3)}`,
          `- Review scope families: ${diagnostics.affectedScope.reviewScopeFamilyCount}`,
          `- Synthesis scope families: ${diagnostics.affectedScope.synthesisScopeFamilyCount}`,
          `- Dependency-expanded closure families: ${diagnostics.affectedScope.dependencyExpandedClosureFamilyCount}`,
          `- Dependency-expanded closure share: ${diagnostics.affectedScope.dependencyExpandedClosureShare.toFixed(3)}`,
          `- Affected edges: ${diagnostics.affectedScope.affectedEdgeCount}`,
          `- Invalidated review cases: ${diagnostics.affectedScope.invalidatedReviewCaseCount}`,
          `- Invalidated synthesis families: ${diagnostics.affectedScope.invalidatedSynthesisCount}`,
          `- Broader path used: ${diagnostics.affectedScope.broaderPathUsed ? "yes" : "no"}`,
          `- Fallback mode: ${diagnostics.affectedScope.fallbackMode}`,
          ...diagnostics.affectedScope.fallbackReasons.map((reason) => `- ${reason}`),
          ""
        ]
      : []),
    "## Recommendation",
    "",
    `- Broader path used in this run: ${diagnostics.recommendation.broaderPathUsed ? "yes" : "no"}`,
    `- Broader consolidation rerun recommended: ${diagnostics.recommendation.broaderConsolidationRerunRecommended ? "yes" : "no"}`,
    `- Severity: ${diagnostics.recommendation.severity}`,
    ...diagnostics.recommendation.reasons.map((reason) => `- ${reason}`),
    ""
  ].join("\n");
}

function hashStableJson(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function resolveConsolidationContract(options: {
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}): { model: string | null; reasoningEffort: string | null } {
  return {
    model: options.model ?? SECOND_BRAIN_DEFAULTS.codex.defaultModel,
    reasoningEffort:
      options.reasoningEffort ?? SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort
  };
}

function buildReviewCandidateInputHash(candidate: ConsolidationReviewCandidate): string {
  return hashStableJson({
    caseId: candidate.caseId,
    reason: candidate.reason,
    leftNodeId: candidate.leftNodeId,
    rightNodeId: candidate.rightNodeId,
    leftTitle: candidate.leftTitle,
    rightTitle: candidate.rightTitle,
    leftSummary: candidate.leftSummary,
    rightSummary: candidate.rightSummary,
    leftCanonicalKeys: candidate.leftCanonicalKeys,
    rightCanonicalKeys: candidate.rightCanonicalKeys,
    leftNodeType: candidate.leftNodeType,
    rightNodeType: candidate.rightNodeType,
    leftAliases: candidate.leftAliases,
    rightAliases: candidate.rightAliases,
    leftDocumentIds: candidate.leftDocumentIds,
    rightDocumentIds: candidate.rightDocumentIds,
    sharedDocumentIds: candidate.sharedDocumentIds,
    sharedDocumentOverlapRatio: candidate.sharedDocumentOverlapRatio,
    titleScore: candidate.titleScore,
    summaryScore: candidate.summaryScore,
    aliasScore: candidate.aliasScore,
    canonicalScore: candidate.canonicalScore,
    semanticWeight: candidate.semanticWeight,
    revisionWeight: candidate.revisionWeight,
    blockingWeight: candidate.blockingWeight,
    sharedPositiveNeighborCount: candidate.sharedPositiveNeighborCount,
    positiveNeighborJaccard: candidate.positiveNeighborJaccard
  });
}

function buildReviewDecisionCacheKey(options: {
  candidate: ConsolidationReviewCandidate;
  model: string | null;
  reasoningEffort: string | null;
}): string {
  return hashStableJson({
    type: "review",
    promptVersion: CONSOLIDATION_PROMPT_VERSION,
    caseId: options.candidate.caseId,
    inputHash: buildReviewCandidateInputHash(options.candidate),
    model: options.model,
    reasoningEffort: options.reasoningEffort
  });
}

function buildSynthesisItemInputHash(item: SynthesisPromptItem): string {
  return hashStableJson(item);
}

function buildSynthesisCacheKey(options: {
  item: SynthesisPromptItem;
  model: string | null;
  reasoningEffort: string | null;
}): string {
  return hashStableJson({
    type: "synthesis",
    promptVersion: CONSOLIDATION_PROMPT_VERSION,
    clusterId: options.item.clusterId,
    inputHash: buildSynthesisItemInputHash(options.item),
    model: options.model,
    reasoningEffort: options.reasoningEffort
  });
}

function classifyConsolidationFailureKind(error: unknown): ThoughtConsolidationFailureKind {
  if (error instanceof CodexCliError) {
    return error.kind;
  }

  return "other";
}

function deriveFailureStatus(kind: CodexFailureKind): ThoughtConsolidationRunState["status"] {
  if (kind === "auth") {
    return "paused_auth";
  }
  if (kind === "quota") {
    return "paused_quota";
  }
  return "failed";
}

function computeConsolidationGraphHash(
  artifacts: ThoughtCompilationArtifacts,
  consolidated: ThoughtConsolidationArtifacts
): string {
  // Resume must invalidate if either the deterministic graph shape or the
  // source claim layer changes, because both feed later LLM prompts.
  return hashStableSet({
    promptVersion: CONSOLIDATION_PROMPT_VERSION,
    graphSemanticHash: computeConsolidatedGraphSemanticHash(consolidated.graph),
    claims: artifacts.claims.map((claim) => ({
      ...claim,
      // Export paths and bundle filenames are transport metadata. Durable
      // document/turn/item identity still invalidates the prompt as required.
      sourceRef: {
        sourceKind: claim.sourceRef.sourceKind,
        documentId: claim.sourceRef.documentId,
        documentTitle: claim.sourceRef.documentTitle,
        locator: claim.sourceRef.locator,
        sourceItemId: claim.sourceRef.sourceItemId,
        conversationId: claim.sourceRef.conversationId,
        turnId: claim.sourceRef.turnId,
        messageId: claim.sourceRef.messageId
      }
    }))
  });
}

function createInitialConsolidationRunState(options: {
  sourceRunId: string;
  graphHash: string;
  reviewCandidateCount: number;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}): ThoughtConsolidationRunState {
  const now = new Date().toISOString();
  return {
    runId: `thought-consolidation-${now.replace(/[:.]/g, "-")}`,
    sourceRunId: options.sourceRunId,
    graphHash: options.graphHash,
    reviewCandidateCount: options.reviewCandidateCount,
    reviewBatchSize: THOUGHT_CONSOLIDATION_DEFAULTS.reviewBatchSize,
    synthesisBatchSize: THOUGHT_CONSOLIDATION_DEFAULTS.synthesisBatchSize,
    completedReviewBatchIds: [],
    completedSynthesisBatchIds: [],
    status: "in_progress",
    failureKind: null,
    failureMessage: null,
    model: options.model ?? SECOND_BRAIN_DEFAULTS.codex.defaultModel,
    reasoningEffort: options.reasoningEffort ?? SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort,
    startedAt: now,
    updatedAt: now,
    completedAt: null
  };
}

function resumeOrCreateConsolidationRunState(options: {
  paths: ProjectPaths;
  graphHash: string;
  sourceRunId: string;
  reviewCandidateCount: number;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  forceNewRun?: boolean;
}): ThoughtConsolidationRunState {
  const existing = loadThoughtConsolidationCheckpoint(options.paths);
  const resolvedModel = options.model ?? SECOND_BRAIN_DEFAULTS.codex.defaultModel;
  const resolvedReasoningEffort =
    options.reasoningEffort ?? SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort;
  if (
    existing &&
    // Repeating --force-new-run after a quota/auth/timeout stop must resume
    // its persisted batches. A completed force run still starts from scratch.
    (!options.forceNewRun || existing.status !== "completed") &&
    existing.graphHash === options.graphHash &&
    existing.sourceRunId === options.sourceRunId &&
    existing.reviewCandidateCount === options.reviewCandidateCount &&
    existing.reviewBatchSize === THOUGHT_CONSOLIDATION_DEFAULTS.reviewBatchSize &&
    existing.synthesisBatchSize === THOUGHT_CONSOLIDATION_DEFAULTS.synthesisBatchSize &&
    existing.model === resolvedModel &&
    existing.reasoningEffort === resolvedReasoningEffort
  ) {
    // A completed consolidation run is also resumable: the persisted partial
    // review/synthesis files contain the finished work. Reusing them prevents
    // master from paying for LLM review again after a later render/export phase
    // fails, but only when the semantic contract still matches.
    return {
      ...existing,
      status: "in_progress",
      updatedAt: new Date().toISOString()
    };
  }

  return createInitialConsolidationRunState(options);
}

function validateReviewBatchOutput(
  batchId: string,
  expectedCaseIds: string[],
  output: ReviewBatchOutput
): ReviewBatchOutput {
  if (output.batchId !== batchId) {
    throw new Error(
      `Review output batchId mismatch. Expected ${batchId}, received ${output.batchId}.`
    );
  }

  const actualCaseIds = output.items.map((item) => item.caseId);
  if (actualCaseIds.length !== expectedCaseIds.length) {
    throw new Error(
      `Review batch ${batchId} returned ${actualCaseIds.length} items for ${expectedCaseIds.length} inputs.`
    );
  }

  for (let index = 0; index < expectedCaseIds.length; index += 1) {
    if (expectedCaseIds[index] !== actualCaseIds[index]) {
      throw new Error(
        `Review batch ${batchId} returned caseId ${actualCaseIds[index]} at index ${index}, expected ${expectedCaseIds[index]}.`
      );
    }
  }

  return output;
}

function validateSynthesisBatchOutput(
  batchId: string,
  expectedClusterIds: string[],
  output: SynthesisBatchOutput
): SynthesisBatchOutput {
  if (output.batchId !== batchId) {
    throw new Error(
      `Synthesis output batchId mismatch. Expected ${batchId}, received ${output.batchId}.`
    );
  }

  const actualClusterIds = output.items.map((item) => item.clusterId);
  if (actualClusterIds.length !== expectedClusterIds.length) {
    throw new Error(
      `Synthesis batch ${batchId} returned ${actualClusterIds.length} items for ${expectedClusterIds.length} inputs.`
    );
  }

  for (let index = 0; index < expectedClusterIds.length; index += 1) {
    const expectedClusterId = expectedClusterIds[index] ?? "";
    const actualClusterId = actualClusterIds[index] ?? "";
    const expectedStablePrefix = expectedClusterId.match(/^(consolidated:[a-f0-9]+):/)?.[1];
    const actualStablePrefix = actualClusterId.match(/^(consolidated:[a-f0-9]+):/)?.[1];
    const sameStableFamily =
      Boolean(expectedStablePrefix) && expectedStablePrefix === actualStablePrefix;
    if (!sameStableFamily && slugify(expectedClusterId) !== slugify(actualClusterId)) {
      throw new Error(
        `Synthesis batch ${batchId} returned clusterId ${actualClusterId} at index ${index}, expected ${expectedClusterId}.`
      );
    }
  }

  // Synthesis only improves final phrasing. Preserve the deterministic cluster
  // IDs on disk even when the model echoes them back with diacritics, casing
  // drift, or rewrites the readable suffix after the stable family hash.
  return {
    batchId: output.batchId,
    items: output.items.map((item, index) => ({
      ...item,
      clusterId: expectedClusterIds[index] ?? item.clusterId
    }))
  };
}

function createUnionFind(size: number): UnionFindLikeNode {
  return { parent: Array.from({ length: size }, (_, index) => index) };
}

function findRoot(unionFind: UnionFindLikeNode, index: number): number {
  if (unionFind.parent[index] === index) {
    return index;
  }

  const next = findRoot(unionFind, unionFind.parent[index] ?? index);
  unionFind.parent[index] = next;
  return next;
}

function union(unionFind: UnionFindLikeNode, left: number, right: number): void {
  const leftRoot = findRoot(unionFind, left);
  const rightRoot = findRoot(unionFind, right);
  if (leftRoot !== rightRoot) {
    unionFind.parent[rightRoot] = leftRoot;
  }
}

function buildPairSummaries(edges: ConsolidatedThoughtEdge[]): Map<string, PairSummary> {
  const summaries = new Map<string, PairSummary>();

  for (const edge of edges) {
    const ordered = [edge.from, edge.to].sort((left, right) => left.localeCompare(right));
    const key = `${ordered[0] ?? edge.from}:${ordered[1] ?? edge.to}`;
    const summary =
      summaries.get(key) ??
      {
        leftNodeId: ordered[0] ?? edge.from,
        rightNodeId: ordered[1] ?? edge.to,
        semanticWeight: 0,
        revisionWeight: 0,
        blockingWeight: 0,
        relationTypes: new Set<ThoughtRelationType>()
      };

    if (edge.type === "semantic_related" || edge.type === "supports") {
      summary.semanticWeight += edge.weight;
    }
    if (edge.type === "revises" || edge.type === "supersedes") {
      summary.revisionWeight += edge.weight;
    }
    if (edge.type === "tensions_with" || edge.type === "context_split") {
      summary.blockingWeight += edge.weight;
    }

    summary.relationTypes.add(edge.type);
    summaries.set(key, summary);
  }

  return summaries;
}

function buildPositiveNeighborLookup(edges: ConsolidatedThoughtEdge[]): Map<string, Set<string>> {
  const lookup = new Map<string, Set<string>>();

  for (const edge of edges) {
    if (
      edge.type !== "semantic_related" &&
      edge.type !== "supports" &&
      edge.type !== "revises" &&
      edge.type !== "supersedes"
    ) {
      continue;
    }

    const fromSet = lookup.get(edge.from) ?? new Set<string>();
    fromSet.add(edge.to);
    lookup.set(edge.from, fromSet);

    const toSet = lookup.get(edge.to) ?? new Set<string>();
    toSet.add(edge.from);
    lookup.set(edge.to, toSet);
  }

  return lookup;
}

function summarizePositiveNeighborhood(
  lookup: Map<string, Set<string>>,
  leftNodeId: string,
  rightNodeId: string
): PositiveNeighborSummary {
  const left = new Set(lookup.get(leftNodeId) ?? []);
  const right = new Set(lookup.get(rightNodeId) ?? []);
  left.delete(rightNodeId);
  right.delete(leftNodeId);

  let sharedCount = 0;
  for (const value of left) {
    if (right.has(value)) {
      sharedCount += 1;
    }
  }

  const unionSize = new Set([...left, ...right]).size;
  return {
    sharedCount,
    jaccard: unionSize === 0 ? 0 : sharedCount / unionSize
  };
}

function buildClusterTokenBundle(node: ConsolidatedThoughtNode): {
  titleTokens: string[];
  displayTitleTokens: string[];
  summaryTokens: string[];
  aliasTokens: string[];
  canonicalTokens: string[];
  documentIds: string[];
} {
  return {
    titleTokens: tokenize(`${node.title} ${node.summary}`),
    displayTitleTokens: tokenize(node.title),
    summaryTokens: tokenize(node.summary),
    aliasTokens: tokenize(node.aliases.join(" ")),
    canonicalTokens: tokenize(node.memberCanonicalKeys.join(" ")),
    documentIds: Array.from(
      new Set(node.sourceRefs.map((sourceRef) => sourceRef.documentId).filter(Boolean))
    ).sort((left, right) => left.localeCompare(right))
  };
}

function computeDocumentOverlapRatio(
  leftDocumentIds: string[],
  rightDocumentIds: string[],
  sharedDocumentIds: string[]
): number {
  const denominator = Math.min(leftDocumentIds.length, rightDocumentIds.length);
  return denominator === 0 ? 0 : sharedDocumentIds.length / denominator;
}

function hasUserFacingLexicalAnchor(titleScore: number, aliasScore: number): boolean {
  return (
    titleScore >= THOUGHT_CONSOLIDATION_DEFAULTS.reviewCandidateTitleAnchorThreshold ||
    aliasScore >= THOUGHT_CONSOLIDATION_DEFAULTS.reviewCandidateLexicalAnchorThreshold
  );
}

function shouldReviewSameSourceFamily(options: {
  summary: PairSummary;
  leftNode: ConsolidatedThoughtNode;
  rightNode: ConsolidatedThoughtNode;
  sharedDocumentIds: string[];
  sharedDocumentOverlapRatio: number;
  titleScore: number;
  aliasScore: number;
}): boolean {
  return (
    options.summary.blockingWeight === 0 &&
    options.sharedDocumentIds.length > 0 &&
    options.sharedDocumentOverlapRatio >=
      THOUGHT_CONSOLIDATION_DEFAULTS.sameSourceReviewDocumentOverlapThreshold &&
    options.summary.semanticWeight > 0 &&
    options.leftNode.nodeType === options.rightNode.nodeType &&
    (options.titleScore >= THOUGHT_CONSOLIDATION_DEFAULTS.sameSourceReviewTitleThreshold ||
      options.aliasScore >= THOUGHT_CONSOLIDATION_DEFAULTS.sameSourceReviewLexicalThreshold)
  );
}

function shouldReviewGraphNeighborhood(options: {
  summary: PairSummary;
  neighborSummary: PositiveNeighborSummary;
  titleScore: number;
  aliasScore: number;
  sharedDocumentOverlapRatio: number;
}): boolean {
  if (options.summary.blockingWeight > 0 || options.summary.semanticWeight <= 0) {
    return false;
  }

  if (
    options.neighborSummary.sharedCount <
      THOUGHT_CONSOLIDATION_DEFAULTS.graphNeighborhoodReviewSharedNeighborThreshold ||
    options.neighborSummary.jaccard <
      THOUGHT_CONSOLIDATION_DEFAULTS.graphNeighborhoodReviewSharedNeighborJaccardThreshold
  ) {
    return false;
  }

  if (
    options.summary.revisionWeight > 0 &&
    (options.sharedDocumentOverlapRatio >=
      THOUGHT_CONSOLIDATION_DEFAULTS.graphNeighborhoodReviewDocumentOverlapThreshold ||
      options.titleScore >= THOUGHT_CONSOLIDATION_DEFAULTS.graphNeighborhoodReviewTitleThreshold ||
      options.aliasScore >= THOUGHT_CONSOLIDATION_DEFAULTS.graphNeighborhoodReviewLexicalThreshold)
  ) {
    return true;
  }

  return (
    options.sharedDocumentOverlapRatio >=
      THOUGHT_CONSOLIDATION_DEFAULTS.graphNeighborhoodReviewDocumentOverlapThreshold &&
    hasUserFacingLexicalAnchor(options.titleScore, options.aliasScore)
  );
}

/**
 * Build the narrow ambiguity set that deserves LLM review.
 *
 * This follows the donor pattern from LLMCER: deterministic blocking first,
 * then only escalate borderline families instead of sending the whole graph
 * back through the model.
 */
export function buildConsolidationReviewCandidates(
  graph: ConsolidatedThoughtGraph
): ConsolidationReviewCandidate[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  // The summary-only surface below compares many pairs on a full graph. Build
  // each lexical bundle once so a recovery pass does not repeatedly tokenize
  // the same node tens of millions of times before it can reach its checkpoint.
  const bundleByNodeId = new Map(
    graph.nodes.map((node) => [node.id, buildClusterTokenBundle(node)] as const)
  );
  const pairSummaries = buildPairSummaries(graph.edges);
  const positiveNeighborLookup = buildPositiveNeighborLookup(graph.edges);
  const candidates: ConsolidationReviewCandidate[] = [];

  for (const summary of pairSummaries.values()) {
    const leftNode = nodeById.get(summary.leftNodeId);
    const rightNode = nodeById.get(summary.rightNodeId);
    if (!leftNode || !rightNode) {
      continue;
    }

    const leftBundle = bundleByNodeId.get(leftNode.id)!;
    const rightBundle = bundleByNodeId.get(rightNode.id)!;
    const titleScore = jaccard(leftBundle.titleTokens, rightBundle.titleTokens);
    const summaryScore = jaccard(leftBundle.summaryTokens, rightBundle.summaryTokens);
    const aliasScore = jaccard(leftBundle.aliasTokens, rightBundle.aliasTokens);
    const canonicalScore = jaccard(leftBundle.canonicalTokens, rightBundle.canonicalTokens);
    const sharedDocumentIds = leftBundle.documentIds.filter((documentId) =>
      rightBundle.documentIds.includes(documentId)
    );
    const sharedDocumentOverlapRatio = computeDocumentOverlapRatio(
      leftBundle.documentIds,
      rightBundle.documentIds,
      sharedDocumentIds
    );
    const neighborSummary = summarizePositiveNeighborhood(
      positiveNeighborLookup,
      leftNode.id,
      rightNode.id
    );
    const hasLexicalAffinity =
      titleScore >= THOUGHT_CONSOLIDATION_DEFAULTS.ambiguityLexicalThreshold ||
      aliasScore >= THOUGHT_CONSOLIDATION_DEFAULTS.ambiguityLexicalThreshold ||
      canonicalScore >= THOUGHT_CONSOLIDATION_DEFAULTS.ambiguityLexicalThreshold;

    let reason: string | null = null;
    if (summary.revisionWeight > 0 && summary.blockingWeight > 0) {
      reason = "revision_and_blocking_overlap";
    } else if (
      summary.revisionWeight > 0 &&
      hasLexicalAffinity
    ) {
      reason = "revision_family_review";
    } else if (
      summary.blockingWeight === 0 &&
      summary.semanticWeight >= THOUGHT_CONSOLIDATION_DEFAULTS.ambiguitySemanticWeightThreshold &&
      // Strong relation weight alone is not enough when both nodes just come
      // from one essay or one thread; prefer visible wording overlap over
      // compiler-authored canonical labels so review does not fill up with
      // broad topical siblings.
      (aliasScore >= THOUGHT_CONSOLIDATION_DEFAULTS.reviewCandidateLexicalAnchorThreshold ||
        (summary.revisionWeight > 0 && hasLexicalAffinity) ||
        sharedDocumentOverlapRatio >=
          THOUGHT_CONSOLIDATION_DEFAULTS.graphNeighborhoodReviewDocumentOverlapThreshold &&
          titleScore >= THOUGHT_CONSOLIDATION_DEFAULTS.reviewCandidateTitleAnchorThreshold)
    ) {
      reason = "strong_related_family_review";
    } else if (
      shouldReviewSameSourceFamily({
        summary,
        leftNode,
        rightNode,
        sharedDocumentIds,
        sharedDocumentOverlapRatio,
        titleScore,
        aliasScore
      })
    ) {
      reason = "same_source_family_review";
    } else if (
      shouldReviewGraphNeighborhood({
        summary,
        neighborSummary,
        titleScore,
        aliasScore,
        sharedDocumentOverlapRatio
      })
    ) {
      reason = "graph_neighborhood_family_review";
    }

    if (!reason) {
      continue;
    }

    candidates.push({
      caseId: `review|${leftNode.id}|${rightNode.id}`,
      leftNodeId: leftNode.id,
      rightNodeId: rightNode.id,
      leftTitle: leftNode.title,
      rightTitle: rightNode.title,
      leftSummary: leftNode.summary,
      rightSummary: rightNode.summary,
      leftCanonicalKeys: leftNode.memberCanonicalKeys,
      rightCanonicalKeys: rightNode.memberCanonicalKeys,
      leftNodeType: leftNode.nodeType,
      rightNodeType: rightNode.nodeType,
      leftAliases: leftNode.aliases.slice(0, 12),
      rightAliases: rightNode.aliases.slice(0, 12),
      leftDocumentIds: leftBundle.documentIds,
      rightDocumentIds: rightBundle.documentIds,
      sharedDocumentIds,
      sharedDocumentOverlapRatio,
      titleScore,
      summaryScore,
      aliasScore,
      canonicalScore,
      semanticWeight: summary.semanticWeight,
      revisionWeight: summary.revisionWeight,
      blockingWeight: summary.blockingWeight,
      sharedPositiveNeighborCount: neighborSummary.sharedCount,
      positiveNeighborJaccard: neighborSummary.jaccard,
      reason
    });
  }

  // Synthesized display titles can reveal an obvious family collision even
  // when the granular compiler never proposed a direct edge between the two
  // nodes. Restrict this extra surface to shared documents so generic titles
  // from unrelated areas do not turn into a global all-pairs review problem.
  const candidateCaseIds = new Set(candidates.map((candidate) => candidate.caseId));
  const lexicalPairKeys = new Set<string>();
  const nodesByDocumentId = new Map<string, ConsolidatedThoughtNode[]>();
  for (const node of graph.nodes) {
    const documentIds = new Set(node.sourceRefs.map((sourceRef) => sourceRef.documentId));
    for (const documentId of documentIds) {
      const bucket = nodesByDocumentId.get(documentId) ?? [];
      bucket.push(node);
      nodesByDocumentId.set(documentId, bucket);
    }
  }

  for (const documentNodes of nodesByDocumentId.values()) {
    const orderedNodes = documentNodes
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id));
    for (let leftIndex = 0; leftIndex < orderedNodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < orderedNodes.length; rightIndex += 1) {
        const leftNode = orderedNodes[leftIndex]!;
        const rightNode = orderedNodes[rightIndex]!;
        const pairKey = `${leftNode.id}|${rightNode.id}`;
        if (lexicalPairKeys.has(pairKey)) continue;
        lexicalPairKeys.add(pairKey);

        const caseId = `review|${leftNode.id}|${rightNode.id}`;
        if (candidateCaseIds.has(caseId)) continue;

        const leftBundle = bundleByNodeId.get(leftNode.id)!;
        const rightBundle = bundleByNodeId.get(rightNode.id)!;
        const displayTitleScore = jaccard(
          leftBundle.displayTitleTokens,
          rightBundle.displayTitleTokens
        );
        const hasEnoughTitleTokens =
          Math.min(
            leftBundle.displayTitleTokens.length,
            rightBundle.displayTitleTokens.length
          ) >= THOUGHT_CONSOLIDATION_DEFAULTS.sameSourceTitleOnlyMinimumTokens;
        if (!hasEnoughTitleTokens) continue;

        const exactDisplayTitle = slugify(leftNode.title) === slugify(rightNode.title);
        const leftNumericTokens = leftNode.title.match(/\d+/g) ?? [];
        const rightNumericTokens = rightNode.title.match(/\d+/g) ?? [];
        const numericVariantDiscriminator =
          !exactDisplayTitle &&
          leftNumericTokens.length > 0 &&
          rightNumericTokens.length > 0 &&
          leftNumericTokens.join("|") !== rightNumericTokens.join("|");
        const nearSameTypeTitle =
          !numericVariantDiscriminator &&
          leftNode.nodeType === rightNode.nodeType &&
          displayTitleScore >=
            THOUGHT_CONSOLIDATION_DEFAULTS.sameSourceTitleOnlyReviewThreshold;
        if (!exactDisplayTitle && !nearSameTypeTitle) continue;

        const summary = pairSummaries.get(`${leftNode.id}:${rightNode.id}`) ?? {
          leftNodeId: leftNode.id,
          rightNodeId: rightNode.id,
          semanticWeight: 0,
          revisionWeight: 0,
          blockingWeight: 0,
          relationTypes: new Set<ThoughtRelationType>()
        };
        if (summary.blockingWeight > 0) continue;

        const sharedDocumentIds = leftBundle.documentIds.filter((documentId) =>
          rightBundle.documentIds.includes(documentId)
        );
        const sharedDocumentOverlapRatio = computeDocumentOverlapRatio(
          leftBundle.documentIds,
          rightBundle.documentIds,
          sharedDocumentIds
        );
        const neighborSummary = summarizePositiveNeighborhood(
          positiveNeighborLookup,
          leftNode.id,
          rightNode.id
        );

        candidates.push({
          caseId,
          leftNodeId: leftNode.id,
          rightNodeId: rightNode.id,
          leftTitle: leftNode.title,
          rightTitle: rightNode.title,
          leftSummary: leftNode.summary,
          rightSummary: rightNode.summary,
          leftCanonicalKeys: leftNode.memberCanonicalKeys,
          rightCanonicalKeys: rightNode.memberCanonicalKeys,
          leftNodeType: leftNode.nodeType,
          rightNodeType: rightNode.nodeType,
          leftAliases: leftNode.aliases.slice(0, 12),
          rightAliases: rightNode.aliases.slice(0, 12),
          leftDocumentIds: leftBundle.documentIds,
          rightDocumentIds: rightBundle.documentIds,
          sharedDocumentIds,
          sharedDocumentOverlapRatio,
          titleScore: displayTitleScore,
          summaryScore: jaccard(leftBundle.summaryTokens, rightBundle.summaryTokens),
          aliasScore: jaccard(leftBundle.aliasTokens, rightBundle.aliasTokens),
          canonicalScore: jaccard(leftBundle.canonicalTokens, rightBundle.canonicalTokens),
          semanticWeight: summary.semanticWeight,
          revisionWeight: summary.revisionWeight,
          blockingWeight: summary.blockingWeight,
          sharedPositiveNeighborCount: neighborSummary.sharedCount,
          positiveNeighborJaccard: neighborSummary.jaccard,
          reason: exactDisplayTitle
            ? "duplicate_title_review"
            : "same_source_title_review"
        });
        candidateCaseIds.add(caseId);
      }
    }
  }

  // Granular titles may diverge even when two nodes preserve effectively the
  // same claim. Surface only high-summary-overlap, same-type pairs here; LLM
  // review plus the acceptance guard still decide whether identity is shared.
  const orderedNodes = graph.nodes.slice().sort((left, right) => left.id.localeCompare(right.id));
  for (let leftIndex = 0; leftIndex < orderedNodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < orderedNodes.length; rightIndex += 1) {
      const leftNode = orderedNodes[leftIndex]!;
      const rightNode = orderedNodes[rightIndex]!;
      const caseId = `review|${leftNode.id}|${rightNode.id}`;
      if (candidateCaseIds.has(caseId) || leftNode.nodeType !== rightNode.nodeType) {
        continue;
      }

      const leftBundle = bundleByNodeId.get(leftNode.id)!;
      const rightBundle = bundleByNodeId.get(rightNode.id)!;
      if (
        Math.min(leftBundle.summaryTokens.length, rightBundle.summaryTokens.length) <
        THOUGHT_CONSOLIDATION_DEFAULTS.summaryOnlyMinimumTokens
      ) {
        continue;
      }
      const summaryScore = jaccard(leftBundle.summaryTokens, rightBundle.summaryTokens);
      if (summaryScore < THOUGHT_CONSOLIDATION_DEFAULTS.summaryOnlyReviewThreshold) {
        continue;
      }

      const summary = pairSummaries.get(`${leftNode.id}:${rightNode.id}`) ?? {
        leftNodeId: leftNode.id,
        rightNodeId: rightNode.id,
        semanticWeight: 0,
        revisionWeight: 0,
        blockingWeight: 0,
        relationTypes: new Set<ThoughtRelationType>()
      };
      if (summary.blockingWeight > 0) {
        continue;
      }
      const sharedDocumentIds = leftBundle.documentIds.filter((documentId) =>
        rightBundle.documentIds.includes(documentId)
      );
      const neighborSummary = summarizePositiveNeighborhood(
        positiveNeighborLookup,
        leftNode.id,
        rightNode.id
      );
      candidates.push({
        caseId,
        leftNodeId: leftNode.id,
        rightNodeId: rightNode.id,
        leftTitle: leftNode.title,
        rightTitle: rightNode.title,
        leftSummary: leftNode.summary,
        rightSummary: rightNode.summary,
        leftCanonicalKeys: leftNode.memberCanonicalKeys,
        rightCanonicalKeys: rightNode.memberCanonicalKeys,
        leftNodeType: leftNode.nodeType,
        rightNodeType: rightNode.nodeType,
        leftAliases: leftNode.aliases.slice(0, 12),
        rightAliases: rightNode.aliases.slice(0, 12),
        leftDocumentIds: leftBundle.documentIds,
        rightDocumentIds: rightBundle.documentIds,
        sharedDocumentIds,
        sharedDocumentOverlapRatio: computeDocumentOverlapRatio(
          leftBundle.documentIds,
          rightBundle.documentIds,
          sharedDocumentIds
        ),
        titleScore: jaccard(leftBundle.displayTitleTokens, rightBundle.displayTitleTokens),
        summaryScore,
        aliasScore: jaccard(leftBundle.aliasTokens, rightBundle.aliasTokens),
        canonicalScore: jaccard(leftBundle.canonicalTokens, rightBundle.canonicalTokens),
        semanticWeight: summary.semanticWeight,
        revisionWeight: summary.revisionWeight,
        blockingWeight: summary.blockingWeight,
        sharedPositiveNeighborCount: neighborSummary.sharedCount,
        positiveNeighborJaccard: neighborSummary.jaccard,
        reason: "duplicate_summary_review"
      });
      candidateCaseIds.add(caseId);
    }
  }

  return candidates.sort((left, right) => {
    const reasonPriority = (candidate: ConsolidationReviewCandidate): number =>
      candidate.reason === "duplicate_title_review"
        ? 2
        : candidate.reason === "duplicate_summary_review"
          ? 2
        : candidate.reason === "same_source_title_review"
          ? 1
          : 0;
    const leftScore =
      reasonPriority(left) * 100 +
      left.revisionWeight * 4 +
      left.blockingWeight * 3 +
      left.semanticWeight * 2 +
      left.aliasScore +
      left.canonicalScore;
    const rightScore =
      reasonPriority(right) * 100 +
      right.revisionWeight * 4 +
      right.blockingWeight * 3 +
      right.semanticWeight * 2 +
      right.aliasScore +
      right.canonicalScore;
    return rightScore - leftScore;
  });
}

function buildReviewPrompt(batchId: string, items: ConsolidationReviewCandidate[]): string {
  const payload = {
    batchId,
    items: items.map((item) => ({
      caseId: item.caseId,
      reason: item.reason,
      left: {
        title: item.leftTitle,
        summary: item.leftSummary,
        nodeType: item.leftNodeType,
        canonicalKeys: item.leftCanonicalKeys,
        aliases: item.leftAliases,
        documentIds: item.leftDocumentIds
      },
      right: {
        title: item.rightTitle,
        summary: item.rightSummary,
        nodeType: item.rightNodeType,
        canonicalKeys: item.rightCanonicalKeys,
        aliases: item.rightAliases,
        documentIds: item.rightDocumentIds
      },
      relationSignals: {
        semanticWeight: item.semanticWeight,
        revisionWeight: item.revisionWeight,
        blockingWeight: item.blockingWeight,
        sharedPositiveNeighborCount: item.sharedPositiveNeighborCount,
        positiveNeighborJaccard: item.positiveNeighborJaccard
      },
      lexicalSignals: {
        titleScore: item.titleScore,
        summaryScore: item.summaryScore,
        aliasScore: item.aliasScore,
        canonicalScore: item.canonicalScore
      },
      sharedDocumentIds: item.sharedDocumentIds,
      sharedDocumentOverlapRatio: item.sharedDocumentOverlapRatio
    }))
  };

  return [
    "Rozhoduješ sporné případy konsolidace thought graphu.",
    "Každá položka popisuje dvě už konsolidované rodiny nodů.",
    "Tvoje práce je rozhodnout, zda mají tvořit jeden větší browseable thought unit, nebo mají zůstat oddělené.",
    "merge_family použij jen tehdy, když obě strany představují jednu hlubší myšlenkovou rodinu: parafrázi, zpřesnění, revizi nebo podmíněnou variantu téhož recurring thought.",
    "Sdílené dokumenty nebo obecná tematická blízkost samy o sobě nestačí.",
    "Problem node a navrhované řešení obvykle nejsou jedna rodina, ale dva browseable uzly se vztahem.",
    "Různé návrhy řešení drž odděleně, pokud nejde téměř o přejmenovanou parafrázi téhož návrhu.",
    "Pokud mají dvě strany přes odlišné názvy prakticky totožná shrnutí a stejný typ, ber to jako silný důkaz jedné browseable rodiny.",
    "keep_separate použij tehdy, když jde o různá podtémata, různé návrhy řešení, nebo skutečné napětí, které má zůstat browseable odděleně.",
    "Když si nejsi jistý, preferuj keep_separate.",
    `Všechny přirozenojazyčné výstupy piš v jazyce ${OUTPUT_LANGUAGE.outputLabel} (${OUTPUT_LANGUAGE.output}).`,
    "Vrať přesně jednu položku pro každý caseId. Vrať pouze JSON.",
    "",
    "Batch payload:",
    JSON.stringify(payload, null, 2)
  ].join("\n");
}

function shouldAcceptMergeDecision(candidate: ConsolidationReviewCandidate | undefined): boolean {
  if (!candidate) {
    return true;
  }

  // Hybrid rule: Codex can suggest merges for ambiguous families, but the final
  // union step still requires some structural evidence beyond generic proximity.
  if (candidate.blockingWeight > 0 && candidate.revisionWeight === 0) {
    return false;
  }

  if (candidate.revisionWeight > 0) {
    return (
      candidate.titleScore >= THOUGHT_CONSOLIDATION_DEFAULTS.revisionLexicalThreshold ||
      candidate.canonicalScore >= THOUGHT_CONSOLIDATION_DEFAULTS.revisionLexicalThreshold ||
      candidate.sharedPositiveNeighborCount >=
        THOUGHT_CONSOLIDATION_DEFAULTS.revisionSharedNeighborThreshold &&
        candidate.positiveNeighborJaccard >=
          THOUGHT_CONSOLIDATION_DEFAULTS.revisionSharedNeighborJaccardThreshold
    );
  }

  // Canonical keys are compiler-authored labels, so final non-revision merges
  // still need overlap in user-facing phrasing or stronger provenance anchors.
  const hasLexicalAnchor =
    candidate.titleScore >= THOUGHT_CONSOLIDATION_DEFAULTS.reviewAcceptLexicalThreshold ||
    candidate.aliasScore >= THOUGHT_CONSOLIDATION_DEFAULTS.reviewAcceptLexicalThreshold;
  const hasStrongSummaryAnchor =
    (candidate.summaryScore ?? 0) >=
    THOUGHT_CONSOLIDATION_DEFAULTS.reviewAcceptSummaryThreshold;

  return (
    hasStrongSummaryAnchor ||
    hasLexicalAnchor &&
    (candidate.sharedDocumentOverlapRatio >=
      THOUGHT_CONSOLIDATION_DEFAULTS.sameSourceDocumentOverlapThreshold ||
      (candidate.sharedPositiveNeighborCount >=
        THOUGHT_CONSOLIDATION_DEFAULTS.reviewAcceptSharedNeighborThreshold &&
        candidate.positiveNeighborJaccard >=
          THOUGHT_CONSOLIDATION_DEFAULTS.reviewAcceptSharedNeighborJaccardThreshold))
  );
}

export function runReviewBatches(options: {
  reviewCandidates: ConsolidationReviewCandidate[];
  client: CodexCliClient;
  paths: ProjectPaths;
  runState: ThoughtConsolidationRunState;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  forceNewRun?: boolean;
  batchIdPrefix?: string;
  reusePersistedResults?: boolean;
  progress?: ProgressWriter;
}): ReviewBatchRunResult {
  if (options.reviewCandidates.length === 0) {
    return {
      decisions: [],
      reusedDecisionCount: 0,
      generatedDecisionCount: 0
    };
  }

  const progress = new ThrottledProgressReporter(options.progress);
  const runPaths = getThoughtConsolidationRunPaths(options.paths, options.runState.runId);
  const contract = resolveConsolidationContract(options);

  const schemaPath = writeSchemaFile(
    runPaths.stateDir,
    "consolidation-review.schema.json",
    REVIEW_OUTPUT_SCHEMA
  );
  const totalBatches = Math.ceil(
    options.reviewCandidates.length / THOUGHT_CONSOLIDATION_DEFAULTS.reviewBatchSize
  );
  const completedBatchIds = new Set(options.runState.completedReviewBatchIds);
  const persistedResults = readJsonArtifact<ConsolidationReviewDecision[]>(
    runPaths.reviewDecisionsPath,
    []
  );
  const persistedByCaseId = new Map(persistedResults.map((item) => [item.caseId, item]));
  const resultByCaseId = options.reusePersistedResults === false
    ? new Map<string, ConsolidationReviewDecision>()
    : new Map(persistedByCaseId);
  const reviewCachePath = getReviewDecisionCachePath(options.paths);
  const reviewCache = readJsonArtifact<Record<string, ReviewDecisionCacheEntry>>(reviewCachePath, {});
  let reusedDecisionCount = options.reviewCandidates.filter((candidate) =>
    resultByCaseId.has(candidate.caseId)
  ).length;
  let generatedDecisionCount = 0;
  const batchIdPrefix = options.batchIdPrefix ?? "review";
  const persistDecisions = (): void => {
    writeJsonArtifact(
      runPaths.reviewDecisionsPath,
      Array.from(new Map([...persistedByCaseId, ...resultByCaseId]).values()).sort((left, right) =>
        left.caseId.localeCompare(right.caseId)
      )
    );
  };

  if (persistedResults.length > 0) {
    progress.phase(
      "consolidate:review",
      `resuming review from ${completedBatchIds.size}/${totalBatches} completed batches`
    );
  }
  progress.phase(
    "consolidate:review",
    `${options.reviewCandidates.length} ambiguity cases across ${totalBatches} review batches`
  );
  for (let index = 0; index < options.reviewCandidates.length; index += THOUGHT_CONSOLIDATION_DEFAULTS.reviewBatchSize) {
    const slice = options.reviewCandidates.slice(
      index,
      index + THOUGHT_CONSOLIDATION_DEFAULTS.reviewBatchSize
    );
    const batchNumber = index / THOUGHT_CONSOLIDATION_DEFAULTS.reviewBatchSize + 1;
    const batchId = `${batchIdPrefix}-batch-${String(batchNumber).padStart(4, "0")}`;
    if (completedBatchIds.has(batchId)) {
      continue;
    }

    const unresolvedSlice = slice.filter((candidate) => {
      if (resultByCaseId.has(candidate.caseId)) {
        return false;
      }
      if (options.forceNewRun) {
        return true;
      }

      const cacheKey = buildReviewDecisionCacheKey({
        candidate,
        model: contract.model,
        reasoningEffort: contract.reasoningEffort
      });
      const cached = reviewCache[cacheKey];
      if (!cached) {
        return true;
      }

      resultByCaseId.set(candidate.caseId, cached.decision);
      reusedDecisionCount += 1;
      return false;
    });

    if (unresolvedSlice.length === 0) {
      options.runState.completedReviewBatchIds.push(batchId);
      completedBatchIds.add(batchId);
      options.runState.updatedAt = new Date().toISOString();
      persistDecisions();
      writeThoughtConsolidationRunState(runPaths, options.runState);
      progress.item("consolidate:review", "review-batches", batchNumber, totalBatches, batchId);
      continue;
    }

    const prompt = buildReviewPrompt(batchId, unresolvedSlice);
    try {
      const response = options.client.execSemanticBatch<ReviewBatchOutput>({
        prompt,
        outputSchemaPath: schemaPath,
        workingDir: options.paths.root,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        extraWritableDirs: [options.paths.outputDir]
      });
      const validated = validateReviewBatchOutput(
        batchId,
        unresolvedSlice.map((candidate) => candidate.caseId),
        response.parsed
      );
      generatedDecisionCount += validated.items.length;
      for (const item of validated.items) {
        resultByCaseId.set(item.caseId, item);
      }
      const now = new Date().toISOString();
      for (const candidate of unresolvedSlice) {
        const decision = resultByCaseId.get(candidate.caseId);
        if (!decision) {
          continue;
        }
        const cacheKey = buildReviewDecisionCacheKey({
          candidate,
          model: contract.model,
          reasoningEffort: contract.reasoningEffort
        });
        reviewCache[cacheKey] = {
          caseId: candidate.caseId,
          inputHash: buildReviewCandidateInputHash(candidate),
          model: contract.model,
          reasoningEffort: contract.reasoningEffort,
          decision,
          updatedAt: now
        };
      }
      options.runState.completedReviewBatchIds.push(batchId);
      completedBatchIds.add(batchId);
      options.runState.failureKind = null;
      options.runState.failureMessage = null;
      options.runState.updatedAt = now;
      persistDecisions();
      writeJsonArtifact(reviewCachePath, reviewCache);
      writeThoughtConsolidationRunState(runPaths, options.runState);
      progress.item("consolidate:review", "review-batches", batchNumber, totalBatches, batchId);
    } catch (error) {
      const failureKind = classifyConsolidationFailureKind(error);
      options.runState.status = deriveFailureStatus(failureKind ?? "other");
      options.runState.failureKind = failureKind;
      options.runState.failureMessage = error instanceof Error ? error.message : String(error);
      options.runState.updatedAt = new Date().toISOString();
      persistDecisions();
      writeThoughtConsolidationRunState(runPaths, options.runState);
      throw error;
    }
  }

  return {
    decisions: options.reviewCandidates
      .map((candidate) => resultByCaseId.get(candidate.caseId))
      .filter((item): item is ConsolidationReviewDecision => Boolean(item)),
    reusedDecisionCount,
    generatedDecisionCount
  };
}

function filterReviewCandidatesForAffectedScope(options: {
  reviewCandidates: ConsolidationReviewCandidate[];
  affectedScope?: ThoughtConsolidationAffectedScope;
  forceNewRun?: boolean;
}): ConsolidationReviewCandidate[] {
  if (
    options.forceNewRun ||
    options.affectedScope?.mode !== "incremental" ||
    options.affectedScope.fallbackMode !== "none"
  ) {
    return options.reviewCandidates;
  }

  const affectedFamilyIds = new Set(options.affectedScope.reviewScopeFamilyIds);
  return options.reviewCandidates.filter(
    (candidate) =>
      affectedFamilyIds.has(candidate.leftNodeId) || affectedFamilyIds.has(candidate.rightNodeId)
  );
}

/**
 * Apply merge-family review decisions over already consolidated nodes.
 *
 * This is intentionally another inspectable union step rather than hidden
 * mutation inside prompt parsing.
 */
export function applyConsolidationReviewDecisions(
  graph: ConsolidatedThoughtGraph,
  decisions: ConsolidationReviewDecision[],
  reviewCandidates: ConsolidationReviewCandidate[] = []
): ConsolidatedThoughtGraph {
  const candidateByCaseId = new Map(reviewCandidates.map((candidate) => [candidate.caseId, candidate]));
  const mergeDecisions = decisions.filter(
    (decision) =>
      decision.decision === "merge_family" &&
      shouldAcceptMergeDecision(candidateByCaseId.get(decision.caseId))
  );
  if (mergeDecisions.length === 0) {
    return graph;
  }

  const nodes = graph.nodes.slice().sort((left, right) => left.id.localeCompare(right.id));
  const nodeIndexById = new Map(nodes.map((node, index) => [node.id, index]));
  const unionFind = createUnionFind(nodes.length);

  for (const decision of mergeDecisions) {
    const [, leftNodeId, rightNodeId] = decision.caseId.split("|");
    const leftIndex = leftNodeId ? nodeIndexById.get(leftNodeId) : undefined;
    const rightIndex = rightNodeId ? nodeIndexById.get(rightNodeId) : undefined;
    if (typeof leftIndex === "number" && typeof rightIndex === "number") {
      union(unionFind, leftIndex, rightIndex);
    }
  }

  const groupedNodes = new Map<number, ConsolidatedThoughtNode[]>();
  nodes.forEach((node, index) => {
    const root = findRoot(unionFind, index);
    const bucket = groupedNodes.get(root) ?? [];
    bucket.push(node);
    groupedNodes.set(root, bucket);
  });

  // Remap edges from the current consolidated node IDs to the refined family IDs.
  // The review pass works over already consolidated nodes, not raw thought nodes,
  // so using memberNodeIds here would leave every edge pointing at orphaned IDs.
  const nodeIdByCurrentNodeId = new Map<string, string>();
  const refinedNodes: ConsolidatedThoughtNode[] = Array.from(groupedNodes.values())
    .map((members) => {
      const representative = members
        .slice()
        .sort((left, right) => right.memberClaimIds.length - left.memberClaimIds.length)[0];
      const memberNodeIds = members.flatMap((member) => member.memberNodeIds).sort((left, right) =>
        left.localeCompare(right)
      );

      // Preserve the existing cluster ID when review kept a singleton untouched.
      // This keeps post-review artifacts much more stable across runs and makes
      // iteration diffs easier to inspect.
      const refinedId =
        members.length === 1
          ? (representative?.id ?? "consolidated:thought-family")
          : buildStableConsolidatedFamilyId({
              canonicalKey: representative?.canonicalKey ?? "thought-family",
              memberNodeIds
            });
      const aliases = Array.from(new Set(members.flatMap((member) => member.aliases))).sort((left, right) =>
        left.localeCompare(right)
      );
      const sourceRefs = dedupeSourceRefs(members.flatMap((member) => member.sourceRefs));
      const memberCanonicalKeys = Array.from(
        new Set(members.flatMap((member) => member.memberCanonicalKeys))
      ).sort((left, right) => left.localeCompare(right));
      const memberClaimIds = Array.from(
        new Set(members.flatMap((member) => member.memberClaimIds))
      ).sort((left, right) => left.localeCompare(right));
      const memberStateIds = Array.from(
        new Set(members.flatMap((member) => member.memberStateIds))
      ).sort((left, right) => left.localeCompare(right));
      const currentStateIds = Array.from(
        new Set(members.flatMap((member) => member.currentStateIds))
      ).sort((left, right) => left.localeCompare(right));
      const memberWorldlineIds = Array.from(
        new Set(members.flatMap((member) => member.memberWorldlineIds))
      ).sort((left, right) => left.localeCompare(right));
      const consolidationReasons = Array.from(
        new Set([
          ...members.flatMap((member) => member.consolidationReasons),
          ...(members.length > 1 ? (["llm_review_merge"] as const) : [])
        ])
      ).sort((left, right) => left.localeCompare(right));
      const frameMemberships = Array.from(
        members
          .flatMap((member) => member.frameMemberships ?? [])
          .reduce((map, membership) => {
            const key = [
              membership.documentId,
              membership.frameId,
              membership.subframeId ?? "",
              membership.frameRole ?? ""
            ].join(":");
            const existing = map.get(key);
            if (existing) {
              existing.occurrenceCount += membership.occurrenceCount;
            } else {
              map.set(key, { ...membership });
            }
            return map;
          }, new Map<string, ThoughtNodeFrameMembership>())
          .values()
      ).sort((left, right) => {
        if (left.documentId !== right.documentId) {
          return left.documentId.localeCompare(right.documentId);
        }
        if (left.frameId !== right.frameId) {
          return left.frameId.localeCompare(right.frameId);
        }
        return (left.subframeId ?? "").localeCompare(right.subframeId ?? "");
      });

      const signalBySourceKind = createSourceKindCounter();
      for (const member of members) {
        for (const [sourceKind, count] of Object.entries(member.signalBySourceKind) as Array<
          [SourceKind, number]
        >) {
          signalBySourceKind[sourceKind] += count;
        }
      }

      const firstSeen = members.reduce<string | null>((earliest, current) => {
        if (current.firstSeen === null) {
          return earliest;
        }
        if (earliest === null || compareTimes(current.firstSeen, earliest) < 0) {
          return current.firstSeen;
        }
        return earliest;
      }, null);

      const lastSeen = members.reduce<string | null>((latest, current) => {
        if (current.lastSeen === null) {
          return latest;
        }
        if (latest === null || compareTimes(current.lastSeen, latest) > 0) {
          return current.lastSeen;
        }
        return latest;
      }, null);

      for (const member of members) {
        nodeIdByCurrentNodeId.set(member.id, refinedId);
      }

      return {
        id: refinedId,
        canonicalKey: representative?.canonicalKey ?? "thought-family",
        title: representative?.title ?? "Konsolidovaná myšlenková rodina",
        summary: representative?.summary ?? "Konsolidovaná myšlenková rodina",
        nodeType: representative?.nodeType ?? "theme",
        status: representative?.status ?? ("active" satisfies ThoughtNodeStatus),
        firstSeen,
        lastSeen,
        sourceRefs,
        relatedNodeIds: [],
        aliases,
        signalBySourceKind,
        memberNodeIds,
        memberCanonicalKeys,
        memberClaimIds,
        memberStateIds,
        currentStateIds,
        memberWorldlineIds,
        consolidationReasons,
        frameMemberships
      } satisfies ConsolidatedThoughtNode;
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const edgeAggregates = new Map<string, {
    from: string;
    to: string;
    type: ThoughtRelationType;
    weight: number;
    supportingSourceNodeIds: Set<string>;
    supportingEdgeIds: Set<string>;
    sourceRelationTypes: Set<ThoughtRelationType>;
  }>();

  for (const edge of graph.edges) {
    const from = nodeIdByCurrentNodeId.get(edge.from) ?? edge.from;
    const to = nodeIdByCurrentNodeId.get(edge.to) ?? edge.to;
    if (from === to) {
      continue;
    }

    const key = relationKey(from, to, edge.type);
    const aggregate = edgeAggregates.get(key);
    if (aggregate) {
      aggregate.weight += edge.weight;
      edge.supportingSourceNodeIds.forEach((value) => aggregate.supportingSourceNodeIds.add(value));
      edge.supportingEdgeIds.forEach((value) => aggregate.supportingEdgeIds.add(value));
      edge.sourceRelationTypes.forEach((value) => aggregate.sourceRelationTypes.add(value));
      continue;
    }

    edgeAggregates.set(key, {
      from,
      to,
      type: edge.type,
      weight: edge.weight,
      supportingSourceNodeIds: new Set(edge.supportingSourceNodeIds),
      supportingEdgeIds: new Set(edge.supportingEdgeIds),
      sourceRelationTypes: new Set(edge.sourceRelationTypes)
    });
  }

  const refinedEdges: ConsolidatedThoughtEdge[] = Array.from(edgeAggregates.values())
    .map((aggregate) => ({
      id: relationKey(aggregate.from, aggregate.to, aggregate.type),
      from: aggregate.from,
      to: aggregate.to,
      type: aggregate.type,
      weight: aggregate.weight,
      supportingSourceNodeIds: Array.from(aggregate.supportingSourceNodeIds).sort((left, right) =>
        left.localeCompare(right)
      ),
      supportingEdgeIds: Array.from(aggregate.supportingEdgeIds).sort((left, right) =>
        left.localeCompare(right)
      ),
      sourceRelationTypes: Array.from(aggregate.sourceRelationTypes).sort((left, right) =>
        left.localeCompare(right)
      ) as ThoughtRelationType[]
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const relatedIdsByNodeId = new Map<string, Set<string>>();
  for (const edge of refinedEdges) {
    const left = relatedIdsByNodeId.get(edge.from) ?? new Set<string>();
    left.add(edge.to);
    relatedIdsByNodeId.set(edge.from, left);

    const right = relatedIdsByNodeId.get(edge.to) ?? new Set<string>();
    right.add(edge.from);
    relatedIdsByNodeId.set(edge.to, right);
  }

  for (const node of refinedNodes) {
    node.relatedNodeIds = Array.from(relatedIdsByNodeId.get(node.id) ?? new Set<string>()).sort(
      (left, right) => left.localeCompare(right)
    );
  }

  return {
    ...graph,
    generatedAt: new Date().toISOString(),
    nodeCount: refinedNodes.length,
    edgeCount: refinedEdges.length,
    nodes: refinedNodes,
    edges: refinedEdges
  };
}

function buildSynthesisPrompt(batchId: string, items: Array<{
  clusterId: string;
  nodeType: ThoughtNodeType;
  status: ThoughtNodeStatus;
  sourceDocumentIds: string[];
  memberTitles: string[];
  memberCanonicalKeys: string[];
  aliases: string[];
  claims: Array<{
    claim: string;
    rationale: string;
    excerpt: string;
    source: string;
  }>;
}>): string {
  return [
    "Vylepšuješ browseable název a shrnutí konsolidovaných thought units.",
    "Každá položka už reprezentuje jednu rodinu myšlenek. Nepřerozhoduj merge. Jen napiš lepší finální title a summary.",
    "Title musí být krátký, přirozený a browseable. Summary má být 1 až 3 věty a držet se uživatelovy terminologie.",
    "Title musí pojmenovat rozlišující jádro právě této rodiny. Nepoužij stejný title pro dvě různé položky v batchi, ani když jsou tematicky blízké.",
    "Každý cluster formuluj co nejužší věrnou větou. Nepřebírej tezi, důsledek ani podmínku ze sousedního clusteru jen proto, že jsou tematicky blízké.",
    "Když dvě položky sdílejí téma, jejich title a summary musí výslovně zachovat rozdíl daný vlastními claims: například obecná teze versus důsledek, mechanismus versus hodnocení nebo současná pozice versus vývojový thread.",
    "Nevytvářej dvě prakticky totožná summary pro různé clusterId. Pokud by se k tomu formulace blížila, vrať se k claims každé položky a pojmenuj její vlastní rozlišující jádro.",
    "Title i summary musí vycházet přímo z claims, rationale a source excerptů v payloadu, ne ze zobecňování už zobecněných aliasů.",
    "Nepřekládej uživatelovo myšlení do angličtiny.",
    `Všechny přirozenojazyčné výstupy piš v jazyce ${OUTPUT_LANGUAGE.outputLabel} (${OUTPUT_LANGUAGE.output}).`,
    "Nepoužívej generické manažerské formulace. Když je cluster explorativní nebo napjatý, summary to má přiznat.",
    "Vrať přesně jednu položku pro každý clusterId. Vrať pouze JSON.",
    "",
    "Batch payload:",
    JSON.stringify({ batchId, items }, null, 2)
  ].join("\n");
}

export function runSynthesisBatches(options: {
  graph: ConsolidatedThoughtGraph;
  artifacts: ThoughtCompilationArtifacts;
  client: CodexCliClient;
  paths: ProjectPaths;
  runState: ThoughtConsolidationRunState;
  affectedScope?: ThoughtConsolidationAffectedScope;
  previousFamilyIndex?: ThoughtConsolidationFamilyIndex | null;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  forceNewRun?: boolean;
  batchIdPrefix?: string;
  reusePersistedResults?: boolean;
  progress?: ProgressWriter;
}): SynthesisBatchRunResult {
  if (options.graph.nodes.length === 0) {
    return {
      results: [],
      reusedSynthesisCount: 0,
      generatedSynthesisCount: 0
    };
  }

  const progress = new ThrottledProgressReporter(options.progress);
  const runPaths = getThoughtConsolidationRunPaths(options.paths, options.runState.runId);
  const contract = resolveConsolidationContract(options);

  const schemaPath = writeSchemaFile(
    runPaths.stateDir,
    "consolidation-synthesis.schema.json",
    SYNTHESIS_OUTPUT_SCHEMA
  );

  const claimById = new Map(options.artifacts.claims.map((claim) => [claim.id, claim]));
  const sourceCorpus = JSON.parse(
    readFileSync(options.artifacts.graph.sourceCorpusPath, "utf8")
  ) as UnifiedCorpus;
  const segmentBySourceRefKey = new Map(
    sourceCorpus.segments.map((segment) => [sourceRefKey(segment.sourceRef), segment])
  );
  const items: SynthesisPromptItem[] = options.graph.nodes
    .map((node) => ({
      clusterId: node.id,
      nodeType: node.nodeType,
      status: node.status,
      sourceDocumentIds: Array.from(
        new Set(node.sourceRefs.map((sourceRef) => sourceRef.documentId))
      ).sort((left, right) => left.localeCompare(right)),
      memberTitles: Array.from(new Set([node.title, ...node.aliases])).slice(0, 10),
      memberCanonicalKeys: node.memberCanonicalKeys.slice(0, 10),
      aliases: node.aliases.slice(0, 12),
      claims: node.memberClaimIds
        .slice(0, 8)
        .map((claimId) => claimById.get(claimId))
        .filter((claim): claim is NonNullable<typeof claim> => Boolean(claim))
        .map((claim) => ({
          claim: claim.claim,
          rationale: claim.rationale,
          excerpt:
            segmentBySourceRefKey.get(sourceRefKey(claim.sourceRef))?.text ??
            segmentBySourceRefKey.get(sourceRefKey(claim.sourceRef))?.textPreview ??
            "",
          source: `${claim.sourceRef.documentTitle} / ${claim.sourceRef.locator}`
        }))
    }))
    // Source siblings should share a batch so synthesis can give related
    // families distinct browse titles instead of converging independently.
    .sort((left, right) => {
      const sourceDelta = (left.sourceDocumentIds[0] ?? "").localeCompare(
        right.sourceDocumentIds[0] ?? ""
      );
      if (sourceDelta !== 0) return sourceDelta;
      const titleDelta = slugify(left.memberTitles[0] ?? "").localeCompare(
        slugify(right.memberTitles[0] ?? "")
      );
      return titleDelta !== 0 ? titleDelta : left.clusterId.localeCompare(right.clusterId);
    });

  const completedBatchIds = new Set(options.runState.completedSynthesisBatchIds);
  const persistedResults = readJsonArtifact<ConsolidationSynthesisResult[]>(runPaths.synthesisPath, []);
  const persistedByClusterId = new Map(persistedResults.map((item) => [item.clusterId, item]));
  const resultByClusterId = options.reusePersistedResults === false
    ? new Map<string, ConsolidationSynthesisResult>()
    : new Map(persistedByClusterId);
  const synthesisScopeFamilyIds = new Set(options.affectedScope?.invalidatedSynthesisFamilyIds ?? []);
  const previousFamilyById = new Map(
    (options.previousFamilyIndex?.families ?? []).map((family) => [family.familyId, family])
  );
  const synthesisCachePath = getSynthesisCachePath(options.paths);
  const synthesisCache = readJsonArtifact<Record<string, SynthesisCacheEntry>>(synthesisCachePath, {});
  let reusedSynthesisCount = items.filter((item) => resultByClusterId.has(item.clusterId)).length;
  let generatedSynthesisCount = 0;
  const batchIdPrefix = options.batchIdPrefix ?? "synthesis";
  const persistResults = (): void => {
    writeJsonArtifact(
      runPaths.synthesisPath,
      Array.from(new Map([...persistedByClusterId, ...resultByClusterId]).values()).sort((left, right) =>
        left.clusterId.localeCompare(right.clusterId)
      )
    );
  };
  if (!options.forceNewRun && options.affectedScope?.mode === "incremental") {
    for (const item of items) {
      if (resultByClusterId.has(item.clusterId) || synthesisScopeFamilyIds.has(item.clusterId)) {
        continue;
      }

      const previous = previousFamilyById.get(item.clusterId);
      if (!previous) {
        continue;
      }

      resultByClusterId.set(item.clusterId, {
        clusterId: item.clusterId,
        title: previous.title,
        summary: previous.summary
      });
      reusedSynthesisCount += 1;
    }
  }
  const totalBatches = Math.ceil(items.length / THOUGHT_CONSOLIDATION_DEFAULTS.synthesisBatchSize);
  if (persistedResults.length > 0) {
    progress.phase(
      "consolidate:synthesis",
      `resuming synthesis from ${completedBatchIds.size}/${totalBatches} completed batches`
    );
  }
  progress.phase(
    "consolidate:synthesis",
    `${items.length} consolidated nodes across ${totalBatches} synthesis batches`
  );
  for (let index = 0; index < items.length; index += THOUGHT_CONSOLIDATION_DEFAULTS.synthesisBatchSize) {
    const slice = items.slice(index, index + THOUGHT_CONSOLIDATION_DEFAULTS.synthesisBatchSize);
    const batchNumber = index / THOUGHT_CONSOLIDATION_DEFAULTS.synthesisBatchSize + 1;
    const batchId = `${batchIdPrefix}-batch-${String(batchNumber).padStart(4, "0")}`;
    if (completedBatchIds.has(batchId)) {
      continue;
    }

    const unresolvedSlice = slice.filter((item) => {
      if (resultByClusterId.has(item.clusterId)) {
        return false;
      }
      if (options.forceNewRun) {
        return true;
      }

      const cacheKey = buildSynthesisCacheKey({
        item,
        model: contract.model,
        reasoningEffort: contract.reasoningEffort
      });
      const cached = synthesisCache[cacheKey];
      if (!cached) {
        return true;
      }

      resultByClusterId.set(item.clusterId, cached.result);
      reusedSynthesisCount += 1;
      return false;
    });

    if (unresolvedSlice.length === 0) {
      options.runState.completedSynthesisBatchIds.push(batchId);
      completedBatchIds.add(batchId);
      options.runState.updatedAt = new Date().toISOString();
      persistResults();
      writeThoughtConsolidationRunState(runPaths, options.runState);
      progress.item(
        "consolidate:synthesis",
        "synthesis-batches",
        batchNumber,
        totalBatches,
        batchId
      );
      continue;
    }

    const prompt = buildSynthesisPrompt(batchId, unresolvedSlice);
    try {
      const response = options.client.execSemanticBatch<SynthesisBatchOutput>({
        prompt,
        outputSchemaPath: schemaPath,
        workingDir: options.paths.root,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        extraWritableDirs: [options.paths.outputDir]
      });
      const validated = validateSynthesisBatchOutput(
        batchId,
        unresolvedSlice.map((item) => item.clusterId),
        response.parsed
      );
      generatedSynthesisCount += validated.items.length;
      for (const item of validated.items) {
        resultByClusterId.set(item.clusterId, item);
      }
      const now = new Date().toISOString();
      for (const item of unresolvedSlice) {
        const result = resultByClusterId.get(item.clusterId);
        if (!result) {
          continue;
        }
        const cacheKey = buildSynthesisCacheKey({
          item,
          model: contract.model,
          reasoningEffort: contract.reasoningEffort
        });
        synthesisCache[cacheKey] = {
          clusterId: item.clusterId,
          inputHash: buildSynthesisItemInputHash(item),
          model: contract.model,
          reasoningEffort: contract.reasoningEffort,
          result,
          updatedAt: now
        };
      }
      options.runState.completedSynthesisBatchIds.push(batchId);
      completedBatchIds.add(batchId);
      options.runState.failureKind = null;
      options.runState.failureMessage = null;
      options.runState.updatedAt = now;
      persistResults();
      writeJsonArtifact(synthesisCachePath, synthesisCache);
      writeThoughtConsolidationRunState(runPaths, options.runState);
      progress.item(
        "consolidate:synthesis",
        "synthesis-batches",
        batchNumber,
        totalBatches,
        batchId
      );
    } catch (error) {
      const failureKind = classifyConsolidationFailureKind(error);
      options.runState.status = deriveFailureStatus(failureKind ?? "other");
      options.runState.failureKind = failureKind;
      options.runState.failureMessage = error instanceof Error ? error.message : String(error);
      options.runState.updatedAt = new Date().toISOString();
      persistResults();
      writeThoughtConsolidationRunState(runPaths, options.runState);
      throw error;
    }
  }

  return {
    results: items
      .map((item) => resultByClusterId.get(item.clusterId))
      .filter((result): result is ConsolidationSynthesisResult => Boolean(result)),
    reusedSynthesisCount,
    generatedSynthesisCount
  };
}

function applySynthesisResults(
  graph: ConsolidatedThoughtGraph,
  synthesis: ConsolidationSynthesisResult[]
): ConsolidatedThoughtGraph {
  if (synthesis.length === 0) {
    return graph;
  }

  const synthesisByClusterId = new Map(synthesis.map((item) => [item.clusterId, item]));
  const nodes = graph.nodes.map((node) => {
    const refined = synthesisByClusterId.get(node.id);
    if (!refined) {
      return node;
    }

    return {
      ...node,
      title: refined.title,
      summary: refined.summary
    };
  });

  return {
    ...graph,
    generatedAt: new Date().toISOString(),
    nodes
  };
}

function duplicateTitleRepresentativeScore(node: ConsolidatedThoughtNode): number {
  const sourceDocumentCount = new Set(node.sourceRefs.map((sourceRef) => sourceRef.documentId)).size;
  const typePriority: Record<ThoughtNodeType, number> = {
    thesis: 5,
    question: 4,
    theme: 3,
    tension: 2,
    thread: 1
  };
  return (
    sourceDocumentCount * 1_000 +
    node.memberNodeIds.length * 100 +
    node.memberClaimIds.length * 10 +
    typePriority[node.nodeType]
  );
}

function chooseUniqueAliasTitle(
  node: ConsolidatedThoughtNode,
  duplicateTitle: string,
  usedTitleKeys: Set<string>,
  collidingTitles: string[] = [duplicateTitle],
  maximumCollisionSimilarity = 1
): string | null {
  const duplicateKey = slugify(duplicateTitle);
  const candidates = Array.from(new Set(node.aliases))
    .filter((alias) => {
      const aliasKey = slugify(alias);
      const tokenCount = tokenize(alias).length;
      return (
        aliasKey.length > 0 &&
        aliasKey !== duplicateKey &&
        !usedTitleKeys.has(aliasKey) &&
        collidingTitles.every(
          (title) => jaccard(tokenize(alias), tokenize(title)) < maximumCollisionSimilarity
        ) &&
        tokenCount >= 2 &&
        tokenCount <= 10 &&
        alias.length <= 90
      );
    })
    .sort((left, right) => {
      const tokenDelta = tokenize(left).length - tokenize(right).length;
      return tokenDelta !== 0 ? tokenDelta : left.length - right.length;
    });
  return candidates[0] ?? null;
}

/**
 * Synthesis batches are independent, so two distinct families can receive the
 * same final display title. Keep identities intact and reuse an existing alias
 * to make the browse surface unambiguous.
 */
export function disambiguateDuplicateNodeTitles(
  graph: ConsolidatedThoughtGraph
): ConsolidatedThoughtGraph {
  const groups = new Map<string, ConsolidatedThoughtNode[]>();
  for (const node of graph.nodes) {
    const key = slugify(node.title);
    if (!key) continue;
    const bucket = groups.get(key) ?? [];
    bucket.push(node);
    groups.set(key, bucket);
  }

  const usedTitleKeys = new Set(
    graph.nodes.map((node) => slugify(node.title)).filter(Boolean)
  );
  const replacementByNodeId = new Map<string, string>();
  const exactReplacementNodeIds = new Set<string>();
  for (const duplicateNodes of groups.values()) {
    if (duplicateNodes.length <= 1) continue;
    const ranked = duplicateNodes
      .slice()
      .sort((left, right) => {
        const scoreDelta =
          duplicateTitleRepresentativeScore(right) - duplicateTitleRepresentativeScore(left);
        return scoreDelta !== 0 ? scoreDelta : left.id.localeCompare(right.id);
      });
    for (const node of ranked.slice(1)) {
      const alias = chooseUniqueAliasTitle(node, node.title, usedTitleKeys);
      if (!alias) continue;
      replacementByNodeId.set(node.id, alias);
      exactReplacementNodeIds.add(node.id);
      usedTitleKeys.add(slugify(alias));
    }
  }

  const orderedNodes = graph.nodes.slice().sort((left, right) => left.id.localeCompare(right.id));
  const currentTitle = (node: ConsolidatedThoughtNode): string =>
    replacementByNodeId.get(node.id) ?? node.title;
  for (let leftIndex = 0; leftIndex < orderedNodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < orderedNodes.length; rightIndex += 1) {
      const left = orderedNodes[leftIndex]!;
      const right = orderedNodes[rightIndex]!;
      if (left.nodeType === right.nodeType) continue;
      const leftDocuments = new Set(left.sourceRefs.map((sourceRef) => sourceRef.documentId));
      if (!right.sourceRefs.some((sourceRef) => leftDocuments.has(sourceRef.documentId))) continue;

      const leftTitle = currentTitle(left);
      const rightTitle = currentTitle(right);
      const similarity = jaccard(tokenize(leftTitle), tokenize(rightTitle));
      if (
        similarity <
        THOUGHT_CONSOLIDATION_DEFAULTS.crossTypeNearTitleDisambiguationThreshold
      ) {
        continue;
      }

      const ranked = [left, right].sort((first, second) => {
        const scoreDelta =
          duplicateTitleRepresentativeScore(second) - duplicateTitleRepresentativeScore(first);
        return scoreDelta !== 0 ? scoreDelta : first.id.localeCompare(second.id);
      });
      const nodeToRename = ranked[1]!;
      const alias = chooseUniqueAliasTitle(
        nodeToRename,
        currentTitle(nodeToRename),
        usedTitleKeys,
        [leftTitle, rightTitle],
        THOUGHT_CONSOLIDATION_DEFAULTS.crossTypeNearTitleDisambiguationThreshold
      );
      if (!alias) continue;
      replacementByNodeId.set(nodeToRename.id, alias);
      usedTitleKeys.add(slugify(alias));
    }
  }

  if (replacementByNodeId.size === 0) return graph;
  return {
    ...graph,
    generatedAt: new Date().toISOString(),
    nodes: graph.nodes.map((node) => {
      const title = replacementByNodeId.get(node.id);
      return title
        ? {
            ...node,
            title,
            consolidationReasons: Array.from(new Set([
              ...node.consolidationReasons,
              exactReplacementNodeIds.has(node.id)
                ? "duplicate_title_disambiguation"
                : "title_collision_disambiguation"
            ])).sort((left, right) => left.localeCompare(right))
          }
        : node;
    })
  };
}

function buildConsolidationDiagnostics(options: {
  paths: ProjectPaths;
  graph: ConsolidatedThoughtGraph;
  incremental: ThoughtConsolidationIncrementalSummary;
}): ThoughtConsolidationDiagnostics {
  const segmentIndex = loadSegmentIndexArtifact(options.paths);
  const primarySegments = segmentIndex?.diff.primarySegments;
  const hasPreviousCorpus = Boolean(segmentIndex?.diff.previousCorpusHash);
  const totalPrimarySegmentCount = segmentIndex?.stats.primarySegmentCount ?? 0;
  const addedPrimarySegmentCount = primarySegments?.addedCount ?? 0;
  const changedPrimarySegmentCount = primarySegments?.changedCount ?? 0;
  const removedPrimarySegmentCount = primarySegments?.removedCount ?? 0;
  const newPrimarySegmentCount =
    addedPrimarySegmentCount + changedPrimarySegmentCount + removedPrimarySegmentCount;
  const reviewGeneratedShare = safeRatio(
    options.incremental.generatedReviewDecisionCount,
    options.incremental.reviewCandidateCount
  );
  const generatedSynthesisShare = safeRatio(
    options.incremental.generatedSynthesisCount,
    options.incremental.synthesisClusterCount
  );
  const newSemanticItemShare = safeRatio(newPrimarySegmentCount, totalPrimarySegmentCount);
  const thresholds = {
    generatedSynthesisShare:
      THOUGHT_CONSOLIDATION_DEFAULTS.driftGeneratedSynthesisShareThreshold,
    generatedReviewShare: THOUGHT_CONSOLIDATION_DEFAULTS.driftGeneratedReviewShareThreshold,
    newSemanticItemShare: THOUGHT_CONSOLIDATION_DEFAULTS.driftNewSemanticItemShareThreshold
  };
  const reasons: string[] = [];

  if (!hasPreviousCorpus) {
    reasons.push("No previous corpus diff is available; treating this run as the consolidation baseline.");
  }
  if (options.incremental.mode === "force_new_run") {
    reasons.push("This run intentionally refreshed consolidation outputs.");
  }
  if (hasPreviousCorpus && generatedSynthesisShare >= thresholds.generatedSynthesisShare) {
    reasons.push(
      `Generated synthesis share ${generatedSynthesisShare.toFixed(3)} reached threshold ${thresholds.generatedSynthesisShare}.`
    );
  }
  if (hasPreviousCorpus && reviewGeneratedShare >= thresholds.generatedReviewShare) {
    reasons.push(
      `Generated review share ${reviewGeneratedShare.toFixed(3)} reached diagnostic threshold ${thresholds.generatedReviewShare}; review churn alone does not recommend a broader rerun.`
    );
  }
  if (hasPreviousCorpus && newSemanticItemShare >= thresholds.newSemanticItemShare) {
    reasons.push(
      `New semantic item share ${newSemanticItemShare.toFixed(3)} reached threshold ${thresholds.newSemanticItemShare}.`
    );
  }
  if (reasons.length === 0) {
    reasons.push("Incremental reuse is within configured thresholds.");
  }

  const broaderConsolidationRerunRecommended =
    hasPreviousCorpus &&
    options.incremental.mode !== "force_new_run" &&
    (generatedSynthesisShare >= thresholds.generatedSynthesisShare ||
      newSemanticItemShare >= thresholds.newSemanticItemShare);

  return {
    generatedAt: new Date().toISOString(),
    mode: options.incremental.mode,
    sourceRunId: options.graph.sourceRunId,
    sourceNodeCount: options.graph.sourceNodeCount,
    sourceEdgeCount: options.graph.sourceEdgeCount,
    consolidatedNodeCount: options.graph.nodeCount,
    consolidatedEdgeCount: options.graph.edgeCount,
    semanticInput: {
      totalPrimarySegmentCount,
      unchangedPrimarySegmentCount: primarySegments?.unchangedCount ?? 0,
      addedPrimarySegmentCount,
      changedPrimarySegmentCount,
      removedPrimarySegmentCount,
      newPrimarySegmentShare: newSemanticItemShare
    },
    reuse: {
      reviewCandidateCount: options.incremental.reviewCandidateCount,
      reusedReviewDecisionCount: options.incremental.reusedReviewDecisionCount,
      generatedReviewDecisionCount: options.incremental.generatedReviewDecisionCount,
      reviewDecisionReuseShare: safeRatio(
        options.incremental.reusedReviewDecisionCount,
        options.incremental.reviewCandidateCount
      ),
      synthesisClusterCount: options.incremental.synthesisClusterCount,
      reusedSynthesisCount: options.incremental.reusedSynthesisCount,
      generatedSynthesisCount: options.incremental.generatedSynthesisCount,
      synthesisReuseShare: safeRatio(
        options.incremental.reusedSynthesisCount,
        options.incremental.synthesisClusterCount
      ),
      generatedSynthesisShare
    },
    thresholds,
    recommendation: {
      broaderPathUsed: false,
      broaderConsolidationRerunRecommended,
      severity: broaderConsolidationRerunRecommended
        ? "recommend"
        : hasPreviousCorpus &&
            (generatedSynthesisShare > thresholds.generatedSynthesisShare * 0.75 ||
              newSemanticItemShare > thresholds.newSemanticItemShare * 0.75)
          ? "watch"
          : "none",
      reasons
    }
  };
}

export function writeConsolidationDiagnostics(
  paths: ProjectPaths,
  diagnostics: ThoughtConsolidationDiagnostics
): string {
  const jsonPath = getConsolidationDiagnosticsJsonPath(paths);
  const markdownPath = getConsolidationDiagnosticsMarkdownPath(paths);
  writeJsonArtifact(jsonPath, diagnostics);
  mkdirSync(path.dirname(markdownPath), { recursive: true });
  writeFileSync(markdownPath, buildConsolidationDiagnosticsMarkdown(diagnostics), "utf8");
  return jsonPath;
}

/**
 * Hybrid refinement over the deterministic consolidated graph.
 *
 * The sequence is:
 * 1. deterministic graph produces safe merges
 * 2. Codex reviews only the ambiguity set
 * 3. Codex improves final title/summary phrasing on the resulting clusters
 */
export function refineConsolidatedThoughtGraph(options: {
  paths: ProjectPaths;
  artifacts: ThoughtCompilationArtifacts;
  consolidated: ThoughtConsolidationArtifacts;
  client: CodexCliClient;
  affectedScope?: ThoughtConsolidationAffectedScope;
  previousFamilyIndex?: ThoughtConsolidationFamilyIndex | null;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  forceNewRun?: boolean;
  progress?: ProgressWriter;
}): ThoughtConsolidationArtifacts {
  const progress = new ThrottledProgressReporter(options.progress);
  progress.phase("consolidate", "building ambiguity set for LLM review");
  const initialAllReviewCandidates = buildConsolidationReviewCandidates(options.consolidated.graph);
  const initialReviewCandidates = filterReviewCandidatesForAffectedScope({
    reviewCandidates: initialAllReviewCandidates,
    affectedScope: options.affectedScope,
    forceNewRun: options.forceNewRun
  });
  if (initialReviewCandidates.length !== initialAllReviewCandidates.length) {
    progress.phase(
      "consolidate",
      `filtered review candidates to affected scope: ${initialReviewCandidates.length}/${initialAllReviewCandidates.length}`
    );
  }
  const graphHash = computeConsolidationGraphHash(options.artifacts, options.consolidated);
  const runState = resumeOrCreateConsolidationRunState({
    paths: options.paths,
    graphHash,
    sourceRunId: options.artifacts.graph.runId,
    reviewCandidateCount: initialReviewCandidates.length,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    forceNewRun: options.forceNewRun
  });
  const runPaths = getThoughtConsolidationRunPaths(options.paths, runState.runId);
  ensureThoughtConsolidationRunLayout(runPaths);
  writeJsonArtifact(runPaths.reviewCandidatesPath, initialReviewCandidates);
  writeThoughtConsolidationRunState(runPaths, runState);

  const candidateByCaseId = new Map<string, ConsolidationReviewCandidate>();
  const decisionByCaseId = new Map<string, ConsolidationReviewDecision>();
  let currentGraph = options.consolidated.graph;
  let currentCandidates = initialReviewCandidates;
  let focusFamilyIds = new Set<string>([
    ...(options.affectedScope?.reviewScopeFamilyIds ?? []),
    ...(options.affectedScope?.synthesisScopeFamilyIds ?? [])
  ]);
  let finalSynthesis: SynthesisBatchRunResult = {
    results: [],
    reusedSynthesisCount: 0,
    generatedSynthesisCount: 0
  };
  let totalReusedReviewDecisionCount = 0;
  let totalGeneratedReviewDecisionCount = 0;
  let totalReusedSynthesisCount = 0;
  let totalGeneratedSynthesisCount = 0;
  let fixedPointReached = false;

  for (
    let pass = 1;
    pass <= THOUGHT_CONSOLIDATION_DEFAULTS.maxReviewFixedPointPasses;
    pass += 1
  ) {
    currentCandidates.forEach((candidate) => candidateByCaseId.set(candidate.caseId, candidate));
    const review = runReviewBatches({
      reviewCandidates: currentCandidates,
      client: options.client,
      paths: options.paths,
      runState,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      forceNewRun: options.forceNewRun,
      batchIdPrefix: pass === 1 ? "review" : `review-pass-${String(pass).padStart(2, "0")}`,
      reusePersistedResults: pass === 1,
      progress: options.progress
    });
    review.decisions.forEach((decision) => decisionByCaseId.set(decision.caseId, decision));
    // Incremental reuse diagnostics describe the primary changed-input pass.
    // Fixed-point verification calls are correctness work over that result,
    // not additional source items; counting them would produce shares > 1.
    if (pass === 1) {
      totalReusedReviewDecisionCount += review.reusedDecisionCount;
      totalGeneratedReviewDecisionCount += review.generatedDecisionCount;
    }
    progress.phase(
      "consolidate",
      `review pass ${pass}: ${review.decisions.length} decisions`
    );

    const reviewedGraph = applyConsolidationReviewDecisions(
      currentGraph,
      review.decisions,
      currentCandidates
    );
    const beforeIds = new Set(currentGraph.nodes.map((node) => node.id));
    const afterIds = new Set(reviewedGraph.nodes.map((node) => node.id));
    const mergeChangedIds = new Set<string>([
      ...Array.from(beforeIds).filter((id) => !afterIds.has(id)),
      ...Array.from(afterIds).filter((id) => !beforeIds.has(id))
    ]);
    const mergeApplied =
      computeConsolidatedGraphSemanticHash(reviewedGraph) !==
      computeConsolidatedGraphSemanticHash(currentGraph);

    // Synthesis is part of the fixed-point surface: rewritten titles and
    // summaries can expose a review candidate that did not exist beforehand.
    // A review-only verification pass that merged nothing does not need to
    // synthesize the already-final graph again.
    let synthesizedGraph = reviewedGraph;
    if (pass === 1 || mergeApplied) {
      const synthesis = runSynthesisBatches({
        graph: reviewedGraph,
        artifacts: options.artifacts,
        client: options.client,
        paths: options.paths,
        runState,
        affectedScope: options.affectedScope,
        previousFamilyIndex: options.previousFamilyIndex,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        forceNewRun: options.forceNewRun,
        batchIdPrefix: pass === 1 ? "synthesis" : `synthesis-pass-${String(pass).padStart(2, "0")}`,
        reusePersistedResults: pass === 1,
        progress: options.progress
      });
      finalSynthesis = synthesis;
      if (pass === 1) {
        totalReusedSynthesisCount += synthesis.reusedSynthesisCount;
        totalGeneratedSynthesisCount += synthesis.generatedSynthesisCount;
      }
      synthesizedGraph = disambiguateDuplicateNodeTitles(
        applySynthesisResults(reviewedGraph, synthesis.results)
      );
    }
    const reviewedNodeById = new Map(reviewedGraph.nodes.map((node) => [node.id, node]));
    const phrasingChangedIds = synthesizedGraph.nodes
      .filter((node) => {
        const previous = reviewedNodeById.get(node.id);
        return previous && (previous.title !== node.title || previous.summary !== node.summary);
      })
      .map((node) => node.id);
    focusFamilyIds = new Set([...focusFamilyIds, ...mergeChangedIds, ...phrasingChangedIds]);
    currentGraph = synthesizedGraph;
    runState.reviewPassCount = pass;

    const nextAllCandidates = buildConsolidationReviewCandidates(currentGraph);
    const nextCandidates = options.forceNewRun || options.affectedScope?.mode !== "incremental"
      ? nextAllCandidates
      : nextAllCandidates.filter((candidate) =>
          focusFamilyIds.has(candidate.leftNodeId) || focusFamilyIds.has(candidate.rightNodeId)
        );

    // Re-evaluate cases after synthesis only when their semantic candidate
    // payload changed. The global decision cache remains the authority for an
    // unchanged case and prevents a fixed-point loop over keep-separate pairs.
    const previousCandidateById = new Map(
      Array.from(candidateByCaseId.values()).map((candidate) => [
        candidate.caseId,
        buildReviewCandidateInputHash(candidate)
      ])
    );
    currentCandidates = nextCandidates.filter((candidate) =>
      previousCandidateById.get(candidate.caseId) !== buildReviewCandidateInputHash(candidate)
    );

    if (!mergeApplied && currentCandidates.length === 0) {
      fixedPointReached = true;
      break;
    }
    if (pass === THOUGHT_CONSOLIDATION_DEFAULTS.maxReviewFixedPointPasses) {
      throw new Error(
        `Consolidation did not reach a review fixed point after ${pass} passes; rerun to resume without marking the artifact completed.`
      );
    }
  }

  if (!fixedPointReached) {
    throw new Error("Consolidation ended without a verified review fixed point.");
  }
  const reviewCandidates = Array.from(candidateByCaseId.values()).sort((left, right) =>
    left.caseId.localeCompare(right.caseId)
  );
  const reviewDecisions = Array.from(decisionByCaseId.values()).sort((left, right) =>
    left.caseId.localeCompare(right.caseId)
  );
  writeJsonArtifact(runPaths.reviewCandidatesPath, reviewCandidates);
  progress.phase(
    "consolidate",
    `fixed point reached after ${runState.reviewPassCount ?? 1} review passes: ${currentGraph.nodeCount} nodes / ${currentGraph.edgeCount} edges`
  );

  runState.status = "completed";
  runState.failureKind = null;
  runState.failureMessage = null;
  runState.updatedAt = new Date().toISOString();
  runState.completedAt = runState.updatedAt;
  runState.fixedPointReached = true;
  writeJsonArtifact(runPaths.reviewDecisionsPath, reviewDecisions);
  writeJsonArtifact(runPaths.synthesisPath, finalSynthesis.results);
  writeThoughtConsolidationRunState(runPaths, runState);

  const incremental: ThoughtConsolidationIncrementalSummary = {
    mode: options.forceNewRun ? "force_new_run" : "incremental",
    reviewCandidateCount: reviewCandidates.length,
    reusedReviewDecisionCount: totalReusedReviewDecisionCount,
    generatedReviewDecisionCount: totalGeneratedReviewDecisionCount,
    synthesisClusterCount: currentGraph.nodes.length,
    reusedSynthesisCount: totalReusedSynthesisCount,
    generatedSynthesisCount: totalGeneratedSynthesisCount
  };
  const finalGraph = currentGraph;
  const diagnostics = buildConsolidationDiagnostics({
    paths: options.paths,
    graph: finalGraph,
    incremental
  });
  writeConsolidationDiagnostics(options.paths, diagnostics);

  return {
    graph: finalGraph,
    reviewCandidates,
    reviewDecisions,
    synthesis: finalSynthesis.results,
    incremental,
    diagnostics
  };
}
