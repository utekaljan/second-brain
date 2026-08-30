import type {
  ConsolidatedThoughtGraph,
  ThoughtFrameAlignmentArtifact,
  ThoughtGraph
} from "../compiler/types.js";
import { hashStableSet } from "../utils/stable_hash.js";

function semanticSourceRef(ref: ConsolidatedThoughtGraph["nodes"][number]["sourceRefs"][number]) {
  // sourcePath and bundleName are export transport details. Conversation,
  // turn, message, document, and locator identities are the durable evidence.
  return {
    sourceKind: ref.sourceKind,
    documentId: ref.documentId,
    documentTitle: ref.documentTitle,
    locator: ref.locator,
    sourceItemId: ref.sourceItemId,
    conversationId: ref.conversationId,
    turnId: ref.turnId,
    messageId: ref.messageId
  };
}

/** Stable identity of the granular graph consumed by consolidation. */
export function computeThoughtGraphSemanticHash(graph: ThoughtGraph): string {
  return hashStableSet({
    corpusHash: graph.corpusHash,
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    claimCount: graph.claimCount,
    nodes: graph.nodes.map((node) => ({
      ...node,
      sourceRefs: node.sourceRefs.map(semanticSourceRef)
    })),
    edges: graph.edges
  });
}

/**
 * Stable identity of the browseable graph consumed by alignment and macro map.
 * Volatile timestamps, run ids, paths, and JSON ordering are excluded.
 */
export function computeConsolidatedGraphSemanticHash(
  graph: ConsolidatedThoughtGraph
): string {
  return hashStableSet({
    sourceNodeCount: graph.sourceNodeCount,
    sourceEdgeCount: graph.sourceEdgeCount,
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    nodes: graph.nodes.map((node) => ({
      ...node,
      sourceRefs: node.sourceRefs.map(semanticSourceRef)
    })),
    edges: graph.edges
  });
}

/** Stable identity of deterministic frame alignment content. */
export function computeFrameAlignmentSemanticHash(
  alignment: ThoughtFrameAlignmentArtifact | null
): string | null {
  if (!alignment) return null;
  return hashStableSet({
    sourceFrameCount: alignment.sourceFrameCount,
    sourceSubframeCount: alignment.sourceSubframeCount,
    sourceConsolidatedNodeCount: alignment.sourceConsolidatedNodeCount,
    familyCount: alignment.familyCount,
    patternCount: alignment.patternCount,
    families: alignment.families,
    patterns: alignment.patterns
  });
}
