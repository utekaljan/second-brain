import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import { CodexCliClient, type CodexReasoningEffort } from "../codex/client.js";
import type { ProjectPaths } from "../system/paths.js";
import type { SourceKind, UnifiedSourceRef } from "../types/domain.js";
import { ThrottledProgressReporter, type ProgressWriter } from "../utils/progress.js";
import { buildStableConsolidatedFamilyId } from "./consolidation_identity.js";
import {
  refineConsolidatedThoughtGraph,
  writeConsolidationDiagnostics
} from "./consolidation_refine.js";
import {
  buildConsolidationAffectedScope,
  buildConsolidationStateArtifacts,
  getConsolidationAffectedScopePath,
  getConsolidationDependencyIndexPath,
  getConsolidationFamilyIndexPath,
  getConsolidationNodeFamilyIndexPath,
  loadConsolidationDependencyIndex,
  loadConsolidationFamilyIndex,
  loadConsolidationNodeFamilyIndex,
  writeConsolidationStateArtifacts
} from "./consolidation_state.js";
import { loadSegmentIndexArtifact } from "./semantic_cache.js";
import { getThoughtConsolidationRunPaths, loadThoughtConsolidationCheckpoint } from "./state.js";
import type {
  ConsolidationReviewCandidate,
  ConsolidationReviewDecision,
  ConsolidatedThoughtEdge,
  ConsolidatedThoughtGraph,
  ConsolidatedThoughtNode,
  ThoughtClaim,
  ThoughtCompilationArtifacts,
  ThoughtConsolidationArtifacts,
  ThoughtConsolidationSummary,
  ThoughtEdge,
  ThoughtGraph,
  ThoughtNode,
  ThoughtNodeFrameMembership,
  ThoughtNodeState,
  ThoughtConsolidationAffectedScope,
  ThoughtConsolidationDependencyIndex,
  ThoughtConsolidationFamilyIndex,
  ThoughtConsolidationNodeFamilyIndex,
  ThoughtRelationType,
  ThoughtWorldline
} from "./types.js";

const THOUGHT_COMPILER_DEFAULTS = SECOND_BRAIN_DEFAULTS.thoughtCompiler;
const THOUGHT_CONSOLIDATION_DEFAULTS = SECOND_BRAIN_DEFAULTS.thoughtConsolidation;

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function collectReviewMergedFamilyIds(options: {
  reviewCandidates?: ConsolidationReviewCandidate[];
  reviewDecisions?: ConsolidationReviewDecision[];
}): string[] {
  const candidateByCaseId = new Map(
    (options.reviewCandidates ?? []).map((candidate) => [candidate.caseId, candidate])
  );
  const mergedFamilyIds = new Set<string>();

  for (const decision of options.reviewDecisions ?? []) {
    if (decision.decision !== "merge_family") {
      continue;
    }
    const candidate = candidateByCaseId.get(decision.caseId);
    if (!candidate) {
      continue;
    }
    mergedFamilyIds.add(candidate.leftNodeId);
    mergedFamilyIds.add(candidate.rightNodeId);
  }

  return uniqueSorted(mergedFamilyIds);
}

type NodeFeature = {
  node: ThoughtNode;
  titleTokens: string[];
  summaryTokens: string[];
  canonicalTokens: string[];
};

type PairDecision = {
  mergeable: boolean;
  reason: string | null;
};

type PositiveNeighborSummary = {
  sharedCount: number;
  jaccard: number;
};

type EdgeAggregate = {
  from: string;
  to: string;
  type: ThoughtRelationType;
  weight: number;
  supportingSourceNodeIds: Set<string>;
  supportingEdgeIds: Set<string>;
  sourceRelationTypes: Set<ThoughtRelationType>;
};

// This pass works over already-semantic graph artifacts. Token filtering is
// therefore only a cheap post-graph grouping helper, not a substitute for
// semantic extraction from raw source text.
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

class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(value: number): number {
    if (this.parent[value] === value) {
      return value;
    }

    const next = this.find(this.parent[value] ?? value);
    this.parent[value] = next;
    return next;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) {
      this.parent[rightRoot] = leftRoot;
    }
  }
}

/**
 * Pick the most frequent value from a small cluster-level candidate list.
 *
 * This is only used as a deterministic fallback when the chosen
 * representative node is missing a field, which should be rare.
 */
function countWinners<T extends string>(values: T[], fallback: T): T {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  let winner = fallback;
  let winnerCount = -1;
  for (const [value, count] of counts.entries()) {
    if (count > winnerCount) {
      winner = value;
      winnerCount = count;
    }
  }

  return winner;
}

/**
 * Compare nullable ISO timestamps while keeping nulls at the end.
 */
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

/**
 * Source refs stay inspectable, so cluster-level dedupe must preserve the
 * full object instead of collapsing them to a weaker string form on disk.
 */
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

/**
 * Consolidated nodes keep the same source-kind breakdown as granular nodes so
 * the wiki layer can still show whether a thought mostly comes from writings,
 * conversations, or chats.
 */
function createSourceKindCounter(): Record<SourceKind, number> {
  return {
    writing: 0,
    conversation: 0,
    chat: 0
  };
}

function tokenize(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

/**
 * Very lightweight lexical similarity used only after the semantic compiler
 * has already proposed nodes. This guards consolidation, it does not decide meaning.
 */
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

/**
 * Symmetric relation types share one aggregate key so the consolidated graph
 * does not emit duplicate A<->B edges for the same semantic relation family.
 */
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

/**
 * Load the current granular compiler artifacts from output/compiled.
 *
 * Consolidation is intentionally a second stage over persisted artifacts, not
 * an in-memory side effect hidden inside the first compiler pass.
 */
export function loadThoughtCompilationArtifacts(paths: ProjectPaths): ThoughtCompilationArtifacts {
  const claimsPath = path.join(
    paths.compiledDir,
    THOUGHT_COMPILER_DEFAULTS.compiledClaimsFilename
  );
  const nodesPath = path.join(paths.compiledDir, THOUGHT_COMPILER_DEFAULTS.compiledNodesFilename);
  const nodeStatesPath = path.join(
    paths.compiledDir,
    THOUGHT_COMPILER_DEFAULTS.compiledNodeStatesFilename
  );
  const worldlinesPath = path.join(
    paths.compiledDir,
    THOUGHT_COMPILER_DEFAULTS.compiledWorldlinesFilename
  );
  const identityBlocksPath = path.join(
    paths.compiledDir,
    THOUGHT_COMPILER_DEFAULTS.compiledIdentityBlocksFilename
  );
  const graphPath = path.join(paths.compiledDir, THOUGHT_COMPILER_DEFAULTS.compiledGraphFilename);
  const documentFramesPath = path.join(
    paths.compiledDir,
    THOUGHT_COMPILER_DEFAULTS.compiledDocumentFramesFilename
  );

  const requiredPaths = [
    claimsPath,
    nodesPath,
    nodeStatesPath,
    worldlinesPath,
    identityBlocksPath,
    graphPath
  ];

  for (const target of requiredPaths) {
    if (!existsSync(target)) {
      throw new Error(
        `Missing compiled thought artifact at ${target}. Run compile-thought-nodes first.`
      );
    }
  }

  return {
    documentFrames: existsSync(documentFramesPath)
      ? JSON.parse(readFileSync(documentFramesPath, "utf8"))
      : null,
    claims: JSON.parse(readFileSync(claimsPath, "utf8")) as ThoughtClaim[],
    graph: JSON.parse(readFileSync(graphPath, "utf8")) as ThoughtGraph,
    nodeStates: JSON.parse(readFileSync(nodeStatesPath, "utf8")) as ThoughtNodeState[],
    worldlines: JSON.parse(readFileSync(worldlinesPath, "utf8")) as ThoughtWorldline[],
    identityBlocks: JSON.parse(readFileSync(identityBlocksPath, "utf8"))
  } as ThoughtCompilationArtifacts;
}

function buildNodeFeatures(nodes: ThoughtNode[]): NodeFeature[] {
  return nodes.map((node) => ({
    node,
    titleTokens: tokenize(node.title),
    summaryTokens: tokenize(node.summary),
    canonicalTokens: tokenize(node.canonicalKey)
  }));
}

/**
 * Build a cheap unordered lookup because consolidation decisions care about
 * whether two nodes are connected at all, not which direction the lookup came from.
 */
function buildEdgeLookup(edges: ThoughtEdge[]): Map<string, ThoughtEdge[]> {
  const lookup = new Map<string, ThoughtEdge[]>();
  for (const edge of edges) {
    const ordered = [edge.from, edge.to].sort((left, right) => left.localeCompare(right));
    const key = `${ordered[0] ?? edge.from}:${ordered[1] ?? edge.to}`;
    const bucket = lookup.get(key) ?? [];
    bucket.push(edge);
    lookup.set(key, bucket);
  }
  return lookup;
}

function buildPositiveNeighborLookup(edges: ThoughtEdge[]): Map<string, Set<string>> {
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

    const fromBucket = lookup.get(edge.from) ?? new Set<string>();
    fromBucket.add(edge.to);
    lookup.set(edge.from, fromBucket);

    const toBucket = lookup.get(edge.to) ?? new Set<string>();
    toBucket.add(edge.from);
    lookup.set(edge.to, toBucket);
  }

  return lookup;
}

function summarizePositiveNeighborhood(
  positiveNeighborLookup: Map<string, Set<string>>,
  leftNodeId: string,
  rightNodeId: string
): PositiveNeighborSummary {
  const left = new Set(positiveNeighborLookup.get(leftNodeId) ?? []);
  const right = new Set(positiveNeighborLookup.get(rightNodeId) ?? []);
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

function getPairEdges(
  edgeLookup: Map<string, ThoughtEdge[]>,
  leftNodeId: string,
  rightNodeId: string
): ThoughtEdge[] {
  const ordered = [leftNodeId, rightNodeId].sort((left, right) => left.localeCompare(right));
  return edgeLookup.get(`${ordered[0] ?? leftNodeId}:${ordered[1] ?? rightNodeId}`) ?? [];
}

function hasRevisionFamilyAffinity(
  pairEdges: ThoughtEdge[],
  titleScore: number,
  summaryScore: number,
  canonicalScore: number,
  neighborSummary: PositiveNeighborSummary
): boolean {
  if (pairEdges.some((edge) => edge.type === "supports")) {
    return true;
  }

  if (
    titleScore >= THOUGHT_CONSOLIDATION_DEFAULTS.revisionLexicalThreshold ||
    summaryScore >= THOUGHT_CONSOLIDATION_DEFAULTS.revisionLexicalThreshold ||
    canonicalScore >= THOUGHT_CONSOLIDATION_DEFAULTS.revisionLexicalThreshold
  ) {
    return true;
  }

  return (
    neighborSummary.sharedCount >=
      THOUGHT_CONSOLIDATION_DEFAULTS.revisionSharedNeighborThreshold &&
    neighborSummary.jaccard >=
      THOUGHT_CONSOLIDATION_DEFAULTS.revisionSharedNeighborJaccardThreshold
  );
}

/**
 * Some relations mean "keep these families apart" even if they are lexically close.
 *
 * `tensions_with` and `context_split` are treated as hard stops so the
 * consolidation pass does not flatten meaningful disagreement or
 * condition-sensitive branching into one browseable blob.
 */
function groupsHaveBlockingRelation(
  leftFeatures: NodeFeature[],
  rightFeatures: NodeFeature[],
  edgeLookup: Map<string, ThoughtEdge[]>
): boolean {
  return leftFeatures.some((leftFeature) =>
    rightFeatures.some((rightFeature) =>
      getPairEdges(edgeLookup, leftFeature.node.id, rightFeature.node.id).some(
        (edge) => edge.type === "tensions_with" || edge.type === "context_split"
      )
    )
  );
}

/**
 * Decide whether two granular nodes look like members of the same larger family.
 *
 * Merge signals are intentionally conservative:
 * - exact canonical reuse is strongest
 * - explicit revision/supersession implies one worldline family
 * - support/semantic-related only helps when lexical overlap also agrees
 * - lexical-only merges require higher thresholds
 */
function pairMergeDecision(
  left: NodeFeature,
  right: NodeFeature,
  edgeLookup: Map<string, ThoughtEdge[]>,
  positiveNeighborLookup: Map<string, Set<string>>
): PairDecision {
  if (left.node.nodeType !== right.node.nodeType) {
    return { mergeable: false, reason: null };
  }

  const pairEdges = getPairEdges(edgeLookup, left.node.id, right.node.id);
  if (pairEdges.some((edge) => edge.type === "tensions_with" || edge.type === "context_split")) {
    return { mergeable: false, reason: null };
  }

  const titleScore = jaccard(left.titleTokens, right.titleTokens);
  const summaryScore = jaccard(left.summaryTokens, right.summaryTokens);
  const canonicalScore = jaccard(left.canonicalTokens, right.canonicalTokens);
  const neighborSummary = summarizePositiveNeighborhood(
    positiveNeighborLookup,
    left.node.id,
    right.node.id
  );

  if (left.node.canonicalKey === right.node.canonicalKey) {
    return { mergeable: true, reason: "exact_canonical_key" };
  }

  if (
    pairEdges.some((edge) => edge.type === "revises" || edge.type === "supersedes") &&
    hasRevisionFamilyAffinity(pairEdges, titleScore, summaryScore, canonicalScore, neighborSummary)
  ) {
    return { mergeable: true, reason: "revision_family" };
  }

  if (
    pairEdges.some((edge) => edge.type === "semantic_related" || edge.type === "supports") &&
    neighborSummary.sharedCount >= THOUGHT_CONSOLIDATION_DEFAULTS.deterministicSharedNeighborThreshold &&
    (titleScore >= THOUGHT_CONSOLIDATION_DEFAULTS.relationAssistedTitleThreshold ||
      summaryScore >= THOUGHT_CONSOLIDATION_DEFAULTS.relationAssistedSummaryThreshold)
  ) {
    return { mergeable: true, reason: "relation_assisted_family" };
  }

  if (
    (neighborSummary.sharedCount >=
      THOUGHT_CONSOLIDATION_DEFAULTS.deterministicSharedNeighborThreshold &&
      titleScore >= THOUGHT_CONSOLIDATION_DEFAULTS.lexicalMergeThreshold) ||
    (neighborSummary.sharedCount >=
      THOUGHT_CONSOLIDATION_DEFAULTS.deterministicSharedNeighborThreshold &&
      canonicalScore >= THOUGHT_CONSOLIDATION_DEFAULTS.lexicalMergeThreshold) ||
    (neighborSummary.sharedCount >=
      THOUGHT_CONSOLIDATION_DEFAULTS.deterministicSharedNeighborThreshold &&
      titleScore >= THOUGHT_CONSOLIDATION_DEFAULTS.relationAssistedTitleThreshold &&
      summaryScore >= THOUGHT_CONSOLIDATION_DEFAULTS.lexicalSummaryThreshold)
  ) {
    return { mergeable: true, reason: "lexical_family" };
  }

  return { mergeable: false, reason: null };
}

/**
 * Cluster granular nodes into candidate browseable thought families.
 *
 * The pass iterates until no more safe unions are found because earlier merges
 * can expose later family-level merges. Blocking relations are rechecked at the
 * current group level so a merged family cannot silently swallow a tension partner.
 */
function buildConsolidationClusters(
  nodes: ThoughtNode[],
  edges: ThoughtEdge[]
): Array<{ canonicalKey: string; reasons: string[]; members: NodeFeature[] }> {
  const features = buildNodeFeatures(nodes);
  const unionFind = new UnionFind(features.length);
  const edgeLookup = buildEdgeLookup(edges);
  const positiveNeighborLookup = buildPositiveNeighborLookup(edges);
  const reasonsByRoot = new Map<number, Set<string>>();

  const getGroupMembers = (index: number): NodeFeature[] => {
    const root = unionFind.find(index);
    return features.filter((_, featureIndex) => unionFind.find(featureIndex) === root);
  };

  let changed = true;
  while (changed) {
    changed = false;

    for (let leftIndex = 0; leftIndex < features.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < features.length; rightIndex += 1) {
        if (unionFind.find(leftIndex) === unionFind.find(rightIndex)) {
          continue;
        }

        const leftGroup = getGroupMembers(leftIndex);
        const rightGroup = getGroupMembers(rightIndex);
        if (groupsHaveBlockingRelation(leftGroup, rightGroup, edgeLookup)) {
          continue;
        }

        const decisions = leftGroup.flatMap((leftFeature) =>
          rightGroup.map((rightFeature) =>
            pairMergeDecision(leftFeature, rightFeature, edgeLookup, positiveNeighborLookup)
          )
        );
        const mergeDecision = decisions.find((decision) => decision.mergeable);

        if (!mergeDecision?.reason) {
          continue;
        }

        const leftRootBefore = unionFind.find(leftIndex);
        const rightRootBefore = unionFind.find(rightIndex);
        unionFind.union(leftIndex, rightIndex);
        const mergedRoot = unionFind.find(leftIndex);
        const reasons = new Set<string>([
          ...(reasonsByRoot.get(leftRootBefore) ?? []),
          ...(reasonsByRoot.get(rightRootBefore) ?? [])
        ]);
        reasons.add(mergeDecision.reason);
        reasonsByRoot.set(mergedRoot, reasons);
        changed = true;
      }
    }
  }

  const groups = new Map<number, NodeFeature[]>();
  features.forEach((feature, index) => {
    const root = unionFind.find(index);
    const bucket = groups.get(root) ?? [];
    bucket.push(feature);
    groups.set(root, bucket);
  });

  return Array.from(groups.entries())
    .map(([root, members]) => {
      // The representative is the member whose wording and evidence will anchor
      // the visible consolidated node. Favor denser, better-connected nodes so
      // the output feels more like a durable thought unit than a thin alias.
      const representative = members
        .slice()
        .sort((left, right) => {
          const leftSignal = Object.values(left.node.signalBySourceKind).reduce(
            (sum, value) => sum + value,
            0
          );
          const rightSignal = Object.values(right.node.signalBySourceKind).reduce(
            (sum, value) => sum + value,
            0
          );

          if (left.node.evidence.length !== right.node.evidence.length) {
            return right.node.evidence.length - left.node.evidence.length;
          }
          if (leftSignal !== rightSignal) {
            return rightSignal - leftSignal;
          }
          if (left.node.relatedNodeIds.length !== right.node.relatedNodeIds.length) {
            return right.node.relatedNodeIds.length - left.node.relatedNodeIds.length;
          }
          return left.node.id.localeCompare(right.node.id);
        })[0];

      return {
        canonicalKey: representative?.node.canonicalKey ?? "consolidated-thought",
        reasons: Array.from(reasonsByRoot.get(root) ?? new Set(["single_node"])).sort((left, right) =>
          left.localeCompare(right)
        ),
        members: members.sort((left, right) => left.node.id.localeCompare(right.node.id))
      };
    })
    .sort((left, right) => left.canonicalKey.localeCompare(right.canonicalKey));
}

/**
 * Aggregate cluster members into final consolidated nodes while preserving
 * provenance back to claims, states, and worldlines.
 */
function buildConsolidatedNodes(
  clusters: Array<{ canonicalKey: string; reasons: string[]; members: NodeFeature[] }>,
  claims: ThoughtClaim[],
  nodeStates: ThoughtNodeState[],
  worldlines: ThoughtWorldline[]
): {
  nodes: ConsolidatedThoughtNode[];
  consolidatedIdBySourceNodeId: Map<string, string>;
} {
  const claimsByNodeId = new Map<string, ThoughtClaim[]>();
  const statesByNodeId = new Map<string, ThoughtNodeState[]>();
  const worldlineByNodeId = new Map<string, ThoughtWorldline>();

  for (const claim of claims) {
    const bucket = claimsByNodeId.get(claim.nodeId) ?? [];
    bucket.push(claim);
    claimsByNodeId.set(claim.nodeId, bucket);
  }

  for (const state of nodeStates) {
    const bucket = statesByNodeId.get(state.nodeId) ?? [];
    bucket.push(state);
    statesByNodeId.set(state.nodeId, bucket);
  }

  for (const worldline of worldlines) {
    worldlineByNodeId.set(worldline.nodeId, worldline);
  }

  const consolidatedIdBySourceNodeId = new Map<string, string>();
  const consolidatedNodes = clusters.map((cluster) => {
    const representative = cluster.members[0]?.node;

    const sourceRefs = dedupeSourceRefs(cluster.members.flatMap((member) => member.node.sourceRefs));
    const aliases = Array.from(
      new Set(cluster.members.flatMap((member) => member.node.aliases))
    ).sort((left, right) => left.localeCompare(right));
    const frameMemberships = Array.from(
      cluster.members
        .flatMap((member) => member.node.frameMemberships ?? [])
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
    const memberNodeIds = cluster.members.map((member) => member.node.id);
    const memberClaimIds = cluster.members.flatMap(
      (member) => claimsByNodeId.get(member.node.id)?.map((claim) => claim.id) ?? []
    );
    const memberStateIds = cluster.members.flatMap(
      (member) => statesByNodeId.get(member.node.id)?.map((state) => state.id) ?? []
    );
    const currentStateIds = cluster.members
      .map((member) => member.node.currentStateId)
      .filter((value): value is string => value !== null)
      .sort((left, right) => left.localeCompare(right));
    const memberWorldlineIds = cluster.members
      .map((member) => worldlineByNodeId.get(member.node.id)?.id)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => left.localeCompare(right));
    const nodeId = buildStableConsolidatedFamilyId({
      canonicalKey: cluster.canonicalKey,
      memberNodeIds
    });
    const firstSeen = cluster.members
      .map((member) => member.node.firstSeen)
      .reduce<string | null>((earliest, current) => {
        if (current === null) {
          return earliest;
        }
        if (earliest === null || compareTimes(current, earliest) < 0) {
          return current;
        }
        return earliest;
      }, null);
    const lastSeen = cluster.members
      .map((member) => member.node.lastSeen)
      .reduce<string | null>((latest, current) => {
        if (current === null) {
          return latest;
        }
        if (latest === null || compareTimes(current, latest) > 0) {
          return current;
        }
        return latest;
      }, null);

    // Source-kind totals survive consolidation so later wiki pages can still
    // signal where a thought mostly lives in the corpus.
    const signalBySourceKind = createSourceKindCounter();
    for (const member of cluster.members) {
      for (const [sourceKind, count] of Object.entries(member.node.signalBySourceKind) as Array<
        [SourceKind, number]
      >) {
        signalBySourceKind[sourceKind] += count;
      }
    }

    for (const memberNodeId of memberNodeIds) {
      consolidatedIdBySourceNodeId.set(memberNodeId, nodeId);
    }

    return {
      id: nodeId,
      canonicalKey: cluster.canonicalKey,
      title:
        representative?.title ??
        countWinners(
          cluster.members.map((member) => member.node.title),
          "Konsolidovaná myšlenka"
        ),
      summary:
        representative?.summary ??
        countWinners(
          cluster.members.map((member) => member.node.summary),
          "Konsolidovaná myšlenka"
        ),
      nodeType:
        representative?.nodeType ??
        countWinners(
          cluster.members.map((member) => member.node.nodeType),
          "theme"
        ),
      status:
        representative?.status ??
        countWinners(
          cluster.members.map((member) => member.node.status),
          "active"
        ),
      firstSeen,
      lastSeen,
      sourceRefs,
      relatedNodeIds: [],
      aliases,
      signalBySourceKind,
      memberNodeIds,
      memberCanonicalKeys: cluster.members.map((member) => member.node.canonicalKey),
      memberClaimIds: Array.from(new Set(memberClaimIds)).sort((left, right) =>
        left.localeCompare(right)
      ),
      memberStateIds: Array.from(new Set(memberStateIds)).sort((left, right) =>
        left.localeCompare(right)
      ),
      currentStateIds: Array.from(new Set(currentStateIds)),
      memberWorldlineIds: Array.from(new Set(memberWorldlineIds)),
      consolidationReasons: cluster.reasons,
      frameMemberships
    } satisfies ConsolidatedThoughtNode;
  });

  return {
    nodes: consolidatedNodes,
    consolidatedIdBySourceNodeId
  };
}

/**
 * Collapse original granular edges across consolidated cluster boundaries.
 *
 * Edges that end up inside one consolidated family disappear here because they
 * became internal provenance, not browseable graph structure.
 */
function buildConsolidatedEdges(
  edges: ThoughtEdge[],
  consolidatedIdBySourceNodeId: Map<string, string>
): ConsolidatedThoughtEdge[] {
  const aggregates = new Map<string, EdgeAggregate>();

  for (const edge of edges) {
    const from = consolidatedIdBySourceNodeId.get(edge.from);
    const to = consolidatedIdBySourceNodeId.get(edge.to);
    if (!from || !to || from === to) {
      continue;
    }

    const key = relationKey(from, to, edge.type);
    const existing = aggregates.get(key);
    if (existing) {
      existing.weight += edge.weight;
      existing.supportingSourceNodeIds.add(edge.from);
      existing.supportingSourceNodeIds.add(edge.to);
      existing.supportingEdgeIds.add(edge.id);
      existing.sourceRelationTypes.add(edge.type);
      continue;
    }

    aggregates.set(key, {
      from,
      to,
      type: edge.type,
      weight: edge.weight,
      supportingSourceNodeIds: new Set([edge.from, edge.to]),
      supportingEdgeIds: new Set([edge.id]),
      sourceRelationTypes: new Set([edge.type])
    });
  }

  return Array.from(aggregates.values())
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
}

/**
 * Build the second-stage consolidated graph over the current granular compiler output.
 *
 * This is intentionally deterministic and inspectable. It does not replace the
 * granular graph; it sits above it as the future wiki-facing representation.
 */
export function buildThoughtConsolidationArtifacts(
  artifacts: ThoughtCompilationArtifacts,
  sourceGraphPath: string
): ThoughtConsolidationArtifacts {
  const clusters = buildConsolidationClusters(artifacts.graph.nodes, artifacts.graph.edges);
  const { nodes, consolidatedIdBySourceNodeId } = buildConsolidatedNodes(
    clusters,
    artifacts.claims,
    artifacts.nodeStates,
    artifacts.worldlines
  );
  const edges = buildConsolidatedEdges(artifacts.graph.edges, consolidatedIdBySourceNodeId);

  // Rebuild related-node lists from the consolidated edge set so the browseable
  // graph view reflects only surviving inter-family relations.
  const relatedIdsByNodeId = new Map<string, Set<string>>();
  for (const edge of edges) {
    const left = relatedIdsByNodeId.get(edge.from) ?? new Set<string>();
    left.add(edge.to);
    relatedIdsByNodeId.set(edge.from, left);

    const right = relatedIdsByNodeId.get(edge.to) ?? new Set<string>();
    right.add(edge.from);
    relatedIdsByNodeId.set(edge.to, right);
  }

  for (const node of nodes) {
    node.relatedNodeIds = Array.from(relatedIdsByNodeId.get(node.id) ?? []).sort((left, right) =>
      left.localeCompare(right)
    );
  }

  const graph = sanitizeReciprocalRevisionEdges({
      generatedAt: new Date().toISOString(),
      sourceRunId: artifacts.graph.runId,
      sourceGraphPath,
      sourceNodeCount: artifacts.graph.nodeCount,
      sourceEdgeCount: artifacts.graph.edgeCount,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodes,
      edges
    } satisfies ConsolidatedThoughtGraph);

  return {
    graph
  };
}

/**
 * Untouched families should not drift cosmetically just because a later run
 * regenerated synthesis elsewhere. This is the first runtime use of the
 * affected-scope contract; neighborhood recompute can build on the same rule.
 */
function preserveUntouchedFamilyPhrasing(
  graph: ConsolidatedThoughtGraph,
  previousFamilyIndex: ThoughtConsolidationFamilyIndex | null,
  reusedFamilyIds: string[]
): ConsolidatedThoughtGraph {
  if (!previousFamilyIndex || reusedFamilyIds.length === 0) {
    return graph;
  }

  const previousByFamilyId = new Map(
    previousFamilyIndex.families.map((family) => [family.familyId, family])
  );
  const reused = new Set(reusedFamilyIds);
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    if (!reused.has(node.id)) {
      return node;
    }

    const previous = previousByFamilyId.get(node.id);
    if (
      !previous ||
      typeof previous.title !== "string" ||
      typeof previous.summary !== "string" ||
      (previous.title === node.title && previous.summary === node.summary)
    ) {
      return node;
    }

    changed = true;
    return {
      ...node,
      title: previous.title,
      summary: previous.summary
    };
  });

  return changed
    ? {
        ...graph,
        nodes
      }
    : graph;
}

function getConsolidatedGraphPath(paths: ProjectPaths): string {
  return path.join(paths.compiledDir, THOUGHT_CONSOLIDATION_DEFAULTS.compiledGraphFilename);
}

function loadPreviousConsolidatedGraph(paths: ProjectPaths): ConsolidatedThoughtGraph | null {
  const target = getConsolidatedGraphPath(paths);
  if (!existsSync(target)) {
    return null;
  }
  return JSON.parse(readFileSync(target, "utf8")) as ConsolidatedThoughtGraph;
}

function rebuildConsolidatedRelatedNodeIds(graph: ConsolidatedThoughtGraph): ConsolidatedThoughtGraph {
  const relatedIdsByNodeId = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const left = relatedIdsByNodeId.get(edge.from) ?? new Set<string>();
    left.add(edge.to);
    relatedIdsByNodeId.set(edge.from, left);

    const right = relatedIdsByNodeId.get(edge.to) ?? new Set<string>();
    right.add(edge.from);
    relatedIdsByNodeId.set(edge.to, right);
  }

  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      relatedNodeIds: Array.from(relatedIdsByNodeId.get(node.id) ?? []).sort((left, right) =>
        left.localeCompare(right)
      )
    }))
  };
}

/**
 * A revision relation is directional: the newer formulation revises the older
 * one. Model proposals can independently create both directions, so remove the
 * chronologically impossible reverse edge after family remapping.
 */
export function sanitizeReciprocalRevisionEdges(
  graph: ConsolidatedThoughtGraph
): ConsolidatedThoughtGraph {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeByKey = new Map(
    graph.edges.map((edge) => [relationKey(edge.from, edge.to, edge.type), edge])
  );
  const removedEdgeIds = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.type !== "revises" || removedEdgeIds.has(edge.id)) {
      continue;
    }
    const reverse = edgeByKey.get(relationKey(edge.to, edge.from, edge.type));
    if (!reverse || edge.id >= reverse.id) {
      continue;
    }

    const fromNode = nodeById.get(edge.from);
    const toNode = nodeById.get(edge.to);
    const lastSeenComparison =
      fromNode?.lastSeen && toNode?.lastSeen
        ? fromNode.lastSeen.localeCompare(toNode.lastSeen)
        : 0;
    const firstSeenComparison =
      fromNode?.firstSeen && toNode?.firstSeen
        ? fromNode.firstSeen.localeCompare(toNode.firstSeen)
        : 0;
    const chronologyComparison = lastSeenComparison || firstSeenComparison;

    if (chronologyComparison > 0) {
      removedEdgeIds.add(reverse.id);
    } else if (chronologyComparison < 0) {
      removedEdgeIds.add(edge.id);
    } else if (edge.weight !== reverse.weight) {
      removedEdgeIds.add(edge.weight > reverse.weight ? reverse.id : edge.id);
    } else {
      // Equal or unavailable chronology is still not a valid revision cycle.
      // Keep one stable direction rather than preserving nondeterminism.
      removedEdgeIds.add(reverse.id);
    }
  }

  if (removedEdgeIds.size === 0) {
    return graph;
  }
  const edges = graph.edges.filter((edge) => !removedEdgeIds.has(edge.id));
  return rebuildConsolidatedRelatedNodeIds({
    ...graph,
    edgeCount: edges.length,
    edges
  });
}

function buildCurrentNodeMetadataIndexes(artifacts: ThoughtCompilationArtifacts): {
  nodeById: Map<string, ThoughtNode>;
  claimsByNodeId: Map<string, ThoughtClaim[]>;
  statesByNodeId: Map<string, ThoughtNodeState[]>;
  worldlineByNodeId: Map<string, ThoughtWorldline>;
} {
  const nodeById = new Map(artifacts.graph.nodes.map((node) => [node.id, node]));
  const claimsByNodeId = new Map<string, ThoughtClaim[]>();
  const statesByNodeId = new Map<string, ThoughtNodeState[]>();
  const worldlineByNodeId = new Map<string, ThoughtWorldline>();

  for (const claim of artifacts.claims) {
    claimsByNodeId.set(claim.nodeId, [...(claimsByNodeId.get(claim.nodeId) ?? []), claim]);
  }
  for (const state of artifacts.nodeStates) {
    statesByNodeId.set(state.nodeId, [...(statesByNodeId.get(state.nodeId) ?? []), state]);
  }
  for (const worldline of artifacts.worldlines) {
    worldlineByNodeId.set(worldline.nodeId, worldline);
  }

  return { nodeById, claimsByNodeId, statesByNodeId, worldlineByNodeId };
}

function aggregateFrameMemberships(nodes: ThoughtNode[]): ThoughtNodeFrameMembership[] {
  return Array.from(
    nodes
      .flatMap((node) => node.frameMemberships ?? [])
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
}

/**
 * Reused family wording is intentionally preserved, but deterministic
 * provenance and state metadata must track the current granular graph.
 */
function refreshReusedFamilyDeterministicMetadata(
  node: ConsolidatedThoughtNode,
  indexes: ReturnType<typeof buildCurrentNodeMetadataIndexes>
): ConsolidatedThoughtNode {
  const memberNodes = node.memberNodeIds
    .map((memberNodeId) => indexes.nodeById.get(memberNodeId))
    .filter((member): member is ThoughtNode => Boolean(member));
  if (memberNodes.length !== node.memberNodeIds.length) {
    return node;
  }

  const sourceRefs = dedupeSourceRefs(memberNodes.flatMap((member) => member.sourceRefs));
  const signalBySourceKind = createSourceKindCounter();
  for (const member of memberNodes) {
    for (const [sourceKind, count] of Object.entries(member.signalBySourceKind) as Array<
      [SourceKind, number]
    >) {
      signalBySourceKind[sourceKind] += count;
    }
  }

  const firstSeen = memberNodes
    .map((member) => member.firstSeen)
    .reduce<string | null>((earliest, current) => {
      if (current === null) {
        return earliest;
      }
      if (earliest === null || compareTimes(current, earliest) < 0) {
        return current;
      }
      return earliest;
    }, null);
  const lastSeen = memberNodes
    .map((member) => member.lastSeen)
    .reduce<string | null>((latest, current) => {
      if (current === null) {
        return latest;
      }
      if (latest === null || compareTimes(current, latest) > 0) {
        return current;
      }
      return latest;
    }, null);

  return {
    ...node,
    nodeType: countWinners(memberNodes.map((member) => member.nodeType), node.nodeType),
    status: countWinners(memberNodes.map((member) => member.status), node.status),
    firstSeen,
    lastSeen,
    sourceRefs,
    aliases: Array.from(new Set(memberNodes.flatMap((member) => member.aliases))).sort((left, right) =>
      left.localeCompare(right)
    ),
    signalBySourceKind,
    memberCanonicalKeys: memberNodes.map((member) => member.canonicalKey),
    memberClaimIds: uniqueSorted(
      memberNodes.flatMap((member) =>
        indexes.claimsByNodeId.get(member.id)?.map((claim) => claim.id) ?? []
      )
    ),
    memberStateIds: uniqueSorted(
      memberNodes.flatMap((member) =>
        indexes.statesByNodeId.get(member.id)?.map((state) => state.id) ?? []
      )
    ),
    currentStateIds: uniqueSorted(
      memberNodes
        .map((member) => member.currentStateId)
        .filter((value): value is string => value !== null)
    ),
    memberWorldlineIds: uniqueSorted(
      memberNodes
        .map((member) => indexes.worldlineByNodeId.get(member.id)?.id)
        .filter((value): value is string => Boolean(value))
    ),
    frameMemberships: aggregateFrameMemberships(memberNodes)
  };
}

function remapConsolidatedEdges(
  edges: ConsolidatedThoughtEdge[],
  idMap: Map<string, string>
): ConsolidatedThoughtEdge[] {
  const aggregates = new Map<string, EdgeAggregate>();
  const remap = (id: string) => idMap.get(id) ?? id;

  for (const edge of edges) {
    const from = remap(edge.from);
    const to = remap(edge.to);
    if (from === to) {
      continue;
    }

    const key = relationKey(from, to, edge.type);
    const existing = aggregates.get(key);
    if (existing) {
      existing.weight += edge.weight;
      for (const nodeId of edge.supportingSourceNodeIds) {
        existing.supportingSourceNodeIds.add(nodeId);
      }
      for (const edgeId of edge.supportingEdgeIds) {
        existing.supportingEdgeIds.add(edgeId);
      }
      for (const relationType of edge.sourceRelationTypes) {
        existing.sourceRelationTypes.add(relationType);
      }
      continue;
    }

    aggregates.set(key, {
      from,
      to,
      type: edge.type,
      weight: edge.weight,
      supportingSourceNodeIds: new Set(edge.supportingSourceNodeIds),
      supportingEdgeIds: new Set(edge.supportingEdgeIds),
      sourceRelationTypes: new Set(edge.sourceRelationTypes)
    });
  }

  return Array.from(aggregates.values())
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
}

function preserveIncrementalLocalFamilyIds(options: {
  graph: ConsolidatedThoughtGraph;
  previousGraph: ConsolidatedThoughtGraph;
  previousNodeFamilyIndex: ThoughtConsolidationNodeFamilyIndex;
}): ConsolidatedThoughtGraph {
  const previousFamilyIdByLocalNodeId = new Map<string, string>();
  const localNodeIdsByPreviousFamilyId = new Map<string, string[]>();
  const localNodeById = new Map(options.graph.nodes.map((node) => [node.id, node]));
  const localNodeIds = new Set(options.graph.nodes.map((node) => node.id));
  const previousNodeById = new Map(options.previousGraph.nodes.map((node) => [node.id, node]));

  for (const node of options.graph.nodes) {
    const previousFamilyIds = new Set(
      node.memberNodeIds
        .map((memberNodeId) => options.previousNodeFamilyIndex.byNodeId[memberNodeId])
        .filter((familyId): familyId is string => Boolean(familyId))
    );
    if (previousFamilyIds.size !== 1) {
      continue;
    }

    const previousFamilyId = Array.from(previousFamilyIds)[0]!;
    previousFamilyIdByLocalNodeId.set(node.id, previousFamilyId);
    localNodeIdsByPreviousFamilyId.set(previousFamilyId, [
      ...(localNodeIdsByPreviousFamilyId.get(previousFamilyId) ?? []),
      node.id
    ]);
  }

  const splitOnlyPreviousFamilyIds = new Set<string>();
  for (const [previousFamilyId, localNodeIds] of localNodeIdsByPreviousFamilyId.entries()) {
    if (localNodeIds.length <= 1) {
      continue;
    }

    const previousNode = previousNodeById.get(previousFamilyId);
    if (!previousNode) {
      continue;
    }

    const localMemberNodeIds = new Set(
      localNodeIds.flatMap((localNodeId) => localNodeById.get(localNodeId)?.memberNodeIds ?? [])
    );
    const previousMemberNodeIds = new Set(previousNode.memberNodeIds);
    const sameMembers =
      localMemberNodeIds.size === previousMemberNodeIds.size &&
      Array.from(localMemberNodeIds).every((memberNodeId) =>
        previousMemberNodeIds.has(memberNodeId)
      );
    if (sameMembers) {
      splitOnlyPreviousFamilyIds.add(previousFamilyId);
    }
  }

  const idMap = new Map<string, string>();
  for (const previousFamilyId of splitOnlyPreviousFamilyIds) {
    for (const localNodeId of localNodeIdsByPreviousFamilyId.get(previousFamilyId) ?? []) {
      idMap.set(localNodeId, previousFamilyId);
    }
  }
  for (const [localNodeId, previousFamilyId] of previousFamilyIdByLocalNodeId.entries()) {
    if (splitOnlyPreviousFamilyIds.has(previousFamilyId)) {
      continue;
    }
    const claimants = localNodeIdsByPreviousFamilyId.get(previousFamilyId) ?? [];
    const targetAlreadyExistsElsewhere =
      localNodeIds.has(previousFamilyId) && previousFamilyId !== localNodeId;
    if (claimants.length === 1 && !targetAlreadyExistsElsewhere) {
      idMap.set(localNodeId, previousFamilyId);
    }
  }

  if (idMap.size === 0) {
    return options.graph;
  }

  const remap = (id: string) => idMap.get(id) ?? id;
  const nodes = [
    ...options.graph.nodes
      .filter(
        (node) =>
          !splitOnlyPreviousFamilyIds.has(previousFamilyIdByLocalNodeId.get(node.id) ?? "")
      )
      .map((node) => ({
        ...node,
        id: remap(node.id),
        relatedNodeIds: Array.from(
          new Set(
            node.relatedNodeIds
              .map((relatedId) => remap(relatedId))
              .filter((id) => id !== remap(node.id))
          )
        ).sort((left, right) => left.localeCompare(right))
      })),
    ...Array.from(splitOnlyPreviousFamilyIds)
      .map((familyId) => previousNodeById.get(familyId))
      .filter((node): node is ConsolidatedThoughtNode => Boolean(node))
  ].sort((left, right) => left.id.localeCompare(right.id));
  const edges = remapConsolidatedEdges(options.graph.edges, idMap);

  return rebuildConsolidatedRelatedNodeIds({
    ...options.graph,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges
  });
}

function filterThoughtCompilationArtifacts(
  artifacts: ThoughtCompilationArtifacts,
  sourceNodeIds: Set<string>
): ThoughtCompilationArtifacts {
  return {
    ...artifacts,
    graph: {
      ...artifacts.graph,
      nodeCount: sourceNodeIds.size,
      edgeCount: artifacts.graph.edges.filter(
        (edge) => sourceNodeIds.has(edge.from) && sourceNodeIds.has(edge.to)
      ).length,
      nodes: artifacts.graph.nodes.filter((node) => sourceNodeIds.has(node.id)),
      edges: artifacts.graph.edges.filter(
        (edge) => sourceNodeIds.has(edge.from) && sourceNodeIds.has(edge.to)
      )
    },
    claims: artifacts.claims.filter((claim) => sourceNodeIds.has(claim.nodeId)),
    nodeStates: artifacts.nodeStates.filter((state) => sourceNodeIds.has(state.nodeId)),
    worldlines: artifacts.worldlines.filter((worldline) => sourceNodeIds.has(worldline.nodeId)),
    identityBlocks: artifacts.identityBlocks.filter((block) =>
      block.claimIds.some((claimId) =>
        artifacts.claims.some((claim) => claim.id === claimId && sourceNodeIds.has(claim.nodeId))
      )
    )
  };
}

function collectIncrementalAffectedScope(options: {
  artifacts: ThoughtCompilationArtifacts;
  previousFamilyIndex: ThoughtConsolidationFamilyIndex;
  previousNodeFamilyIndex: ThoughtConsolidationNodeFamilyIndex;
  previousDependencyIndex: ThoughtConsolidationDependencyIndex;
  segmentIndex: ReturnType<typeof loadSegmentIndexArtifact>;
}): {
  recomputedFamilyIds: Set<string>;
  scopedSourceNodeIds: Set<string>;
} {
  const currentNodeIds = new Set(options.artifacts.graph.nodes.map((node) => node.id));
  const currentNodeById = new Map(options.artifacts.graph.nodes.map((node) => [node.id, node]));
  const recomputedFamilyIds = new Set<string>();
  const scopedSourceNodeIds = new Set<string>();

  for (const family of options.previousFamilyIndex.families) {
    const hasRemovedMember = family.memberNodeIds.some((nodeId) => !currentNodeIds.has(nodeId));
    const hasChangedSegment = family.sourceSegmentIds.some((segmentId) => {
      const previousHash = family.sourceSegmentSemanticInputHashes[segmentId] ?? "";
      const currentHash = options.segmentIndex?.segments[segmentId]?.semanticInputHash ?? "";
      return previousHash !== currentHash;
    });
    if (hasRemovedMember || hasChangedSegment) {
      recomputedFamilyIds.add(family.familyId);
    }
  }

  for (const node of options.artifacts.graph.nodes) {
    const previousFamilyId = options.previousNodeFamilyIndex.byNodeId[node.id];
    if (!previousFamilyId) {
      scopedSourceNodeIds.add(node.id);
      for (const edge of options.artifacts.graph.edges) {
        if (edge.from !== node.id && edge.to !== node.id) {
          continue;
        }
        const neighborNodeId = edge.from === node.id ? edge.to : edge.from;
        scopedSourceNodeIds.add(neighborNodeId);
        const neighborFamilyId = options.previousNodeFamilyIndex.byNodeId[neighborNodeId];
        if (neighborFamilyId) {
          recomputedFamilyIds.add(neighborFamilyId);
        }
      }
    }
  }

  for (const familyId of Array.from(recomputedFamilyIds)) {
    const deps = options.previousDependencyIndex.byFamilyId[familyId];
    for (const neighborFamilyId of deps?.neighborFamilyIds ?? []) {
      const neighbor = options.previousFamilyIndex.families.find(
        (family) => family.familyId === neighborFamilyId
      );
      if ((neighbor?.memberNodeIds.length ?? 0) > 1) {
        recomputedFamilyIds.add(neighborFamilyId);
      }
    }
  }

  for (const family of options.previousFamilyIndex.families) {
    if (!recomputedFamilyIds.has(family.familyId)) {
      continue;
    }
    for (const nodeId of family.memberNodeIds) {
      if (currentNodeById.has(nodeId)) {
        scopedSourceNodeIds.add(nodeId);
      }
    }
  }

  return {
    recomputedFamilyIds,
    scopedSourceNodeIds
  };
}

function buildIncrementalConsolidationArtifacts(options: {
  paths: ProjectPaths;
  artifacts: ThoughtCompilationArtifacts;
  sourceGraphPath: string;
  previousGraph: ConsolidatedThoughtGraph;
  previousFamilyIndex: ThoughtConsolidationFamilyIndex;
  previousNodeFamilyIndex: ThoughtConsolidationNodeFamilyIndex;
  previousDependencyIndex: ThoughtConsolidationDependencyIndex;
  segmentIndex: ReturnType<typeof loadSegmentIndexArtifact>;
  progress?: ThrottledProgressReporter;
}): {
  consolidated: ThoughtConsolidationArtifacts;
  affectedScope: ThoughtConsolidationAffectedScope;
} | null {
  const collected = collectIncrementalAffectedScope({
    artifacts: options.artifacts,
    previousFamilyIndex: options.previousFamilyIndex,
    previousNodeFamilyIndex: options.previousNodeFamilyIndex,
    previousDependencyIndex: options.previousDependencyIndex,
    segmentIndex: options.segmentIndex
  });
  options.progress?.phase(
    "consolidate",
    `incremental local scope: ${collected.scopedSourceNodeIds.size} granular nodes / ${collected.recomputedFamilyIds.size} previous families`
  );

  if (collected.scopedSourceNodeIds.size === 0 && collected.recomputedFamilyIds.size === 0) {
    const currentMetadataIndexes = buildCurrentNodeMetadataIndexes(options.artifacts);
    const nodes = options.previousGraph.nodes.map((node) =>
      refreshReusedFamilyDeterministicMetadata(node, currentMetadataIndexes)
    );
    const graph = rebuildConsolidatedRelatedNodeIds({
      ...options.previousGraph,
      generatedAt: new Date().toISOString(),
      sourceRunId: options.artifacts.graph.runId,
      sourceGraphPath: options.sourceGraphPath,
      sourceNodeCount: options.artifacts.graph.nodeCount,
      sourceEdgeCount: options.artifacts.graph.edgeCount,
      nodeCount: nodes.length,
      edgeCount: options.previousGraph.edges.length,
      nodes
    });
    const stateArtifacts = buildConsolidationStateArtifacts({
      graph,
      segmentIndex: options.segmentIndex
    });
    const affectedScope = buildConsolidationAffectedScope({
      currentFamilyIndex: stateArtifacts.familyIndex,
      currentDependencyIndex: stateArtifacts.dependencyIndex,
      previousFamilyIndex: options.previousFamilyIndex,
      forceNewRun: false,
      localRecomputeFamilyIds: []
    });
    return {
      consolidated: { graph },
      affectedScope
    };
  }

  const scopedArtifacts = filterThoughtCompilationArtifacts(
    options.artifacts,
    collected.scopedSourceNodeIds
  );
  if (scopedArtifacts.graph.nodes.length === 0) {
    options.progress?.phase(
      "consolidate",
      "incremental deterministic fallback: local scope had no compiled nodes"
    );
    return null;
  }

  const rawLocal = buildThoughtConsolidationArtifacts(scopedArtifacts, options.sourceGraphPath);
  const local = {
    ...rawLocal,
    graph: preserveIncrementalLocalFamilyIds({
      graph: rawLocal.graph,
      previousGraph: options.previousGraph,
      previousNodeFamilyIndex: options.previousNodeFamilyIndex
    })
  };
  const localFamilyIds = new Set(local.graph.nodes.map((node) => node.id));
  const currentMetadataIndexes = buildCurrentNodeMetadataIndexes(options.artifacts);
  const untouchedPreviousNodes = options.previousGraph.nodes
    .filter(
    (node) => !collected.recomputedFamilyIds.has(node.id) && !localFamilyIds.has(node.id)
    )
    .map((node) => refreshReusedFamilyDeterministicMetadata(node, currentMetadataIndexes));
  const untouchedFamilyIds = new Set(untouchedPreviousNodes.map((node) => node.id));

  const sourceNodeIdByFamilyId = new Map<string, string>();
  for (const node of local.graph.nodes) {
    for (const memberNodeId of node.memberNodeIds) {
      sourceNodeIdByFamilyId.set(memberNodeId, node.id);
    }
  }
  for (const node of untouchedPreviousNodes) {
    for (const memberNodeId of node.memberNodeIds) {
      sourceNodeIdByFamilyId.set(memberNodeId, node.id);
    }
  }

  const rebuiltEdges = buildConsolidatedEdges(
    options.artifacts.graph.edges,
    sourceNodeIdByFamilyId
  );
  const previousUntouchedEdges = options.previousGraph.edges.filter(
    (edge) => untouchedFamilyIds.has(edge.from) && untouchedFamilyIds.has(edge.to)
  );
  const previousUntouchedEdgeIds = new Set(previousUntouchedEdges.map((edge) => edge.id));
  const changedSurfaceEdges = rebuiltEdges.filter((edge) => !previousUntouchedEdgeIds.has(edge.id));
  const edges = [...previousUntouchedEdges, ...changedSurfaceEdges].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const nodes = [...untouchedPreviousNodes, ...local.graph.nodes].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const graph = rebuildConsolidatedRelatedNodeIds({
    generatedAt: new Date().toISOString(),
    sourceRunId: options.artifacts.graph.runId,
    sourceGraphPath: options.sourceGraphPath,
    sourceNodeCount: options.artifacts.graph.nodeCount,
    sourceEdgeCount: options.artifacts.graph.edgeCount,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges
  });
  const stateArtifacts = buildConsolidationStateArtifacts({
    graph,
    segmentIndex: options.segmentIndex
  });
  const localRecomputeFamilyIds = uniqueSorted([
    ...collected.recomputedFamilyIds,
    ...localFamilyIds
  ]);
  const affectedScope = buildConsolidationAffectedScope({
    currentFamilyIndex: stateArtifacts.familyIndex,
    currentDependencyIndex: stateArtifacts.dependencyIndex,
    previousFamilyIndex: options.previousFamilyIndex,
    forceNewRun: false,
    localRecomputeFamilyIds
  });

  if (affectedScope.fallbackMode !== "none") {
    options.progress?.phase(
      "consolidate",
      `incremental deterministic fallback: ${affectedScope.fallbackReasons.join(" ")}`
    );
    return null;
  }

  return {
    consolidated: { graph },
    affectedScope
  };
}

/**
 * Run the consolidation pass over the current compiled artifacts and persist the result.
 */
export function consolidateThoughtGraph(
  paths: ProjectPaths,
  options?: {
    client?: CodexCliClient;
    useLlmReview?: boolean;
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
    forceNewRun?: boolean;
    progress?: ProgressWriter;
  }
): ThoughtConsolidationSummary {
  const progress = new ThrottledProgressReporter(options?.progress);
  const sourceGraphPath = path.join(
    paths.compiledDir,
    THOUGHT_COMPILER_DEFAULTS.compiledGraphFilename
  );
  progress.phase("consolidate", "loading granular compiler artifacts");
  const artifacts = loadThoughtCompilationArtifacts(paths);
  progress.phase(
    "consolidate",
    `loaded ${artifacts.graph.nodeCount} granular nodes / ${artifacts.graph.edgeCount} granular edges`
  );
  const previousFamilyIndex = loadConsolidationFamilyIndex(paths);
  const previousNodeFamilyIndex = loadConsolidationNodeFamilyIndex(paths);
  const previousDependencyIndex = loadConsolidationDependencyIndex(paths);
  const previousGraph = loadPreviousConsolidatedGraph(paths);
  const segmentIndex = loadSegmentIndexArtifact(paths);
  const incrementalDeterministic =
    !options?.forceNewRun &&
    previousFamilyIndex &&
    previousNodeFamilyIndex &&
    previousDependencyIndex &&
    previousGraph
      ? buildIncrementalConsolidationArtifacts({
          paths,
          artifacts,
          sourceGraphPath,
          previousGraph,
          previousFamilyIndex,
          previousNodeFamilyIndex,
          previousDependencyIndex,
          segmentIndex,
          progress
        })
      : null;
  if (incrementalDeterministic) {
    progress.phase(
      "consolidate",
      `incremental deterministic result: ${incrementalDeterministic.consolidated.graph.nodeCount} nodes / ${incrementalDeterministic.consolidated.graph.edgeCount} edges`
    );
  }
  if (!incrementalDeterministic) {
    progress.phase("consolidate", "running deterministic consolidation");
  }
  const deterministicConsolidation =
    incrementalDeterministic?.consolidated ??
    buildThoughtConsolidationArtifacts(artifacts, sourceGraphPath);
  if (!incrementalDeterministic) {
    progress.phase(
      "consolidate",
      `deterministic result: ${deterministicConsolidation.graph.nodeCount} nodes / ${deterministicConsolidation.graph.edgeCount} edges`
    );
  }
  const deterministicStateArtifacts = incrementalDeterministic
    ? null
    : buildConsolidationStateArtifacts({
        graph: deterministicConsolidation.graph,
        reviewCandidates: deterministicConsolidation.reviewCandidates,
        segmentIndex
      });
  const preliminaryAffectedScope = incrementalDeterministic?.affectedScope ??
    buildConsolidationAffectedScope({
      currentFamilyIndex: deterministicStateArtifacts!.familyIndex,
      currentDependencyIndex: deterministicStateArtifacts!.dependencyIndex,
      previousFamilyIndex,
      forceNewRun: Boolean(options?.forceNewRun)
    });
  const existingConsolidationCheckpoint = options?.useLlmReview && options.client
    ? loadThoughtConsolidationCheckpoint(paths)
    : null;
  const resolvedModel = options?.model ?? SECOND_BRAIN_DEFAULTS.codex.defaultModel;
  const resolvedReasoningEffort =
    options?.reasoningEffort ?? SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort;
  const requiresLegacyFixedPointVerification = Boolean(
    existingConsolidationCheckpoint &&
    existingConsolidationCheckpoint.fixedPointReached !== true &&
    existingConsolidationCheckpoint.sourceRunId === artifacts.graph.runId &&
    existingConsolidationCheckpoint.model === resolvedModel &&
    existingConsolidationCheckpoint.reasoningEffort === resolvedReasoningEffort
  );
  if (requiresLegacyFixedPointVerification) {
    progress.phase(
      "consolidate",
      "legacy checkpoint requires one global fixed-point verification"
    );
  }
  const consolidated =
    options?.useLlmReview && options.client
      ? refineConsolidatedThoughtGraph({
          paths,
          artifacts,
          consolidated: deterministicConsolidation,
          client: options.client,
          // A pre-fixed-point checkpoint must keep verifying the whole saved
          // synthesis surface even after a failed batch. Falling back to an
          // empty incremental scope would abandon the resumable global run and
          // could certify it without presenting its remaining candidates.
          affectedScope: requiresLegacyFixedPointVerification
            ? undefined
            : preliminaryAffectedScope,
          previousFamilyIndex,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          forceNewRun: options.forceNewRun,
          progress: options.progress
        })
      : deterministicConsolidation;
  consolidated.graph = sanitizeReciprocalRevisionEdges(consolidated.graph);
  progress.phase(
    "consolidate",
    `final result: ${consolidated.graph.nodeCount} nodes / ${consolidated.graph.edgeCount} edges`
  );
  progress.phase("consolidate", "writing consolidation state indexes");
  let stateArtifacts = buildConsolidationStateArtifacts({
    graph: consolidated.graph,
    reviewCandidates: consolidated.reviewCandidates,
    segmentIndex
  });
  const affectedScope = buildConsolidationAffectedScope({
    currentFamilyIndex: stateArtifacts.familyIndex,
    currentDependencyIndex: stateArtifacts.dependencyIndex,
    previousFamilyIndex,
    forceNewRun: Boolean(options?.forceNewRun),
    localRecomputeFamilyIds: preliminaryAffectedScope.localRecomputeFamilyIds,
    allowedRemovedFamilyIds: [
      ...preliminaryAffectedScope.reviewScopeFamilyIds,
      ...collectReviewMergedFamilyIds({
        reviewCandidates: consolidated.reviewCandidates,
        reviewDecisions: consolidated.reviewDecisions
      })
    ]
  });
  consolidated.graph = preserveUntouchedFamilyPhrasing(
    consolidated.graph,
    previousFamilyIndex,
    affectedScope.reusedFamilyIds
  );
  stateArtifacts = buildConsolidationStateArtifacts({
    graph: consolidated.graph,
    reviewCandidates: consolidated.reviewCandidates,
    segmentIndex
  });
  writeConsolidationStateArtifacts(paths, {
    ...stateArtifacts,
    affectedScope
  });
  consolidated.familyIndex = stateArtifacts.familyIndex;
  consolidated.nodeFamilyIndex = stateArtifacts.nodeFamilyIndex;
  consolidated.dependencyIndex = stateArtifacts.dependencyIndex;
  consolidated.affectedScope = affectedScope;
  if (consolidated.diagnostics) {
    const broaderPathUsed = affectedScope.broaderPathUsed;
    const recommendationReasons = broaderPathUsed
      ? [
          ...consolidated.diagnostics.recommendation.reasons.filter(
            (reason) => reason !== "Incremental reuse is within configured thresholds."
          ),
          ...affectedScope.fallbackReasons
        ]
      : consolidated.diagnostics.recommendation.reasons;
    consolidated.diagnostics = {
      ...consolidated.diagnostics,
      recommendation: {
        ...consolidated.diagnostics.recommendation,
        broaderPathUsed,
        broaderConsolidationRerunRecommended:
          consolidated.diagnostics.recommendation.broaderConsolidationRerunRecommended,
        severity: consolidated.diagnostics.recommendation.severity,
        reasons: recommendationReasons.length > 0
          ? recommendationReasons
          : consolidated.diagnostics.recommendation.reasons
      },
      affectedScope: {
        mode: affectedScope.mode,
        localRecomputeFamilyCount: affectedScope.stats.localRecomputeFamilyCount,
        localRecomputeFamilyShare: affectedScope.stats.localRecomputeFamilyShare,
        affectedFamilyCount: affectedScope.stats.affectedFamilyCount,
        reusedFamilyCount: affectedScope.stats.reusedFamilyCount,
        affectedFamilyShare: affectedScope.stats.affectedFamilyShare,
        reviewScopeFamilyCount: affectedScope.stats.reviewScopeFamilyCount,
        synthesisScopeFamilyCount: affectedScope.stats.synthesisScopeFamilyCount,
        dependencyExpandedClosureFamilyCount:
          affectedScope.stats.dependencyExpandedClosureFamilyCount,
        dependencyExpandedClosureShare: affectedScope.stats.dependencyExpandedClosureShare,
        affectedEdgeCount: affectedScope.stats.affectedEdgeCount,
        invalidatedReviewCaseCount: affectedScope.stats.invalidatedReviewCaseCount,
        invalidatedSynthesisCount: affectedScope.stats.invalidatedSynthesisCount,
        broaderPathUsed: affectedScope.broaderPathUsed,
        fallbackMode: affectedScope.fallbackMode,
        fallbackReasons: affectedScope.fallbackReasons
      }
    };
    writeConsolidationDiagnostics(paths, consolidated.diagnostics);
  }

  const nodesPath = path.join(
    paths.compiledDir,
    THOUGHT_CONSOLIDATION_DEFAULTS.compiledNodesFilename
  );
  const edgesPath = path.join(
    paths.compiledDir,
    THOUGHT_CONSOLIDATION_DEFAULTS.compiledEdgesFilename
  );
  const graphPath = path.join(
    paths.compiledDir,
    THOUGHT_CONSOLIDATION_DEFAULTS.compiledGraphFilename
  );
  const reviewCandidatesPath = path.join(
    paths.compiledDir,
    THOUGHT_CONSOLIDATION_DEFAULTS.reviewCandidatesFilename
  );
  const reviewDecisionsPath = path.join(
    paths.compiledDir,
    THOUGHT_CONSOLIDATION_DEFAULTS.reviewDecisionsFilename
  );
  const synthesisPath = path.join(
    paths.compiledDir,
    THOUGHT_CONSOLIDATION_DEFAULTS.synthesisFilename
  );
  const diagnosticsPath = path.join(paths.stateAuditsDir, "consolidation_diagnostics.json");
  const familyIndexPath = getConsolidationFamilyIndexPath(paths);
  const nodeFamilyIndexPath = getConsolidationNodeFamilyIndexPath(paths);
  const dependencyIndexPath = getConsolidationDependencyIndexPath(paths);
  const affectedScopePath = getConsolidationAffectedScopePath(paths);

  writeFileSync(nodesPath, `${JSON.stringify(consolidated.graph.nodes, null, 2)}\n`, "utf8");
  writeFileSync(edgesPath, `${JSON.stringify(consolidated.graph.edges, null, 2)}\n`, "utf8");
  writeFileSync(graphPath, `${JSON.stringify(consolidated.graph, null, 2)}\n`, "utf8");
  if (consolidated.reviewCandidates) {
    writeFileSync(
      reviewCandidatesPath,
      `${JSON.stringify(consolidated.reviewCandidates, null, 2)}\n`,
      "utf8"
    );
  }
  if (consolidated.reviewDecisions) {
    writeFileSync(
      reviewDecisionsPath,
      `${JSON.stringify(consolidated.reviewDecisions, null, 2)}\n`,
      "utf8"
    );
  }
  if (consolidated.synthesis) {
    writeFileSync(synthesisPath, `${JSON.stringify(consolidated.synthesis, null, 2)}\n`, "utf8");
  }

  const consolidationCheckpoint =
    options?.useLlmReview && options.client ? loadThoughtConsolidationCheckpoint(paths) : null;
  const consolidationRunPaths = consolidationCheckpoint
    ? getThoughtConsolidationRunPaths(paths, consolidationCheckpoint.runId)
    : null;

  return {
    runId: consolidationCheckpoint?.runId,
    status: consolidationCheckpoint?.status,
    checkpointPath: consolidationRunPaths?.checkpointPath,
    runStatePath: consolidationRunPaths?.runStatePath,
    sourceNodeCount: artifacts.graph.nodeCount,
    sourceEdgeCount: artifacts.graph.edgeCount,
    consolidatedNodeCount: consolidated.graph.nodeCount,
    consolidatedEdgeCount: consolidated.graph.edgeCount,
    nodesPath,
    edgesPath,
    graphPath,
    reviewCandidatesPath: consolidated.reviewCandidates ? reviewCandidatesPath : undefined,
    reviewDecisionsPath: consolidated.reviewDecisions ? reviewDecisionsPath : undefined,
    synthesisPath: consolidated.synthesis ? synthesisPath : undefined,
    incremental: consolidated.incremental,
    diagnosticsPath: consolidated.diagnostics ? diagnosticsPath : undefined,
    familyIndexPath,
    nodeFamilyIndexPath,
    dependencyIndexPath,
    affectedScopePath
  };
}
