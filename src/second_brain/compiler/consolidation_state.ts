import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import type { ProjectPaths } from "../system/paths.js";
import type { SegmentIndexArtifact } from "./semantic_cache.js";
import type {
  ConsolidatedThoughtGraph,
  ConsolidationReviewCandidate,
  ThoughtConsolidationAffectedScope,
  ThoughtConsolidationDependencyIndex,
  ThoughtConsolidationFamilyDependencies,
  ThoughtConsolidationFamilyIndex,
  ThoughtConsolidationFamilyRecord,
  ThoughtConsolidationNodeFamilyIndex
} from "./types.js";

const CONSOLIDATION_STATE_VERSION = 1;
const THOUGHT_CONSOLIDATION_DEFAULTS = SECOND_BRAIN_DEFAULTS.thoughtConsolidation;

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

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function getSourceSegmentId(documentId: string, locator: string): string {
  return `${documentId}:${locator}`;
}

function getConsolidationStateDir(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "consolidation");
}

export function getConsolidationFamilyIndexPath(paths: ProjectPaths): string {
  return path.join(getConsolidationStateDir(paths), "family_index.json");
}

export function getConsolidationNodeFamilyIndexPath(paths: ProjectPaths): string {
  return path.join(getConsolidationStateDir(paths), "node_family_index.json");
}

export function getConsolidationDependencyIndexPath(paths: ProjectPaths): string {
  return path.join(getConsolidationStateDir(paths), "dependency_index.json");
}

export function getConsolidationAffectedScopePath(paths: ProjectPaths): string {
  return path.join(getConsolidationStateDir(paths), "affected_scope.json");
}

export function loadConsolidationFamilyIndex(
  paths: ProjectPaths
): ThoughtConsolidationFamilyIndex | null {
  const target = getConsolidationFamilyIndexPath(paths);
  if (!existsSync(target)) {
    return null;
  }
  return JSON.parse(readFileSync(target, "utf8")) as ThoughtConsolidationFamilyIndex;
}

export function loadConsolidationNodeFamilyIndex(
  paths: ProjectPaths
): ThoughtConsolidationNodeFamilyIndex | null {
  const target = getConsolidationNodeFamilyIndexPath(paths);
  if (!existsSync(target)) {
    return null;
  }
  return JSON.parse(readFileSync(target, "utf8")) as ThoughtConsolidationNodeFamilyIndex;
}

export function loadConsolidationDependencyIndex(
  paths: ProjectPaths
): ThoughtConsolidationDependencyIndex | null {
  const target = getConsolidationDependencyIndexPath(paths);
  if (!existsSync(target)) {
    return null;
  }
  return JSON.parse(readFileSync(target, "utf8")) as ThoughtConsolidationDependencyIndex;
}

function buildEmptyFamilyDependencies(): ThoughtConsolidationFamilyDependencies {
  return {
    incomingFamilyIds: [],
    outgoingFamilyIds: [],
    neighborFamilyIds: [],
    incomingEdgeIds: [],
    outgoingEdgeIds: [],
    supportingSourceNodeIds: [],
    supportingEdgeIds: [],
    reviewCaseIds: []
  };
}

function buildDependencies(
  graph: ConsolidatedThoughtGraph,
  reviewCandidates: ConsolidationReviewCandidate[] | undefined
): ThoughtConsolidationDependencyIndex {
  const byFamilyId = Object.fromEntries(
    graph.nodes.map((node) => [node.id, buildEmptyFamilyDependencies()])
  ) as Record<string, ThoughtConsolidationFamilyDependencies>;

  for (const edge of graph.edges) {
    const from = byFamilyId[edge.from] ?? buildEmptyFamilyDependencies();
    const to = byFamilyId[edge.to] ?? buildEmptyFamilyDependencies();

    from.outgoingFamilyIds = uniqueSorted([...from.outgoingFamilyIds, edge.to]);
    from.neighborFamilyIds = uniqueSorted([...from.neighborFamilyIds, edge.to]);
    from.outgoingEdgeIds = uniqueSorted([...from.outgoingEdgeIds, edge.id]);
    from.supportingSourceNodeIds = uniqueSorted([
      ...from.supportingSourceNodeIds,
      ...edge.supportingSourceNodeIds
    ]);
    from.supportingEdgeIds = uniqueSorted([...from.supportingEdgeIds, ...edge.supportingEdgeIds]);

    to.incomingFamilyIds = uniqueSorted([...to.incomingFamilyIds, edge.from]);
    to.neighborFamilyIds = uniqueSorted([...to.neighborFamilyIds, edge.from]);
    to.incomingEdgeIds = uniqueSorted([...to.incomingEdgeIds, edge.id]);
    to.supportingSourceNodeIds = uniqueSorted([
      ...to.supportingSourceNodeIds,
      ...edge.supportingSourceNodeIds
    ]);
    to.supportingEdgeIds = uniqueSorted([...to.supportingEdgeIds, ...edge.supportingEdgeIds]);

    byFamilyId[edge.from] = from;
    byFamilyId[edge.to] = to;
  }

  const reviewCasesByFamilyId: Record<string, string[]> = {};
  for (const candidate of reviewCandidates ?? []) {
    for (const familyId of [candidate.leftNodeId, candidate.rightNodeId]) {
      const deps = byFamilyId[familyId] ?? buildEmptyFamilyDependencies();
      deps.reviewCaseIds = uniqueSorted([...deps.reviewCaseIds, candidate.caseId]);
      byFamilyId[familyId] = deps;
      reviewCasesByFamilyId[familyId] = uniqueSorted([
        ...(reviewCasesByFamilyId[familyId] ?? []),
        candidate.caseId
      ]);
    }
  }

  return {
    version: CONSOLIDATION_STATE_VERSION,
    generatedAt: graph.generatedAt,
    sourceRunId: graph.sourceRunId,
    familyCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    byFamilyId,
    reviewCasesByFamilyId
  };
}

function buildFamilyRecord(options: {
  graph: ConsolidatedThoughtGraph;
  node: ConsolidatedThoughtGraph["nodes"][number];
  dependencies: ThoughtConsolidationFamilyDependencies;
  segmentIndex: SegmentIndexArtifact | null;
}): ThoughtConsolidationFamilyRecord {
  const sourceSegmentIds = uniqueSorted(
    options.node.sourceRefs.map((ref) => getSourceSegmentId(ref.documentId, ref.locator))
  );
  const sourceSegmentSemanticInputHashes = Object.fromEntries(
    sourceSegmentIds.map((segmentId) => [
      segmentId,
      options.segmentIndex?.segments[segmentId]?.semanticInputHash ?? ""
    ])
  );
  const representativeInput = {
    canonicalKey: options.node.canonicalKey,
    nodeType: options.node.nodeType,
    status: options.node.status,
    firstSeen: options.node.firstSeen,
    lastSeen: options.node.lastSeen,
    memberNodeIds: options.node.memberNodeIds,
    memberCanonicalKeys: options.node.memberCanonicalKeys
  };
  const synthesisInput = {
    familyId: options.node.id,
    canonicalKey: options.node.canonicalKey,
    nodeType: options.node.nodeType,
    status: options.node.status,
    memberCanonicalKeys: options.node.memberCanonicalKeys,
    sourceSegmentIds,
    sourceSegmentSemanticInputHashes
  };
  const familyInput = {
    ...representativeInput,
    sourceSegmentIds,
    sourceSegmentSemanticInputHashes,
    consolidationReasons: options.node.consolidationReasons,
    incomingFamilyIds: options.dependencies.incomingFamilyIds,
    outgoingFamilyIds: options.dependencies.outgoingFamilyIds,
    neighborFamilyIds: options.dependencies.neighborFamilyIds
  };

  return {
    familyId: options.node.id,
    canonicalKey: options.node.canonicalKey,
    title: options.node.title,
    summary: options.node.summary,
    nodeType: options.node.nodeType,
    status: options.node.status,
    memberNodeIds: options.node.memberNodeIds,
    memberCanonicalKeys: options.node.memberCanonicalKeys,
    memberClaimIds: options.node.memberClaimIds,
    memberStateIds: options.node.memberStateIds,
    currentStateIds: options.node.currentStateIds,
    memberWorldlineIds: options.node.memberWorldlineIds,
    sourceSegmentIds,
    sourceSegmentSemanticInputHashes,
    familyInputHash: hashStable(familyInput),
    representativeInputHash: hashStable(representativeInput),
    synthesisInputHash: hashStable(synthesisInput),
    consolidationReasons: options.node.consolidationReasons,
    incomingFamilyIds: options.dependencies.incomingFamilyIds,
    outgoingFamilyIds: options.dependencies.outgoingFamilyIds,
    neighborFamilyIds: options.dependencies.neighborFamilyIds,
    incomingEdgeIds: options.dependencies.incomingEdgeIds,
    outgoingEdgeIds: options.dependencies.outgoingEdgeIds,
    reviewCaseIds: options.dependencies.reviewCaseIds
  };
}

export function buildConsolidationStateArtifacts(options: {
  graph: ConsolidatedThoughtGraph;
  reviewCandidates?: ConsolidationReviewCandidate[];
  segmentIndex: SegmentIndexArtifact | null;
}): {
  familyIndex: ThoughtConsolidationFamilyIndex;
  nodeFamilyIndex: ThoughtConsolidationNodeFamilyIndex;
  dependencyIndex: ThoughtConsolidationDependencyIndex;
} {
  const dependencyIndex = buildDependencies(options.graph, options.reviewCandidates);
  const families = options.graph.nodes
    .map((node) =>
      buildFamilyRecord({
        graph: options.graph,
        node,
        dependencies: dependencyIndex.byFamilyId[node.id] ?? buildEmptyFamilyDependencies(),
        segmentIndex: options.segmentIndex
      })
    )
    .sort((left, right) => left.familyId.localeCompare(right.familyId));

  const byNodeId: Record<string, string> = {};
  const byCanonicalKeyBuckets = new Map<string, Set<string>>();
  for (const family of families) {
    for (const nodeId of family.memberNodeIds) {
      byNodeId[nodeId] = family.familyId;
    }
    for (const canonicalKey of family.memberCanonicalKeys) {
      const bucket = byCanonicalKeyBuckets.get(canonicalKey) ?? new Set<string>();
      bucket.add(family.familyId);
      byCanonicalKeyBuckets.set(canonicalKey, bucket);
    }
  }

  const nodeFamilyIndex: ThoughtConsolidationNodeFamilyIndex = {
    version: CONSOLIDATION_STATE_VERSION,
    generatedAt: options.graph.generatedAt,
    sourceRunId: options.graph.sourceRunId,
    familyCount: families.length,
    granularNodeCount: Object.keys(byNodeId).length,
    byNodeId,
    byCanonicalKey: Object.fromEntries(
      Array.from(byCanonicalKeyBuckets.entries()).map(([canonicalKey, familyIds]) => [
        canonicalKey,
        uniqueSorted(familyIds)
      ])
    )
  };

  return {
    familyIndex: {
      version: CONSOLIDATION_STATE_VERSION,
      generatedAt: options.graph.generatedAt,
      sourceRunId: options.graph.sourceRunId,
      sourceGraphPath: options.graph.sourceGraphPath,
      sourceNodeCount: options.graph.sourceNodeCount,
      sourceEdgeCount: options.graph.sourceEdgeCount,
      familyCount: families.length,
      families
    },
    nodeFamilyIndex,
    dependencyIndex
  };
}

export function buildConsolidationAffectedScope(options: {
  currentFamilyIndex: ThoughtConsolidationFamilyIndex;
  currentDependencyIndex: ThoughtConsolidationDependencyIndex;
  previousFamilyIndex: ThoughtConsolidationFamilyIndex | null;
  forceNewRun: boolean;
  localRecomputeFamilyIds?: Iterable<string>;
  allowedRemovedFamilyIds?: Iterable<string>;
}): ThoughtConsolidationAffectedScope {
  const currentById = new Map(options.currentFamilyIndex.families.map((family) => [
    family.familyId,
    family
  ]));
  const previousById = new Map((options.previousFamilyIndex?.families ?? []).map((family) => [
    family.familyId,
    family
  ]));
  const structurallyAffected = new Set<string>();
  const added = new Set<string>();
  const removed = new Set<string>();
  const changed = new Set<string>();
  const neighborExpanded = new Set<string>();
  const reviewScope = new Set<string>();
  const synthesisScope = new Set<string>();
  const invalidatedReviewCaseIds = new Set<string>();
  const affectedEdgeIds = new Set<string>();

  if (!options.previousFamilyIndex || options.forceNewRun) {
    for (const family of options.currentFamilyIndex.families) {
      structurallyAffected.add(family.familyId);
      if (!options.previousFamilyIndex) {
        added.add(family.familyId);
      }
    }
  } else {
    for (const family of options.currentFamilyIndex.families) {
      const previous = previousById.get(family.familyId);
      if (!previous) {
        structurallyAffected.add(family.familyId);
        added.add(family.familyId);
        continue;
      }
      if (
        previous.representativeInputHash !== family.representativeInputHash ||
        previous.synthesisInputHash !== family.synthesisInputHash
      ) {
        structurallyAffected.add(family.familyId);
        changed.add(family.familyId);
      }
    }

    for (const previous of options.previousFamilyIndex.families) {
      if (!currentById.has(previous.familyId)) {
        removed.add(previous.familyId);
      }
    }
  }

  for (const familyId of options.localRecomputeFamilyIds ?? []) {
    if (currentById.has(familyId)) {
      structurallyAffected.add(familyId);
    }
  }

  for (const familyId of structurallyAffected) {
    if (currentById.has(familyId)) {
      reviewScope.add(familyId);
      synthesisScope.add(familyId);
    }
  }

  for (const familyId of Array.from(reviewScope)) {
    const deps = options.currentDependencyIndex.byFamilyId[familyId];
    if (!deps) {
      continue;
    }
    for (const neighborId of deps.neighborFamilyIds) {
      if (!reviewScope.has(neighborId)) {
        neighborExpanded.add(neighborId);
      }
      reviewScope.add(neighborId);
    }
    for (const edgeId of [...deps.incomingEdgeIds, ...deps.outgoingEdgeIds]) {
      affectedEdgeIds.add(edgeId);
    }
    for (const caseId of deps.reviewCaseIds) {
      invalidatedReviewCaseIds.add(caseId);
    }
  }

  for (const familyId of neighborExpanded) {
    const deps = options.currentDependencyIndex.byFamilyId[familyId];
    for (const caseId of deps?.reviewCaseIds ?? []) {
      invalidatedReviewCaseIds.add(caseId);
    }
    for (const edgeId of [...(deps?.incomingEdgeIds ?? []), ...(deps?.outgoingEdgeIds ?? [])]) {
      affectedEdgeIds.add(edgeId);
    }
  }

  const currentFamilyIds = new Set(
    options.currentFamilyIndex.families.map((family) => family.familyId)
  );
  const affectedFamilyIds = uniqueSorted(
    Array.from(structurallyAffected).filter((familyId) => currentFamilyIds.has(familyId))
  );
  const reviewScopeFamilyIds = uniqueSorted(
    Array.from(reviewScope).filter((familyId) => currentFamilyIds.has(familyId))
  );
  const synthesisScopeFamilyIds = uniqueSorted(
    Array.from(synthesisScope).filter((familyId) => currentFamilyIds.has(familyId))
  );
  const reusedFamilyIds = uniqueSorted(
    Array.from(currentFamilyIds).filter((familyId) => !structurallyAffected.has(familyId))
  );
  const affectedFamilyShare =
    currentFamilyIds.size === 0 ? 0 : affectedFamilyIds.length / currentFamilyIds.size;
  const dependencyExpandedClosureShare =
    currentFamilyIds.size === 0 ? 0 : reviewScopeFamilyIds.length / currentFamilyIds.size;
  const fallbackReasons: string[] = [];
  const mode = options.forceNewRun
    ? "force_new_run"
    : options.previousFamilyIndex
      ? "incremental"
      : "baseline";

  if (!options.previousFamilyIndex) {
    fallbackReasons.push("No previous consolidation family index is available.");
  }
  if (options.forceNewRun) {
    fallbackReasons.push("Consolidation force-new-run bypass requested.");
  }
  const knownLocalFamilyIds = new Set(options.localRecomputeFamilyIds ?? []);
  const allowedRemovedFamilyIds = new Set([
    ...knownLocalFamilyIds,
    ...(options.allowedRemovedFamilyIds ?? [])
  ]);
  const removedOutsideKnownScope = Array.from(removed).filter(
    (familyId) => !allowedRemovedFamilyIds.has(familyId)
  );
  if (removedOutsideKnownScope.length > 0 && allowedRemovedFamilyIds.size > 0) {
    fallbackReasons.push(
      `${removedOutsideKnownScope.length} previous families disappeared outside the known incremental scope.`
    );
  } else if (removed.size > 0 && allowedRemovedFamilyIds.size === 0 && options.previousFamilyIndex) {
    fallbackReasons.push(
      `${removed.size} previous families are no longer present and no incremental scope was available.`
    );
  }
  const affectedCountTripsFallback =
    affectedFamilyIds.length >= THOUGHT_CONSOLIDATION_DEFAULTS.affectedFamilyCountFallbackThreshold;
  const wholeGraphAffected =
    currentFamilyIds.size > 0 && affectedFamilyIds.length === currentFamilyIds.size;
  if (
    options.previousFamilyIndex &&
    !options.forceNewRun &&
    affectedFamilyShare >= THOUGHT_CONSOLIDATION_DEFAULTS.affectedFamilyShareFallbackThreshold &&
    (affectedCountTripsFallback || wholeGraphAffected)
  ) {
    fallbackReasons.push(
      `Local recompute family share ${affectedFamilyShare.toFixed(3)} reached threshold ${THOUGHT_CONSOLIDATION_DEFAULTS.affectedFamilyShareFallbackThreshold} with ${affectedFamilyIds.length} affected families.`
    );
  }
  const broaderPathUsed = fallbackReasons.length > 0;

  return {
    version: CONSOLIDATION_STATE_VERSION,
    generatedAt: new Date().toISOString(),
    mode,
    sourceRunId: options.currentFamilyIndex.sourceRunId,
    previousSourceRunId: options.previousFamilyIndex?.sourceRunId ?? null,
    previousFamilyCount: options.previousFamilyIndex?.familyCount ?? 0,
    currentFamilyCount: options.currentFamilyIndex.familyCount,
    localRecomputeFamilyIds: affectedFamilyIds,
    affectedFamilyIds,
    reviewScopeFamilyIds,
    synthesisScopeFamilyIds,
    dependencyExpandedClosureFamilyIds: reviewScopeFamilyIds,
    reusedFamilyIds,
    addedFamilyIds: uniqueSorted(added),
    removedFamilyIds: uniqueSorted(removed),
    changedFamilyIds: uniqueSorted(changed),
    neighborExpandedFamilyIds: uniqueSorted(neighborExpanded),
    affectedEdgeIds: uniqueSorted(affectedEdgeIds),
    invalidatedReviewCaseIds: uniqueSorted(invalidatedReviewCaseIds),
    invalidatedSynthesisFamilyIds: synthesisScopeFamilyIds,
    broaderPathUsed,
    fallbackMode: broaderPathUsed ? "global_deterministic" : "none",
    fallbackReasons,
    stats: {
      localRecomputeFamilyCount: affectedFamilyIds.length,
      localRecomputeFamilyShare: affectedFamilyShare,
      affectedFamilyCount: affectedFamilyIds.length,
      reusedFamilyCount: reusedFamilyIds.length,
      affectedFamilyShare,
      reviewScopeFamilyCount: reviewScopeFamilyIds.length,
      synthesisScopeFamilyCount: synthesisScopeFamilyIds.length,
      dependencyExpandedClosureFamilyCount: reviewScopeFamilyIds.length,
      dependencyExpandedClosureShare,
      affectedEdgeCount: affectedEdgeIds.size,
      invalidatedReviewCaseCount: invalidatedReviewCaseIds.size,
      invalidatedSynthesisCount: synthesisScopeFamilyIds.length
    }
  };
}

export function writeConsolidationStateArtifacts(
  paths: ProjectPaths,
  artifacts: {
    familyIndex: ThoughtConsolidationFamilyIndex;
    nodeFamilyIndex: ThoughtConsolidationNodeFamilyIndex;
    dependencyIndex: ThoughtConsolidationDependencyIndex;
    affectedScope: ThoughtConsolidationAffectedScope;
  }
): void {
  const stateDir = getConsolidationStateDir(paths);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    getConsolidationFamilyIndexPath(paths),
    `${JSON.stringify(artifacts.familyIndex, null, 2)}\n`,
    "utf8"
  );
  writeFileSync(
    getConsolidationNodeFamilyIndexPath(paths),
    `${JSON.stringify(artifacts.nodeFamilyIndex, null, 2)}\n`,
    "utf8"
  );
  writeFileSync(
    getConsolidationDependencyIndexPath(paths),
    `${JSON.stringify(artifacts.dependencyIndex, null, 2)}\n`,
    "utf8"
  );
  writeFileSync(
    getConsolidationAffectedScopePath(paths),
    `${JSON.stringify(artifacts.affectedScope, null, 2)}\n`,
    "utf8"
  );
}
