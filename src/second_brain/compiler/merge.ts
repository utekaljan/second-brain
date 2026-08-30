import type { SourceKind, UnifiedCorpus, UnifiedSegment } from "../types/domain.js";
import { slugify } from "../utils/text.js";
import type {
  ThoughtBatchOutput,
  ThoughtClaim,
  ThoughtCompilationArtifacts,
  ThoughtCompilerRunState,
  ThoughtDocumentFrameArtifact,
  ThoughtEdge,
  ThoughtIdentityBlock,
  ThoughtNode,
  ThoughtNodeCandidate,
  ThoughtNodeEvidence,
  ThoughtNodeFrameMembership,
  ThoughtNodeState,
  ThoughtNodeStatus,
  ThoughtNodeType,
  ThoughtRelationProposal,
  ThoughtRelationType,
  ThoughtWorldline,
  ThoughtWorldlineTransition
} from "./types.js";

/**
 * Deterministic post-LLM consolidation layer for the thought compiler.
 *
 * Codex proposes segment-level candidates. This module then does the mechanical
 * work that we explicitly do not want to hide inside prompts:
 * - canonicalize repeated candidates into node identities
 * - materialize claim artifacts
 * - derive temporal node states and worldlines
 * - aggregate graph relations with provenance
 *
 * The heuristics in this file are intentionally limited to post-processing over
 * already-semantic LLM outputs. They are not the meaning engine of the system.
 */
type CandidateOccurrence = {
  occurrenceId: string;
  batchId: string;
  inputId: string;
  candidateIndex: number;
  canonicalKey: string;
  title: string;
  nodeType: ThoughtNodeType;
  status: ThoughtNodeStatus;
  summary: string;
  claim: string;
  rationale: string;
  documentFrameId: string | null;
  documentSubframeId: string | null;
  frameRole: ThoughtNodeCandidate["frameRole"];
  relatedCanonicalKeys: string[];
  relationProposals: ThoughtRelationProposal[];
  identityAliases: string[];
  sourceKind: SourceKind;
  sourceRef: UnifiedSegment["sourceRef"];
  time: string | null;
  chronologyIndex: number;
  titleTokens: string[];
  summaryTokens: string[];
  claimTokens: string[];
};

type RelationAggregation = {
  fromNodeId: string;
  toNodeId: string;
  type: ThoughtRelationType;
  supportingSegmentIds: Set<string>;
  supportingClaimIds: Set<string>;
  rationales: Set<string>;
  weight: number;
};

// This is only used for cheap candidate-label comparison during post-LLM
// identity resolution. It deliberately does not drive thought extraction from
// raw source text.
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
  "vsichni",
  "z",
  "za",
  "ze",
  "the",
  "and",
  "for",
  "from",
  "into",
  "its",
  "of",
  "that",
  "this",
  "with"
]);

/**
 * Pick the most frequent categorical value inside one group.
 *
 * This keeps aggregation deterministic when several candidates disagree
 * slightly on type/status/title wording.
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

// Source refs are copied around many claim/state/node artifacts. Deduping them
// here keeps the final JSON readable without losing traceability.
function dedupeSourceRefs(sourceRefs: ThoughtNode["sourceRefs"]): ThoughtNode["sourceRefs"] {
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

// Chronology occasionally has missing timestamps. We keep nulls sortable rather
// than crashing so the compiler can still progress on partially timed data.
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

function createSourceKindCounter(): Record<SourceKind, number> {
  return {
    writing: 0,
    conversation: 0,
    chat: 0
  };
}

// Tokenization here exists only for approximate label similarity after the LLM
// has already proposed candidate meanings. It is a merge helper, not a
// substitute for semantic interpretation.
function tokenizeSemanticLabel(text: string): string[] {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  return normalized
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

// Jaccard is intentionally simple and inspectable. We only need a rough signal
// for candidate-title overlap, not a heavy semantic matcher at this stage.
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

// Title signature is the cheap blocking key. It narrows possible merge partners
// before we do the more careful pairwise checks below.
function buildTitleSignature(candidate: CandidateOccurrence): string {
  const signatureTokens = (candidate.titleTokens.length > 0
    ? candidate.titleTokens
    : tokenizeSemanticLabel(candidate.canonicalKey)
  )
    .slice(0, 4)
    .sort((left, right) => left.localeCompare(right));

  return signatureTokens.join("-");
}

function candidateTargetsOther(
  left: CandidateOccurrence,
  right: CandidateOccurrence
): boolean {
  return (
    left.relatedCanonicalKeys.includes(right.canonicalKey) ||
    right.relatedCanonicalKeys.includes(left.canonicalKey) ||
    left.relationProposals.some(
      (proposal) => proposal.targetCanonicalKey === right.canonicalKey
    ) ||
    right.relationProposals.some(
      (proposal) => proposal.targetCanonicalKey === left.canonicalKey
    )
  );
}

// This decides whether two already-semantic candidates are close enough to be
// treated as the same node identity. The main guardrail is important:
// if the model explicitly linked them, we prefer relation-over-merge.
function candidatesAreMergeable(
  left: CandidateOccurrence,
  right: CandidateOccurrence
): { mergeable: boolean; reason: string | null; confidence: "high" | "medium" | null } {
  if (left.nodeType !== right.nodeType) {
    return { mergeable: false, reason: null, confidence: null };
  }

  if (candidateTargetsOther(left, right)) {
    // If the model explicitly linked the two candidates, treat them as separate
    // nodes that need a relation, not as identity-equivalent labels.
    return { mergeable: false, reason: null, confidence: null };
  }

  if (left.canonicalKey === right.canonicalKey) {
    return {
      mergeable: true,
      reason: "exact_canonical_key",
      confidence: "high"
    };
  }

  const titleScore = jaccard(left.titleTokens, right.titleTokens);
  const summaryScore = jaccard(left.summaryTokens, right.summaryTokens);
  const claimScore = jaccard(left.claimTokens, right.claimTokens);
  const keyScore = jaccard(
    tokenizeSemanticLabel(left.canonicalKey),
    tokenizeSemanticLabel(right.canonicalKey)
  );

  if (
    titleScore >= 0.8 ||
    keyScore >= 0.8 ||
    ((titleScore >= 0.5 || keyScore >= 0.5) && (summaryScore >= 0.35 || claimScore >= 0.35))
  ) {
    return {
      mergeable: true,
      reason: "title_summary_guardrail",
      confidence: "medium"
    };
  }

  return { mergeable: false, reason: null, confidence: null };
}

function resolveBestCanonicalKey(candidates: CandidateOccurrence[]): string {
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();

  candidates.forEach((candidate, index) => {
    counts.set(candidate.canonicalKey, (counts.get(candidate.canonicalKey) ?? 0) + 1);
    if (!firstSeen.has(candidate.canonicalKey)) {
      firstSeen.set(candidate.canonicalKey, index);
    }
  });

  const ranked = Array.from(counts.entries()).sort((left, right) => {
    if (left[1] !== right[1]) {
      return right[1] - left[1];
    }

    return (firstSeen.get(left[0]) ?? Number.MAX_SAFE_INTEGER) -
      (firstSeen.get(right[0]) ?? Number.MAX_SAFE_INTEGER);
  });

  return ranked[0]?.[0] ?? "untitled-thought";
}

function shouldContinueState(left: ThoughtClaim, right: ThoughtClaim): boolean {
  if (left.status !== right.status) {
    return false;
  }

  const claimScore = jaccard(tokenizeSemanticLabel(left.claim), tokenizeSemanticLabel(right.claim));
  const summaryScore = jaccard(
    tokenizeSemanticLabel(left.summary),
    tokenizeSemanticLabel(right.summary)
  );

  return claimScore >= 0.55 || summaryScore >= 0.6;
}

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

// Turn batch outputs back into a flat occurrence stream tied to stable segment
// ids and chronology. Everything downstream works from this inspectable bridge
// layer instead of directly from raw batch JSON.
function extractCandidateOccurrences(
  corpus: UnifiedCorpus,
  batchOutputs: ThoughtBatchOutput[]
): CandidateOccurrence[] {
  const segmentById = new Map<string, UnifiedSegment>(
    corpus.segments.map((segment) => [segment.id, segment])
  );
  const chronologyBySegmentId = new Map<string, number>(
    corpus.timeline.map((entry) => [entry.segmentId, entry.chronologyIndex])
  );
  const occurrences: CandidateOccurrence[] = [];

  for (const batchOutput of batchOutputs) {
    for (const item of batchOutput.items) {
      const segment = segmentById.get(item.inputId);
      if (!segment) {
        continue;
      }

      for (let candidateIndex = 0; candidateIndex < item.nodeCandidates.length; candidateIndex += 1) {
        const candidate = item.nodeCandidates[candidateIndex];
        if (!candidate) {
          continue;
        }

        const canonicalKey = slugify(candidate.canonicalKey || candidate.title) || "untitled-thought";
        const claim =
          candidate.claim?.trim() ||
          candidate.summary.trim() ||
          candidate.title.trim() ||
          canonicalKey;

        occurrences.push({
          occurrenceId: `${batchOutput.batchId}:${item.inputId}:${candidateIndex}`,
          batchId: batchOutput.batchId,
          inputId: item.inputId,
          candidateIndex,
          canonicalKey,
          title: candidate.title.trim() || canonicalKey,
          nodeType: candidate.nodeType,
          status: candidate.status,
          summary: candidate.summary.trim(),
          claim,
          rationale: candidate.rationale.trim(),
          documentFrameId: candidate.documentFrameId ?? null,
          documentSubframeId: candidate.documentSubframeId ?? null,
          frameRole: candidate.frameRole ?? null,
          relatedCanonicalKeys: candidate.relatedCanonicalKeys
            .map((value) => slugify(value))
            .filter((value) => value.length > 0 && value !== canonicalKey),
          relationProposals: (candidate.relationProposals ?? []).map((proposal) => ({
            targetCanonicalKey: slugify(proposal.targetCanonicalKey),
            type: proposal.type,
            rationale: proposal.rationale.trim()
          })),
          identityAliases: (candidate.identityAliases ?? [])
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
          sourceKind: segment.sourceKind,
          sourceRef: segment.sourceRef,
          time: segment.time,
          chronologyIndex: chronologyBySegmentId.get(item.inputId) ?? Number.MAX_SAFE_INTEGER,
          titleTokens: tokenizeSemanticLabel(candidate.title),
          summaryTokens: tokenizeSemanticLabel(candidate.summary),
          claimTokens: tokenizeSemanticLabel(claim)
        });
      }
    }
  }

  return occurrences.sort((left, right) => {
    const timeComparison = compareTimes(left.time, right.time);
    if (timeComparison !== 0) {
      return timeComparison;
    }

    if (left.chronologyIndex !== right.chronologyIndex) {
      return left.chronologyIndex - right.chronologyIndex;
    }

    return left.occurrenceId.localeCompare(right.occurrenceId);
  });
}

// Identity resolution intentionally happens in two passes:
// 1. exact canonical-key reuse
// 2. guarded heuristic merge inside title-signature buckets
//
// The extra group-aware guardrail matters because transitive merges can easily
// collapse related-but-distinct nodes if we only look at pairs.
function buildIdentityResolution(
  candidates: CandidateOccurrence[]
): {
  blocks: Array<{
    blockId: string;
    canonicalKey: string;
    nodeType: ThoughtNodeType;
    mergeReasons: string[];
    mergeConfidence: "high" | "medium";
    candidates: CandidateOccurrence[];
  }>;
  canonicalKeyAliasMap: Map<string, string>;
} {
  const unionFind = new UnionFind(candidates.length);
  const mergeReasonsByRoot = new Map<number, Set<string>>();
  const confidenceByRoot = new Map<number, "high" | "medium">();

  // We re-read current group membership on demand because union operations may
  // have already changed which candidates are transitively considered "one thing".
  const getGroupMembers = (index: number): CandidateOccurrence[] => {
    const root = unionFind.find(index);
    return candidates.filter((_, candidateIndex) => unionFind.find(candidateIndex) === root);
  };

  const groupsTargetEachOther = (leftIndex: number, rightIndex: number): boolean => {
    if (unionFind.find(leftIndex) === unionFind.find(rightIndex)) {
      return false;
    }

    const leftGroup = getGroupMembers(leftIndex);
    const rightGroup = getGroupMembers(rightIndex);
    return leftGroup.some((leftCandidate) =>
      rightGroup.some((rightCandidate) => candidateTargetsOther(leftCandidate, rightCandidate))
    );
  };

  const registerMerge = (
    leftIndex: number,
    rightIndex: number,
    reason: string,
    confidence: "high" | "medium"
  ): void => {
    const leftRootBeforeMerge = unionFind.find(leftIndex);
    const rightRootBeforeMerge = unionFind.find(rightIndex);
    unionFind.union(leftIndex, rightIndex);
    const root = unionFind.find(leftIndex);
    const reasons = new Set<string>([
      ...(mergeReasonsByRoot.get(leftRootBeforeMerge) ?? []),
      ...(mergeReasonsByRoot.get(rightRootBeforeMerge) ?? [])
    ]);
    reasons.add(reason);
    mergeReasonsByRoot.set(root, reasons);
    const existingLeft = confidenceByRoot.get(leftRootBeforeMerge);
    const existingRight = confidenceByRoot.get(rightRootBeforeMerge);
    confidenceByRoot.set(
      root,
      existingLeft === "high" || existingRight === "high" || confidence === "high"
        ? "high"
        : "medium"
    );
  };

  const byExactKey = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const bucket = byExactKey.get(candidate.canonicalKey) ?? [];
    bucket.push(index);
    byExactKey.set(candidate.canonicalKey, bucket);
  });

  for (const indexes of byExactKey.values()) {
    for (let index = 1; index < indexes.length; index += 1) {
      const leftIndex = indexes[0];
      const rightIndex = indexes[index];
      if (typeof leftIndex === "number" && typeof rightIndex === "number") {
        registerMerge(leftIndex, rightIndex, "exact_canonical_key", "high");
      }
    }
  }

  const byTitleSignature = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const signature = `${candidate.nodeType}:${buildTitleSignature(candidate)}`;
    if (signature.endsWith(":")) {
      return;
    }

    const bucket = byTitleSignature.get(signature) ?? [];
    bucket.push(index);
    byTitleSignature.set(signature, bucket);
  });

  for (const indexes of byTitleSignature.values()) {
    for (let leftOffset = 0; leftOffset < indexes.length; leftOffset += 1) {
      for (
        let rightOffset = leftOffset + 1;
        rightOffset < indexes.length;
        rightOffset += 1
      ) {
        const leftIndex = indexes[leftOffset];
        const rightIndex = indexes[rightOffset];
        if (typeof leftIndex !== "number" || typeof rightIndex !== "number") {
          continue;
        }

        const decision = candidatesAreMergeable(
          candidates[leftIndex] ?? candidates[0]!,
          candidates[rightIndex] ?? candidates[0]!
        );

        if (decision.mergeable && decision.reason && decision.confidence) {
          // A direct or transitive relation signal beats heuristic label
          // similarity. Without this, revision/conflict pairs tend to collapse
          // into one node through a third near-duplicate candidate.
          if (groupsTargetEachOther(leftIndex, rightIndex)) {
            continue;
          }
          registerMerge(leftIndex, rightIndex, decision.reason, decision.confidence);
        }
      }
    }
  }

  const groups = new Map<number, CandidateOccurrence[]>();
  candidates.forEach((candidate, index) => {
    const root = unionFind.find(index);
    const bucket = groups.get(root) ?? [];
    bucket.push(candidate);
    groups.set(root, bucket);
  });

  const blocks = Array.from(groups.entries())
    .map(([root, group], index) => {
      const canonicalKey = resolveBestCanonicalKey(group);
      const nodeType = countWinners(
        group.map((candidate) => candidate.nodeType),
        group[0]?.nodeType ?? "theme"
      );
      return {
        blockId: `identity-block-${String(index + 1).padStart(4, "0")}`,
        canonicalKey,
        nodeType,
        mergeReasons: Array.from(
          mergeReasonsByRoot.get(root) ?? new Set(["single_candidate"])
        ).sort((left, right) => left.localeCompare(right)),
        mergeConfidence: confidenceByRoot.get(root) ?? "high",
        candidates: group
      };
    })
    .sort((left, right) => left.canonicalKey.localeCompare(right.canonicalKey));

  const canonicalKeyAliasMap = new Map<string, string>();
  for (const block of blocks) {
    for (const candidate of block.candidates) {
      canonicalKeyAliasMap.set(candidate.canonicalKey, block.canonicalKey);
      canonicalKeyAliasMap.set(slugify(candidate.title), block.canonicalKey);
      for (const alias of candidate.identityAliases) {
        canonicalKeyAliasMap.set(slugify(alias), block.canonicalKey);
      }
    }
  }

  return { blocks, canonicalKeyAliasMap };
}

// Claims are the inspectable "semantic atoms" below nodes. This is the layer
// we need for later worldlines, revision reasoning, and graph debugging.
function createThoughtClaims(
  identityBlocks: Array<{
    blockId: string;
    canonicalKey: string;
    nodeType: ThoughtNodeType;
    mergeReasons: string[];
    mergeConfidence: "high" | "medium";
    candidates: CandidateOccurrence[];
  }>
): {
  claims: ThoughtClaim[];
  identityBlocksArtifact: ThoughtIdentityBlock[];
} {
  const claims: ThoughtClaim[] = [];
  const identityBlocksArtifact: ThoughtIdentityBlock[] = [];

  for (const block of identityBlocks) {
    const nodeId = `thought:${block.canonicalKey}`;
    const claimIds: string[] = [];

    block.candidates.forEach((candidate, index) => {
      const claimId = `claim:${block.canonicalKey}:${String(index + 1).padStart(4, "0")}`;
      claimIds.push(claimId);
      claims.push({
        id: claimId,
        nodeId,
        canonicalKey: block.canonicalKey,
        inputId: candidate.inputId,
        batchId: candidate.batchId,
        chronologyIndex: candidate.chronologyIndex,
        time: candidate.time,
        sourceKind: candidate.sourceKind,
        nodeType: candidate.nodeType,
        status: candidate.status,
        title: candidate.title,
        summary: candidate.summary,
        claim: candidate.claim,
        rationale: candidate.rationale,
        documentFrameId: candidate.documentFrameId,
        documentSubframeId: candidate.documentSubframeId,
        frameRole: candidate.frameRole,
        relatedCanonicalKeys: candidate.relatedCanonicalKeys,
        sourceRef: candidate.sourceRef,
        relationProposals: candidate.relationProposals
      });
    });

    identityBlocksArtifact.push({
      id: block.blockId,
      canonicalKey: block.canonicalKey,
      nodeType: block.nodeType,
      candidateKeys: Array.from(
        new Set(block.candidates.map((candidate) => candidate.canonicalKey))
      ).sort((left, right) => left.localeCompare(right)),
      titleHints: Array.from(
        new Set(block.candidates.map((candidate) => candidate.title))
      ).sort((left, right) => left.localeCompare(right)),
      claimIds,
      mergeReasons: block.mergeReasons,
      mergeConfidence: block.mergeConfidence
    });
  }

  return {
    claims: claims.sort((left, right) => left.id.localeCompare(right.id)),
    identityBlocksArtifact: identityBlocksArtifact.sort((left, right) =>
      left.id.localeCompare(right.id)
    )
  };
}

// States are derived per node from claim chronology. The implementation is
// intentionally conservative: small wording differences can still create new
// states today, which is why a later consolidation pass is planned above this
// layer before wiki rendering.
function buildNodeStatesAndWorldlines(
  claims: ThoughtClaim[]
): {
  nodeStates: ThoughtNodeState[];
  worldlines: ThoughtWorldline[];
  currentStateIdByNodeId: Map<string, string | null>;
} {
  const claimsByNodeId = new Map<string, ThoughtClaim[]>();
  for (const claim of claims) {
    const bucket = claimsByNodeId.get(claim.nodeId) ?? [];
    bucket.push(claim);
    claimsByNodeId.set(claim.nodeId, bucket);
  }

  const nodeStates: ThoughtNodeState[] = [];
  const worldlines: ThoughtWorldline[] = [];
  const currentStateIdByNodeId = new Map<string, string | null>();

  for (const [nodeId, nodeClaims] of claimsByNodeId.entries()) {
    const sortedClaims = nodeClaims
      .slice()
      .sort((left, right) => {
        const timeComparison = compareTimes(left.time, right.time);
        if (timeComparison !== 0) {
          return timeComparison;
        }

        if (left.chronologyIndex !== right.chronologyIndex) {
          return left.chronologyIndex - right.chronologyIndex;
        }

        return left.id.localeCompare(right.id);
      });

    const stateClaims: ThoughtClaim[][] = [];
    for (const claim of sortedClaims) {
      const currentStateClaims = stateClaims[stateClaims.length - 1];
      if (!currentStateClaims || currentStateClaims.length === 0) {
        stateClaims.push([claim]);
        continue;
      }

      const previousClaim = currentStateClaims[currentStateClaims.length - 1];
      // State continuation is currently decided locally from neighboring claims.
      // This keeps the logic deterministic and cheap, but it also means later
      // graph-consolidation will need to merge overly fine-grained states.
      if (previousClaim && shouldContinueState(previousClaim, claim)) {
        currentStateClaims.push(claim);
      } else {
        stateClaims.push([claim]);
      }
    }

    const stateIds: string[] = [];
    const invalidatedStateIds: string[] = [];
    const transitions: ThoughtWorldlineTransition[] = [];

    stateClaims.forEach((claimsInState, index) => {
      const previousClaims = index > 0 ? stateClaims[index - 1] : undefined;
      const nextClaims = stateClaims[index + 1];
      const firstClaim = claimsInState[0];
      const lastClaim = claimsInState[claimsInState.length - 1];
      const previousLastClaim = previousClaims?.[previousClaims.length - 1];
      const nextFirstClaim = nextClaims?.[0];

      if (!firstClaim || !lastClaim) {
        return;
      }

      const stateId = `state:${slugify(nodeId)}:${String(index + 1).padStart(4, "0")}`;
      const title = countWinners(
        claimsInState.map((claim) => claim.title),
        firstClaim.title
      );
      const summary = countWinners(
        claimsInState.map((claim) => claim.summary || claim.claim),
        firstClaim.summary || firstClaim.claim
      );
      const status = countWinners(
        claimsInState.map((claim) => claim.status),
        firstClaim.status
      );

      const continuedFromPrevious =
        previousLastClaim !== undefined && shouldContinueState(previousLastClaim, firstClaim);
      const transitionType =
        index === 0
          ? "introduced"
          : previousLastClaim && status === previousLastClaim.status && continuedFromPrevious
            ? "continued"
            : "revised";

      nodeStates.push({
        id: stateId,
        nodeId,
        stateIndex: index + 1,
        title,
        summary,
        status,
        validFrom: firstClaim.time,
        validUntil: nextFirstClaim?.time ?? null,
        claimIds: claimsInState.map((claim) => claim.id),
        sourceRefs: dedupeSourceRefs(claimsInState.map((claim) => claim.sourceRef)),
        transitionType,
        revisedByStateId: nextFirstClaim
          ? `state:${slugify(nodeId)}:${String(index + 2).padStart(4, "0")}`
          : null
      });
      stateIds.push(stateId);

      if (nextFirstClaim) {
        invalidatedStateIds.push(stateId);
      }

      transitions.push({
        fromStateId: index === 0 ? null : stateIds[index - 1] ?? null,
        toStateId: stateId,
        type: transitionType,
        triggerClaimId: firstClaim.id
      });
    });

    const currentStateId = stateIds[stateIds.length - 1] ?? null;
    currentStateIdByNodeId.set(nodeId, currentStateId);

    worldlines.push({
      id: `worldline:${slugify(nodeId)}`,
      nodeId,
      firstSeen: sortedClaims[0]?.time ?? null,
      lastSeen: sortedClaims[sortedClaims.length - 1]?.time ?? null,
      currentStateId,
      stateIds,
      claimIds: sortedClaims.map((claim) => claim.id),
      invalidatedStateIds,
      sourceKinds: Array.from(new Set(sortedClaims.map((claim) => claim.sourceKind))).sort(
        (left, right) => left.localeCompare(right)
      ) as SourceKind[],
      transitions
    });
  }

  return {
    nodeStates: nodeStates.sort((left, right) => left.id.localeCompare(right.id)),
    worldlines: worldlines.sort((left, right) => left.id.localeCompare(right.id)),
    currentStateIdByNodeId
  };
}

// Nodes are the browseable unit candidates. They still inherit a lot from the
// claim/state layers, but at this point they are already stable enough to feed
// a later wiki renderer.
function buildThoughtNodes(
  claims: ThoughtClaim[],
  currentStateIdByNodeId: Map<string, string | null>,
  nodeStates: ThoughtNodeState[],
  documentFrames: ThoughtDocumentFrameArtifact | null
): ThoughtNode[] {
  const claimsByNodeId = new Map<string, ThoughtClaim[]>();
  const stateById = new Map<string, ThoughtNodeState>(nodeStates.map((state) => [state.id, state]));
  const frameById = new Map(
    (documentFrames?.frames ?? []).map((frame) => [frame.id, frame])
  );
  const subframeById = new Map(
    (documentFrames?.subframes ?? []).map((subframe) => [subframe.id, subframe])
  );

  for (const claim of claims) {
    const bucket = claimsByNodeId.get(claim.nodeId) ?? [];
    bucket.push(claim);
    claimsByNodeId.set(claim.nodeId, bucket);
  }

  const nodes: ThoughtNode[] = [];

  for (const [nodeId, nodeClaims] of claimsByNodeId.entries()) {
    const currentStateId = currentStateIdByNodeId.get(nodeId) ?? null;
    const currentState = currentStateId ? stateById.get(currentStateId) ?? null : null;
    const canonicalKey = nodeClaims[0]?.canonicalKey ?? slugify(nodeId);
    const signalBySourceKind = createSourceKindCounter();
    const evidence: ThoughtNodeEvidence[] = [];
    const aliases = new Set<string>();
    const frameMembershipsByKey = new Map<string, ThoughtNodeFrameMembership>();
    let firstSeen: string | null = null;
    let lastSeen: string | null = null;

    for (const claim of nodeClaims) {
      signalBySourceKind[claim.sourceKind] += 1;
      evidence.push({
        inputId: claim.inputId,
        batchId: claim.batchId,
        sourceKind: claim.sourceKind,
        sourceRef: claim.sourceRef,
        rationale: claim.rationale
      });
      aliases.add(claim.title);
      aliases.add(claim.claim);

      if (claim.documentFrameId) {
        const frame = frameById.get(claim.documentFrameId);
        const subframe = claim.documentSubframeId
          ? subframeById.get(claim.documentSubframeId) ?? null
          : null;
        const key = [
          claim.sourceRef.documentId,
          claim.documentFrameId,
          claim.documentSubframeId ?? "",
          claim.frameRole ?? ""
        ].join(":");
        const existingMembership = frameMembershipsByKey.get(key);
        if (existingMembership) {
          existingMembership.occurrenceCount += 1;
        } else {
          frameMembershipsByKey.set(key, {
            documentId: claim.sourceRef.documentId,
            frameId: claim.documentFrameId,
            frameLabel: frame?.label ?? claim.sourceRef.documentTitle,
            subframeId: claim.documentSubframeId ?? null,
            subframeLabel: subframe?.label ?? null,
            frameRole: claim.frameRole ?? null,
            occurrenceCount: 1
          });
        }
      }

      if (claim.time !== null) {
        if (firstSeen === null || compareTimes(claim.time, firstSeen) < 0) {
          firstSeen = claim.time;
        }
        if (lastSeen === null || compareTimes(claim.time, lastSeen) > 0) {
          lastSeen = claim.time;
        }
      }
    }

    nodes.push({
      id: nodeId,
      canonicalKey,
      nodeType: countWinners(
        nodeClaims.map((claim) => claim.nodeType),
        nodeClaims[0]?.nodeType ?? "theme"
      ),
      title: currentState?.title ?? countWinners(nodeClaims.map((claim) => claim.title), canonicalKey),
      summary:
        currentState?.summary ??
        countWinners(nodeClaims.map((claim) => claim.summary || claim.claim), canonicalKey),
      status: currentState?.status ?? countWinners(nodeClaims.map((claim) => claim.status), "active"),
      firstSeen,
      lastSeen,
      currentStateId,
      sourceRefs: dedupeSourceRefs(nodeClaims.map((claim) => claim.sourceRef)),
      evidence,
      relatedNodeIds: [],
      signalBySourceKind,
      aliases: Array.from(aliases).sort((left, right) => left.localeCompare(right)),
      frameMemberships: Array.from(frameMembershipsByKey.values()).sort((left, right) => {
        if (left.documentId !== right.documentId) {
          return left.documentId.localeCompare(right.documentId);
        }
        if (left.frameId !== right.frameId) {
          return left.frameId.localeCompare(right.frameId);
        }
        if ((left.subframeId ?? "") !== (right.subframeId ?? "")) {
          return (left.subframeId ?? "").localeCompare(right.subframeId ?? "");
        }
        return (left.frameRole ?? "").localeCompare(right.frameRole ?? "");
      })
    });
  }

  return nodes.sort((left, right) => left.id.localeCompare(right.id));
}

function relationKey(fromNodeId: string, toNodeId: string, type: ThoughtRelationType): string {
  const ordered =
    type === "co_occurs" || type === "semantic_related" || type === "tensions_with" || type === "context_split"
      ? [fromNodeId, toNodeId].sort((left, right) => left.localeCompare(right))
      : [fromNodeId, toNodeId];

  return `${type}:${ordered[0] ?? fromNodeId}:${ordered[1] ?? toNodeId}`;
}

// Relation aggregation preserves supporting claim ids and segment ids so later
// browsing can explain why an edge exists instead of treating edges as magic.
function buildThoughtEdges(
  claims: ThoughtClaim[],
  nodeIdByCanonicalKey: Map<string, string>
): ThoughtEdge[] {
  const edges = new Map<string, RelationAggregation>();
  const claimsByInputId = new Map<string, ThoughtClaim[]>();

  const addEdge = (
    fromNodeId: string,
    toNodeId: string,
    type: ThoughtRelationType,
    supportingSegmentId: string,
    supportingClaimId: string,
    rationale?: string
  ): void => {
    if (fromNodeId === toNodeId) {
      return;
    }

    const key = relationKey(fromNodeId, toNodeId, type);
    const existing = edges.get(key);
    if (existing) {
      existing.supportingSegmentIds.add(supportingSegmentId);
      existing.supportingClaimIds.add(supportingClaimId);
      if (rationale && rationale.length > 0) {
        existing.rationales.add(rationale);
      }
      existing.weight += 1;
      return;
    }

    edges.set(key, {
      fromNodeId,
      toNodeId,
      type,
      supportingSegmentIds: new Set([supportingSegmentId]),
      supportingClaimIds: new Set([supportingClaimId]),
      rationales: rationale && rationale.length > 0 ? new Set([rationale]) : new Set<string>(),
      weight: 1
    });
  };

  for (const claim of claims) {
    const bucket = claimsByInputId.get(claim.inputId) ?? [];
    bucket.push(claim);
    claimsByInputId.set(claim.inputId, bucket);

    for (const relatedCanonicalKey of claim.relatedCanonicalKeys) {
      const targetNodeId = nodeIdByCanonicalKey.get(relatedCanonicalKey);
      if (!targetNodeId) {
        continue;
      }

      addEdge(claim.nodeId, targetNodeId, "semantic_related", claim.inputId, claim.id);
    }

    for (const proposal of claim.relationProposals) {
      const targetNodeId = nodeIdByCanonicalKey.get(proposal.targetCanonicalKey);
      if (!targetNodeId) {
        continue;
      }

      addEdge(claim.nodeId, targetNodeId, proposal.type, claim.inputId, claim.id, proposal.rationale);
    }
  }

  for (const segmentClaims of claimsByInputId.values()) {
    for (let leftIndex = 0; leftIndex < segmentClaims.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < segmentClaims.length;
        rightIndex += 1
      ) {
        const left = segmentClaims[leftIndex];
        const right = segmentClaims[rightIndex];
        if (!left || !right || left.nodeId === right.nodeId) {
          continue;
        }

        addEdge(left.nodeId, right.nodeId, "co_occurs", left.inputId, left.id);
      }
    }
  }

  return Array.from(edges.values())
    .map((aggregate) => ({
      id: relationKey(aggregate.fromNodeId, aggregate.toNodeId, aggregate.type),
      from:
        aggregate.type === "co_occurs" ||
        aggregate.type === "semantic_related" ||
        aggregate.type === "tensions_with" ||
        aggregate.type === "context_split"
          ? [aggregate.fromNodeId, aggregate.toNodeId].sort((left, right) =>
              left.localeCompare(right)
            )[0] ?? aggregate.fromNodeId
          : aggregate.fromNodeId,
      to:
        aggregate.type === "co_occurs" ||
        aggregate.type === "semantic_related" ||
        aggregate.type === "tensions_with" ||
        aggregate.type === "context_split"
          ? [aggregate.fromNodeId, aggregate.toNodeId].sort((left, right) =>
              left.localeCompare(right)
            )[1] ?? aggregate.toNodeId
          : aggregate.toNodeId,
      type: aggregate.type,
      weight: aggregate.weight,
      supportingSegmentIds: Array.from(aggregate.supportingSegmentIds).sort((left, right) =>
        left.localeCompare(right)
      ),
      supportingClaimIds: Array.from(aggregate.supportingClaimIds).sort((left, right) =>
        left.localeCompare(right)
      ),
      rationales: Array.from(aggregate.rationales).sort((left, right) =>
        left.localeCompare(right)
      )
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Merge all completed batch outputs into the current richer compiler artifacts.
 */
export function buildThoughtCompilationArtifacts(
  corpus: UnifiedCorpus,
  state: ThoughtCompilerRunState,
  batchOutputs: ThoughtBatchOutput[],
  documentFrames: ThoughtDocumentFrameArtifact | null = null
): ThoughtCompilationArtifacts {
  const candidates = extractCandidateOccurrences(corpus, batchOutputs);
  const { blocks, canonicalKeyAliasMap } = buildIdentityResolution(candidates);
  // Once identities are resolved, relation targets need to be rewritten to the
  // chosen canonical keys. Otherwise later edge aggregation would still point
  // at pre-merge aliases.
  const remappedBlocks = blocks.map((block) => ({
    ...block,
    candidates: block.candidates.map((candidate) => ({
      ...candidate,
      relatedCanonicalKeys: candidate.relatedCanonicalKeys.map(
        (value) => canonicalKeyAliasMap.get(value) ?? value
      ),
      relationProposals: candidate.relationProposals.map((proposal) => ({
        ...proposal,
        targetCanonicalKey: canonicalKeyAliasMap.get(proposal.targetCanonicalKey) ?? proposal.targetCanonicalKey
      }))
    }))
  }));
  const { claims, identityBlocksArtifact } = createThoughtClaims(remappedBlocks);
  const { nodeStates, worldlines, currentStateIdByNodeId } = buildNodeStatesAndWorldlines(claims);
  const nodes = buildThoughtNodes(claims, currentStateIdByNodeId, nodeStates, documentFrames);
  const nodeIdByCanonicalKey = new Map<string, string>(
    nodes.map((node) => [node.canonicalKey, node.id])
  );
  const edges = buildThoughtEdges(claims, nodeIdByCanonicalKey);

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

  return {
    documentFrames,
    claims,
    nodeStates,
    worldlines,
    identityBlocks: identityBlocksArtifact,
    graph: {
      generatedAt: new Date().toISOString(),
      runId: state.runId,
      corpusHash: state.corpusHash,
      sourceCorpusPath: state.sourceCorpusPath,
      batchSize: state.batchSize,
      totalBatchCount: state.totalBatchCount,
      completedBatchCount: state.completedBatchIds.length,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      claimCount: claims.length,
      nodeStateCount: nodeStates.length,
      worldlineCount: worldlines.length,
      identityBlockCount: identityBlocksArtifact.length,
      nodes,
      edges
    }
  };
}

/**
 * Compatibility wrapper for older call sites that only want the top-level graph.
 */
export function buildThoughtGraph(
  corpus: UnifiedCorpus,
  state: ThoughtCompilerRunState,
  batchOutputs: ThoughtBatchOutput[]
) {
  return buildThoughtCompilationArtifacts(corpus, state, batchOutputs, null).graph;
}
