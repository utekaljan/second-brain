import test from "node:test";
import assert from "node:assert/strict";

import type { SegmentIndexArtifact } from "./semantic_cache.js";
import type { ConsolidatedThoughtGraph } from "./types.js";
import {
  buildConsolidationAffectedScope,
  buildConsolidationStateArtifacts
} from "./consolidation_state.js";

function createSegmentIndex(hashA = "semantic-a", hashB = "semantic-b"): SegmentIndexArtifact {
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    corpusHash: "corpus",
    documents: {},
    segments: {
      "writing:a:paragraph:1": {
        segmentId: "writing:a:paragraph:1",
        documentId: "writing:a",
        sourceKind: "writing",
        segmentKind: "writing_paragraph",
        signalKind: "primary",
        sequenceIndex: 1,
        time: null,
        textHash: "text-a",
        sourcePath: "/input/a.md",
        sourceItemId: "paragraph:1",
        semanticInputHash: hashA,
        hasSemanticContribution: true
      },
      "writing:b:paragraph:1": {
        segmentId: "writing:b:paragraph:1",
        documentId: "writing:b",
        sourceKind: "writing",
        segmentKind: "writing_paragraph",
        signalKind: "primary",
        sequenceIndex: 2,
        time: null,
        textHash: "text-b",
        sourcePath: "/input/b.md",
        sourceItemId: "paragraph:1",
        semanticInputHash: hashB,
        hasSemanticContribution: true
      }
    },
    stats: {
      documentCount: 2,
      segmentCount: 2,
      primarySegmentCount: 2,
      primarySegmentsWithCachedContributions: 2
    },
    diff: {
      previousGeneratedAt: null,
      previousCorpusHash: null,
      documents: {
        unchangedCount: 0,
        addedCount: 2,
        changedCount: 0,
        removedCount: 0,
        addedDocumentIds: [],
        changedDocumentIds: [],
        removedDocumentIds: []
      },
      primarySegments: {
        unchangedCount: 0,
        addedCount: 2,
        changedCount: 0,
        removedCount: 0,
        bySourceKind: {
          writing: { unchangedCount: 0, addedCount: 2, changedCount: 0, removedCount: 0 },
          conversation: { unchangedCount: 0, addedCount: 0, changedCount: 0, removedCount: 0 },
          chat: { unchangedCount: 0, addedCount: 0, changedCount: 0, removedCount: 0 }
        },
        addedSegmentIdsSample: [],
        changedSegmentIdsSample: [],
        removedSegmentIdsSample: []
      }
    }
  };
}

function createGraph(titleA = "Zálivka potřebuje měření vlhkosti"): ConsolidatedThoughtGraph {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceRunId: "thought-compiler-run",
    sourceGraphPath: "/output/compiled/thought_graph.json",
    sourceNodeCount: 2,
    sourceEdgeCount: 1,
    nodeCount: 2,
    edgeCount: 1,
    nodes: [
      {
        id: "family:a",
        canonicalKey: "watering-sensor-feedback",
        title: titleA,
        summary: "Pevný plán zálivky nestačí bez měření půdy.",
        nodeType: "thesis",
        status: "active",
        firstSeen: null,
        lastSeen: null,
        sourceRefs: [
          {
            sourceKind: "writing",
            sourcePath: "/input/a.md",
            documentId: "writing:a",
            documentTitle: "A",
            locator: "paragraph:1",
            sourceItemId: "paragraph:1"
          }
        ],
        relatedNodeIds: ["family:b"],
        aliases: ["Zálivka a senzory"],
        signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
        memberNodeIds: ["thought:a"],
        memberCanonicalKeys: ["watering-sensor-feedback"],
        memberClaimIds: ["claim:a"],
        memberStateIds: ["state:a"],
        currentStateIds: ["state:a"],
        memberWorldlineIds: ["worldline:a"],
        consolidationReasons: ["single_node"]
      },
      {
        id: "family:b",
        canonicalKey: "watering-overflow-risk",
        title: "Přelití po pevné zálivce",
        summary: "Riziko přelití závisí na vlhkosti půdy.",
        nodeType: "theme",
        status: "active",
        firstSeen: null,
        lastSeen: null,
        sourceRefs: [
          {
            sourceKind: "writing",
            sourcePath: "/input/b.md",
            documentId: "writing:b",
            documentTitle: "B",
            locator: "paragraph:1",
            sourceItemId: "paragraph:1"
          }
        ],
        relatedNodeIds: ["family:a"],
        aliases: ["Riziko přelití"],
        signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
        memberNodeIds: ["thought:b"],
        memberCanonicalKeys: ["watering-overflow-risk"],
        memberClaimIds: ["claim:b"],
        memberStateIds: ["state:b"],
        currentStateIds: ["state:b"],
        memberWorldlineIds: ["worldline:b"],
        consolidationReasons: ["single_node"]
      }
    ],
    edges: [
      {
        id: "semantic_related:family:a:family:b",
        from: "family:a",
        to: "family:b",
        type: "semantic_related",
        weight: 1,
        supportingSourceNodeIds: ["thought:a", "thought:b"],
        supportingEdgeIds: ["edge:a-b"],
        sourceRelationTypes: ["semantic_related"]
      }
    ]
  };
}

test("consolidation state indexes families, granular nodes, dependencies, and segment hashes", () => {
  const state = buildConsolidationStateArtifacts({
    graph: createGraph(),
    segmentIndex: createSegmentIndex()
  });

  assert.equal(state.familyIndex.familyCount, 2);
  assert.equal(state.nodeFamilyIndex.byNodeId["thought:a"], "family:a");
  assert.deepEqual(state.nodeFamilyIndex.byCanonicalKey["watering-overflow-risk"], ["family:b"]);
  assert.deepEqual(state.dependencyIndex.byFamilyId["family:a"].outgoingFamilyIds, ["family:b"]);
  assert.equal(
    state.familyIndex.families.find((family) => family.familyId === "family:a")
      ?.sourceSegmentSemanticInputHashes["writing:a:paragraph:1"],
    "semantic-a"
  );
});

test("affected scope reuses unchanged families and expands changed families to graph neighbors", () => {
  const previous = buildConsolidationStateArtifacts({
    graph: createGraph(),
    segmentIndex: createSegmentIndex()
  });
  const unchanged = buildConsolidationStateArtifacts({
    graph: createGraph(),
    segmentIndex: createSegmentIndex()
  });

  const unchangedScope = buildConsolidationAffectedScope({
    currentFamilyIndex: unchanged.familyIndex,
    currentDependencyIndex: unchanged.dependencyIndex,
    previousFamilyIndex: previous.familyIndex,
    forceNewRun: false
  });

  assert.deepEqual(unchangedScope.affectedFamilyIds, []);
  assert.deepEqual(unchangedScope.reusedFamilyIds, ["family:a", "family:b"]);

  const changed = buildConsolidationStateArtifacts({
    graph: createGraph("Zálivka vyžaduje pravidelné měření vlhkosti"),
    segmentIndex: createSegmentIndex("semantic-a-changed", "semantic-b")
  });
  const changedScope = buildConsolidationAffectedScope({
    currentFamilyIndex: changed.familyIndex,
    currentDependencyIndex: changed.dependencyIndex,
    previousFamilyIndex: previous.familyIndex,
    forceNewRun: false
  });

  assert.deepEqual(changedScope.changedFamilyIds, ["family:a"]);
  assert.deepEqual(changedScope.localRecomputeFamilyIds, ["family:a"]);
  assert.deepEqual(changedScope.neighborExpandedFamilyIds, ["family:b"]);
  assert.deepEqual(changedScope.affectedFamilyIds, ["family:a"]);
  assert.deepEqual(changedScope.reviewScopeFamilyIds, ["family:a", "family:b"]);
  assert.deepEqual(changedScope.invalidatedSynthesisFamilyIds, ["family:a"]);
  assert.deepEqual(changedScope.affectedEdgeIds, ["semantic_related:family:a:family:b"]);
  assert.equal(changedScope.stats.affectedFamilyShare, 0.5);
  assert.equal(changedScope.stats.dependencyExpandedClosureShare, 1);
  assert.equal(changedScope.fallbackMode, "none");
});

test("affected scope ignores display-only family title drift", () => {
  const previous = buildConsolidationStateArtifacts({
    graph: createGraph("Původní browseable název"),
    segmentIndex: createSegmentIndex()
  });
  const displayOnlyChange = buildConsolidationStateArtifacts({
    graph: createGraph("Nový browseable název"),
    segmentIndex: createSegmentIndex()
  });

  const scope = buildConsolidationAffectedScope({
    currentFamilyIndex: displayOnlyChange.familyIndex,
    currentDependencyIndex: displayOnlyChange.dependencyIndex,
    previousFamilyIndex: previous.familyIndex,
    forceNewRun: false
  });

  assert.deepEqual(scope.affectedFamilyIds, []);
  assert.deepEqual(scope.reusedFamilyIds, ["family:a", "family:b"]);
  assert.equal(scope.fallbackMode, "none");
});

test("affected scope does not force global fallback for small partial eval closures", () => {
  const previous = buildConsolidationStateArtifacts({
    graph: {
      ...createGraph(),
      nodeCount: 3,
      nodes: [
        ...createGraph().nodes,
        {
          ...createGraph().nodes[1]!,
          id: "family:c",
          canonicalKey: "watering-audit-log",
          title: "Záznam zálivky",
          summary: "Záznam měření a zálivky má zůstat auditovatelný.",
          memberNodeIds: ["thought:c"],
          memberCanonicalKeys: ["watering-audit-log"],
          memberClaimIds: ["claim:c"],
          memberStateIds: ["state:c"],
          currentStateIds: ["state:c"],
          memberWorldlineIds: ["worldline:c"],
          sourceRefs: []
        }
      ],
      edgeCount: 1
    },
    segmentIndex: createSegmentIndex()
  });
  const changed = buildConsolidationStateArtifacts({
    graph: {
      ...createGraph("Zálivka vyžaduje pravidelné měření vlhkosti"),
      nodeCount: 3,
      nodes: [
        ...createGraph("Zálivka vyžaduje pravidelné měření vlhkosti").nodes,
        {
          ...createGraph().nodes[1]!,
          id: "family:c",
          canonicalKey: "watering-audit-log",
          title: "Záznam zálivky",
          summary: "Záznam měření a zálivky má zůstat auditovatelný.",
          memberNodeIds: ["thought:c"],
          memberCanonicalKeys: ["watering-audit-log"],
          memberClaimIds: ["claim:c"],
          memberStateIds: ["state:c"],
          currentStateIds: ["state:c"],
          memberWorldlineIds: ["worldline:c"],
          sourceRefs: []
        }
      ],
      edgeCount: 1
    },
    segmentIndex: createSegmentIndex("semantic-a-changed", "semantic-b")
  });

  const scope = buildConsolidationAffectedScope({
    currentFamilyIndex: changed.familyIndex,
    currentDependencyIndex: changed.dependencyIndex,
    previousFamilyIndex: previous.familyIndex,
    forceNewRun: false
  });

  assert.equal(scope.stats.affectedFamilyCount, 1);
  assert.equal(scope.stats.reviewScopeFamilyCount, 2);
  assert.equal(scope.stats.dependencyExpandedClosureShare > 0.35, true);
  assert.equal(scope.fallbackMode, "none");
});
