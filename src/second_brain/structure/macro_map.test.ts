import assert from "node:assert/strict";
import test from "node:test";

import type { ConsolidatedThoughtGraph, ConsolidatedThoughtNode } from "../compiler/types.js";
import {
  assessMacroNodes,
  repairMacroMapCoverage,
  validateMacroMapProposal
} from "./macro_map.js";

function node(options: {
  id: string;
  sourceKind: "writing" | "conversation";
  documentId: string;
  nodeType?: ConsolidatedThoughtNode["nodeType"];
}): ConsolidatedThoughtNode {
  return {
    id: options.id,
    canonicalKey: options.id,
    title: options.id,
    summary: options.id,
    nodeType: options.nodeType ?? "thesis",
    status: "active",
    firstSeen: null,
    lastSeen: null,
    sourceRefs: [{
      sourceKind: options.sourceKind,
      sourcePath: `/tmp/${options.documentId}`,
      documentId: options.documentId,
      documentTitle: options.documentId,
      locator: "test",
      sourceItemId: "test"
    }],
    relatedNodeIds: [],
    aliases: [],
    signalBySourceKind: { writing: options.sourceKind === "writing" ? 1 : 0, conversation: options.sourceKind === "conversation" ? 1 : 0, chat: 0 },
    memberNodeIds: [options.id],
    memberCanonicalKeys: [options.id],
    memberClaimIds: [],
    memberStateIds: [],
    currentStateIds: [],
    memberWorldlineIds: [],
    consolidationReasons: []
  };
}

function graph(nodes: ConsolidatedThoughtNode[]): ConsolidatedThoughtGraph {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceRunId: "test",
    sourceGraphPath: "/tmp/graph.json",
    sourceNodeCount: nodes.length,
    sourceEdgeCount: 0,
    nodeCount: nodes.length,
    edgeCount: 0,
    nodes,
    edges: []
  };
}

test("authored evidence outranks an otherwise equal conversation singleton", () => {
  const assessments = assessMacroNodes(graph([
    node({ id: "writing", sourceKind: "writing", documentId: "writing:one" }),
    node({ id: "conversation", sourceKind: "conversation", documentId: "conversation:one" })
  ]));
  assert.equal(assessments[0]?.nodeId, "writing");
  assert.ok(assessments[0]!.salienceScore > assessments[1]!.salienceScore);
});

test("proposal validation rejects role partitions that omit a member", () => {
  assert.throws(() => validateMacroMapProposal({
    atlasTitle: "Atlas",
    atlasSummary: "Summary",
    constellations: Array.from({ length: 8 }, (_, index) => ({
      key: `key-${index}`,
      title: `Title ${index}`,
      summary: "Summary",
      rationale: "Rationale",
      trajectoryHint: "Trajectory",
      atlasRole: "core_direction",
      confidence: 0.8,
      uncertainty: "None",
      memberNodeIds: ["a", "b", "c", "d", "e"],
      coreNodeIds: ["a"],
      supportingNodeIds: [],
      contextNodeIds: [],
      currentPositionNodeIds: [],
      openQuestionNodeIds: [],
      tensionNodeIds: []
    }))
  }, new Set(["a", "b", "c", "d", "e"])), /partition/);
});

test("proposal validation accepts a complete core, supporting, and context partition", () => {
  const proposal = {
    atlasTitle: "Atlas",
    atlasSummary: "Summary",
    constellations: Array.from({ length: 8 }, (_, index) => ({
      key: `key-${index}`,
      title: `Title ${index}`,
      summary: "Summary",
      rationale: "Rationale",
      trajectoryHint: "Trajectory",
      atlasRole: "core_direction" as const,
      confidence: 0.8,
      uncertainty: "None",
      memberNodeIds: ["a", "b", "c"],
      coreNodeIds: ["a"],
      supportingNodeIds: ["b"],
      contextNodeIds: ["c"],
      currentPositionNodeIds: ["a"],
      openQuestionNodeIds: [],
      tensionNodeIds: []
    }))
  };

  assert.equal(validateMacroMapProposal(proposal, new Set(["a", "b", "c"])), proposal);
});

test("proposal validation accepts an explicit scaled constellation limit", () => {
  const memberNodeIds = Array.from({ length: 901 }, (_, index) => `node-${index}`);
  const proposal = {
    atlasTitle: "Atlas",
    atlasSummary: "Summary",
    constellations: Array.from({ length: 8 }, (_, index) => ({
      key: `key-${index}`,
      title: `Title ${index}`,
      summary: "Summary",
      rationale: "Rationale",
      trajectoryHint: "Trajectory",
      atlasRole: "core_direction" as const,
      confidence: 0.8,
      uncertainty: "None",
      memberNodeIds,
      coreNodeIds: memberNodeIds.slice(0, 1),
      supportingNodeIds: memberNodeIds.slice(1),
      contextNodeIds: [],
      currentPositionNodeIds: [],
      openQuestionNodeIds: [],
      tensionNodeIds: []
    }))
  };

  assert.equal(
    validateMacroMapProposal(proposal, new Set(memberNodeIds), {
      maxConstellationMemberCount: 1_000
    }),
    proposal
  );
});

test("coverage repair assigns an authored gap only with a clear mapped-neighbor majority", () => {
  const nodes = ["a", "b", "c", "d", "e", "target"].map((id) =>
    node({ id, sourceKind: "writing", documentId: `writing:${id}` })
  );
  nodes.at(-1)!.relatedNodeIds = ["a", "b"];
  const inputGraph = graph(nodes);
  const result = repairMacroMapCoverage({
    graph: inputGraph,
    assessments: assessMacroNodes(inputGraph),
    proposal: {
      atlasTitle: "Atlas",
      atlasSummary: "Summary",
      constellations: [{
        key: "one",
        title: "One",
        summary: "Summary",
        rationale: "Rationale",
        trajectoryHint: "Trajectory",
        atlasRole: "core_direction",
        confidence: 0.8,
        uncertainty: "None",
        memberNodeIds: ["a", "b", "c", "d", "e"],
        coreNodeIds: ["a"],
        supportingNodeIds: ["b", "c"],
        contextNodeIds: ["d", "e"],
        currentPositionNodeIds: ["a"],
        openQuestionNodeIds: [],
        tensionNodeIds: []
      }]
    }
  });
  assert.deepEqual(result.proposal.constellations[0]!.memberNodeIds, ["a", "b", "c", "d", "e", "target"]);
  assert.ok(result.proposal.constellations[0]!.supportingNodeIds.includes("target"));
  assert.equal(result.repairs.length, 1);
});
