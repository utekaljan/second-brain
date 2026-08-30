import test from "node:test";
import assert from "node:assert/strict";

import type {
  ConsolidatedThoughtGraph,
  ThoughtClaim,
  ThoughtCompilationArtifacts,
  ThoughtEdge,
  ThoughtGraph,
  ThoughtIdentityBlock,
  ThoughtNode,
  ThoughtNodeState,
  ThoughtWorldline
} from "./types.js";
import {
  buildThoughtConsolidationArtifacts,
  sanitizeReciprocalRevisionEdges
} from "./consolidate.js";

function createThoughtNodes(): ThoughtNode[] {
  return [
    {
      id: "thought:fixed-watering-seems-sufficient",
      canonicalKey: "fixed-watering-seems-sufficient",
      nodeType: "thesis",
      title: "Pevný plán zálivky obvykle stačí",
      summary: "Pevný plán zálivky obvykle udržuje záhon v dobrém stavu.",
      status: "active",
      firstSeen: "2024-01-10T00:00:00.000Z",
      lastSeen: "2024-03-24T00:00:00.000Z",
      currentStateId: "state:fixed-watering-seems-sufficient:2",
      sourceRefs: [],
      evidence: [
        {
          inputId: "segment:1",
          batchId: "batch-0001",
          sourceKind: "writing",
          sourceRef: {
            sourceKind: "writing",
            sourcePath: "/input/writings/a.txt",
            documentId: "writing:a",
            documentTitle: "A",
            locator: "paragraph:1",
            sourceItemId: "paragraph:1"
          },
          rationale: "a"
        }
      ],
      relatedNodeIds: ["thought:watering-needs-sensor-feedback"],
      signalBySourceKind: { writing: 2, conversation: 0, chat: 0 },
      aliases: ["Pevný plán zálivky obvykle stačí"]
    },
    {
      id: "thought:fixed-watering-needs-moisture-check",
      canonicalKey: "fixed-watering-needs-moisture-check",
      nodeType: "thesis",
      title: "Pevný plán zálivky obvykle stačí",
      summary: "Pevný plán funguje jen při průběžné kontrole vlhkosti.",
      status: "revised",
      firstSeen: "2024-04-30T00:00:00.000Z",
      lastSeen: "2024-04-30T00:00:00.000Z",
      currentStateId: "state:fixed-watering-needs-moisture-check:1",
      sourceRefs: [],
      evidence: [
        {
          inputId: "segment:2",
          batchId: "batch-0002",
          sourceKind: "writing",
          sourceRef: {
            sourceKind: "writing",
            sourcePath: "/input/writings/b.txt",
            documentId: "writing:b",
            documentTitle: "B",
            locator: "paragraph:1",
            sourceItemId: "paragraph:1"
          },
          rationale: "b"
        }
      ],
      relatedNodeIds: ["thought:watering-needs-sensor-feedback"],
      signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
      aliases: ["Pevný plán funguje jen s kontrolou vlhkosti"]
    },
    {
      id: "thought:watering-needs-sensor-feedback",
      canonicalKey: "watering-needs-sensor-feedback",
      nodeType: "thesis",
      title: "Zálivka potřebuje zpětnou vazbu senzoru",
      summary: "Bez zpětné vazby může pevný plán půdu přelévat nebo vysušovat.",
      status: "active",
      firstSeen: "2024-04-30T00:00:00.000Z",
      lastSeen: "2024-04-30T00:00:00.000Z",
      currentStateId: "state:watering-needs-sensor-feedback:1",
      sourceRefs: [],
      evidence: [
        {
          inputId: "segment:3",
          batchId: "batch-0002",
          sourceKind: "writing",
          sourceRef: {
            sourceKind: "writing",
            sourcePath: "/input/writings/c.txt",
            documentId: "writing:c",
            documentTitle: "C",
            locator: "paragraph:1",
            sourceItemId: "paragraph:1"
          },
          rationale: "c"
        }
      ],
      relatedNodeIds: ["thought:fixed-watering-seems-sufficient"],
      signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
      aliases: ["Zálivka potřebuje měření vlhkosti"]
    }
  ];
}

function createThoughtEdges(): ThoughtEdge[] {
  return [
    {
      id: "revises:thought:fixed-watering-needs-moisture-check:thought:fixed-watering-seems-sufficient",
      from: "thought:fixed-watering-needs-moisture-check",
      to: "thought:fixed-watering-seems-sufficient",
      type: "revises",
      weight: 1,
      supportingSegmentIds: ["segment:2"],
      supportingClaimIds: ["claim:2"],
      rationales: ["Pozdější podmíněná verze opravuje původní pevný plán."]
    },
    {
      id: "semantic_related:thought:fixed-watering-seems-sufficient:thought:watering-needs-sensor-feedback",
      from: "thought:fixed-watering-seems-sufficient",
      to: "thought:watering-needs-sensor-feedback",
      type: "semantic_related",
      weight: 1,
      supportingSegmentIds: ["segment:1"],
      supportingClaimIds: ["claim:1"],
      rationales: ["Obě teze se týkají zálivky a měření vlhkosti."]
    },
    {
      id: "tensions_with:thought:fixed-watering-seems-sufficient:thought:watering-needs-sensor-feedback",
      from: "thought:fixed-watering-seems-sufficient",
      to: "thought:watering-needs-sensor-feedback",
      type: "tensions_with",
      weight: 1,
      supportingSegmentIds: ["segment:3"],
      supportingClaimIds: ["claim:3"],
      rationales: ["Požadavek zpětné vazby omezuje původní pevný plán."]
    }
  ];
}

function createClaims(): ThoughtClaim[] {
  return [
    {
      id: "claim:1",
      nodeId: "thought:fixed-watering-seems-sufficient",
      canonicalKey: "fixed-watering-seems-sufficient",
      inputId: "segment:1",
      batchId: "batch-0001",
      chronologyIndex: 1,
      time: "2024-01-10T00:00:00.000Z",
      sourceKind: "writing",
      nodeType: "thesis",
      status: "active",
      title: "Pevný plán zálivky obvykle stačí",
      summary: "Pevný plán zálivky obvykle udržuje záhon v dobrém stavu.",
      claim: "Pevný plán obvykle zajistí dostatek vody.",
      rationale: "a",
      relatedCanonicalKeys: ["watering-needs-sensor-feedback"],
      sourceRef: {
        sourceKind: "writing",
        sourcePath: "/input/writings/a.txt",
        documentId: "writing:a",
        documentTitle: "A",
        locator: "paragraph:1",
        sourceItemId: "paragraph:1"
      },
      relationProposals: []
    },
    {
      id: "claim:2",
      nodeId: "thought:fixed-watering-needs-moisture-check",
      canonicalKey: "fixed-watering-needs-moisture-check",
      inputId: "segment:2",
      batchId: "batch-0002",
      chronologyIndex: 2,
      time: "2024-04-30T00:00:00.000Z",
      sourceKind: "writing",
      nodeType: "thesis",
      status: "revised",
      title: "Pevný plán zálivky obvykle stačí",
      summary: "Pevný plán funguje jen při průběžné kontrole vlhkosti.",
      claim: "Pevný plán je vhodný pouze s kontrolou vlhkosti.",
      rationale: "b",
      relatedCanonicalKeys: ["watering-needs-sensor-feedback"],
      sourceRef: {
        sourceKind: "writing",
        sourcePath: "/input/writings/b.txt",
        documentId: "writing:b",
        documentTitle: "B",
        locator: "paragraph:1",
        sourceItemId: "paragraph:1"
      },
      relationProposals: [
        {
          targetCanonicalKey: "fixed-watering-seems-sufficient",
          type: "revises",
          rationale: "Pozdější podmíněná verze opravuje původní pevný plán."
        }
      ]
    },
    {
      id: "claim:3",
      nodeId: "thought:watering-needs-sensor-feedback",
      canonicalKey: "watering-needs-sensor-feedback",
      inputId: "segment:3",
      batchId: "batch-0002",
      chronologyIndex: 3,
      time: "2024-04-30T00:00:00.000Z",
      sourceKind: "writing",
      nodeType: "thesis",
      status: "active",
      title: "Zálivka potřebuje zpětnou vazbu senzoru",
      summary: "Bez zpětné vazby může pevný plán půdu přelévat nebo vysušovat.",
      claim: "Zálivka potřebuje zpětnou vazbu senzoru.",
      rationale: "c",
      relatedCanonicalKeys: ["fixed-watering-seems-sufficient"],
      sourceRef: {
        sourceKind: "writing",
        sourcePath: "/input/writings/c.txt",
        documentId: "writing:c",
        documentTitle: "C",
        locator: "paragraph:1",
        sourceItemId: "paragraph:1"
      },
      relationProposals: [
        {
          targetCanonicalKey: "fixed-watering-seems-sufficient",
          type: "tensions_with",
          rationale: "Požadavek zpětné vazby omezuje původní pevný plán."
        }
      ]
    }
  ];
}

function createStates(): ThoughtNodeState[] {
  return [
    {
      id: "state:fixed-watering-seems-sufficient:1",
      nodeId: "thought:fixed-watering-seems-sufficient",
      stateIndex: 1,
      title: "Pevný plán zálivky obvykle stačí",
      summary: "Pevný plán zálivky obvykle udržuje záhon v dobrém stavu.",
      status: "active",
      validFrom: "2024-01-10T00:00:00.000Z",
      validUntil: null,
      claimIds: ["claim:1"],
      sourceRefs: [],
      transitionType: "introduced",
      revisedByStateId: null
    },
    {
      id: "state:fixed-watering-needs-moisture-check:1",
      nodeId: "thought:fixed-watering-needs-moisture-check",
      stateIndex: 1,
      title: "Pevný plán zálivky obvykle stačí",
      summary: "Pevný plán funguje jen při průběžné kontrole vlhkosti.",
      status: "revised",
      validFrom: "2024-04-30T00:00:00.000Z",
      validUntil: null,
      claimIds: ["claim:2"],
      sourceRefs: [],
      transitionType: "introduced",
      revisedByStateId: null
    },
    {
      id: "state:watering-needs-sensor-feedback:1",
      nodeId: "thought:watering-needs-sensor-feedback",
      stateIndex: 1,
      title: "Zálivka potřebuje zpětnou vazbu senzoru",
      summary: "Bez zpětné vazby může pevný plán půdu přelévat nebo vysušovat.",
      status: "active",
      validFrom: "2024-04-30T00:00:00.000Z",
      validUntil: null,
      claimIds: ["claim:3"],
      sourceRefs: [],
      transitionType: "introduced",
      revisedByStateId: null
    }
  ];
}

function createWorldlines(): ThoughtWorldline[] {
  return [
    {
      id: "worldline:fixed-watering-seems-sufficient",
      nodeId: "thought:fixed-watering-seems-sufficient",
      firstSeen: "2024-01-10T00:00:00.000Z",
      lastSeen: "2024-03-24T00:00:00.000Z",
      currentStateId: "state:fixed-watering-seems-sufficient:1",
      stateIds: ["state:fixed-watering-seems-sufficient:1"],
      claimIds: ["claim:1"],
      invalidatedStateIds: [],
      sourceKinds: ["writing"],
      transitions: []
    },
    {
      id: "worldline:fixed-watering-needs-moisture-check",
      nodeId: "thought:fixed-watering-needs-moisture-check",
      firstSeen: "2024-04-30T00:00:00.000Z",
      lastSeen: "2024-04-30T00:00:00.000Z",
      currentStateId: "state:fixed-watering-needs-moisture-check:1",
      stateIds: ["state:fixed-watering-needs-moisture-check:1"],
      claimIds: ["claim:2"],
      invalidatedStateIds: [],
      sourceKinds: ["writing"],
      transitions: []
    },
    {
      id: "worldline:watering-needs-sensor-feedback",
      nodeId: "thought:watering-needs-sensor-feedback",
      firstSeen: "2024-04-30T00:00:00.000Z",
      lastSeen: "2024-04-30T00:00:00.000Z",
      currentStateId: "state:watering-needs-sensor-feedback:1",
      stateIds: ["state:watering-needs-sensor-feedback:1"],
      claimIds: ["claim:3"],
      invalidatedStateIds: [],
      sourceKinds: ["writing"],
      transitions: []
    }
  ];
}

function createIdentityBlocks(): ThoughtIdentityBlock[] {
  return [
    {
      id: "identity-block:1",
      canonicalKey: "fixed-watering-seems-sufficient",
      nodeType: "thesis",
      candidateKeys: ["fixed-watering-seems-sufficient"],
      titleHints: ["Pevný plán zálivky obvykle stačí"],
      claimIds: ["claim:1"],
      mergeReasons: ["single_candidate"],
      mergeConfidence: "high"
    }
  ];
}

function createGraph(nodes: ThoughtNode[], edges: ThoughtEdge[]): ThoughtGraph {
  return {
    generatedAt: "2026-04-20T00:00:00.000Z",
    runId: "thought-run",
    corpusHash: "synthetic",
    sourceCorpusPath: "/output/normalized/unified/corpus.json",
    batchSize: 16,
    totalBatchCount: 1,
    completedBatchCount: 1,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    claimCount: 3,
    nodeStateCount: 3,
    worldlineCount: 3,
    identityBlockCount: 1,
    nodes,
    edges
  };
}

function createArtifacts(): ThoughtCompilationArtifacts {
  const nodes = createThoughtNodes();
  const edges = createThoughtEdges();

  return {
    claims: createClaims(),
    nodeStates: createStates(),
    worldlines: createWorldlines(),
    identityBlocks: createIdentityBlocks(),
    graph: createGraph(nodes, edges)
  };
}

test("buildThoughtConsolidationArtifacts merges revision families but keeps tension-separated nodes apart", () => {
  const consolidated = buildThoughtConsolidationArtifacts(
    createArtifacts(),
    "/output/compiled/thought_graph.json"
  );

  assert.equal(consolidated.graph.sourceNodeCount, 3);
  assert.equal(consolidated.graph.nodeCount, 2);

  const mergedNode = consolidated.graph.nodes.find((node) =>
    node.memberNodeIds.includes("thought:fixed-watering-seems-sufficient")
  );
  assert.ok(mergedNode);
  assert.deepEqual(mergedNode.memberNodeIds, [
    "thought:fixed-watering-needs-moisture-check",
    "thought:fixed-watering-seems-sufficient"
  ]);
  assert.equal(mergedNode.memberClaimIds.length, 2);
  assert.equal(mergedNode.memberStateIds.length, 2);
  assert.equal(mergedNode.memberWorldlineIds.length, 2);
  assert.equal(mergedNode.consolidationReasons.includes("revision_family"), true);

  const feedbackNode = consolidated.graph.nodes.find((node) =>
    node.memberNodeIds.includes("thought:watering-needs-sensor-feedback")
  );
  assert.ok(feedbackNode);
  assert.equal(feedbackNode.memberNodeIds.length, 1);

  // Tension should survive across consolidated units instead of getting erased
  // by the revision-family merge.
  const tensionEdge = consolidated.graph.edges.find((edge) => edge.type === "tensions_with");
  assert.ok(tensionEdge);
  assert.deepEqual(tensionEdge.supportingSourceNodeIds.sort(), [
    "thought:fixed-watering-seems-sufficient",
    "thought:watering-needs-sensor-feedback"
  ]);

  const revisesEdge = consolidated.graph.edges.find((edge) => edge.type === "revises");
  assert.equal(revisesEdge, undefined);
});

test("sanitizeReciprocalRevisionEdges keeps only the newer-to-older direction", () => {
  const base = buildThoughtConsolidationArtifacts(
    createArtifacts(),
    "/output/compiled/thought_graph.json"
  ).graph;
  const [older, newer] = base.nodes.map((node, index) => ({
    ...node,
    firstSeen: index === 0 ? "2020-01-01T00:00:00.000Z" : "2021-01-01T00:00:00.000Z",
    lastSeen: index === 0 ? "2020-01-01T00:00:00.000Z" : "2021-01-01T00:00:00.000Z"
  }));
  assert.ok(older);
  assert.ok(newer);
  const reciprocalGraph: ConsolidatedThoughtGraph = {
    ...base,
    nodeCount: 2,
    edgeCount: 2,
    nodes: [older, newer],
    edges: [
      {
        id: `revises:${older.id}:${newer.id}`,
        from: older.id,
        to: newer.id,
        type: "revises",
        weight: 1,
        supportingSourceNodeIds: [],
        supportingEdgeIds: [],
        sourceRelationTypes: ["revises"]
      },
      {
        id: `revises:${newer.id}:${older.id}`,
        from: newer.id,
        to: older.id,
        type: "revises",
        weight: 1,
        supportingSourceNodeIds: [],
        supportingEdgeIds: [],
        sourceRelationTypes: ["revises"]
      }
    ]
  };

  const sanitized = sanitizeReciprocalRevisionEdges(reciprocalGraph);

  assert.equal(sanitized.edgeCount, 1);
  assert.equal(sanitized.edges[0]?.from, newer.id);
  assert.equal(sanitized.edges[0]?.to, older.id);
});

test("buildThoughtConsolidationArtifacts keeps stable family ids when an unrelated family is inserted", () => {
  const baseArtifacts = createArtifacts();
  const baseConsolidated = buildThoughtConsolidationArtifacts(
    baseArtifacts,
    "/output/compiled/thought_graph.json"
  );
  const baseMergedNode = baseConsolidated.graph.nodes.find((node) =>
    node.memberNodeIds.includes("thought:fixed-watering-seems-sufficient")
  );
  assert.ok(baseMergedNode);

  const extraNode: ThoughtNode = {
    id: "thought:aaa-unrelated-family",
    canonicalKey: "aaa-unrelated-family",
    nodeType: "theme",
    title: "Nepříbuzná úvodní rodina",
    summary: "Samostatný uzel, který jen posune globální pořadí.",
    status: "active",
    firstSeen: "2024-01-01T00:00:00.000Z",
    lastSeen: "2024-01-01T00:00:00.000Z",
    currentStateId: "state:aaa-unrelated-family:1",
    sourceRefs: [],
    evidence: [],
    relatedNodeIds: [],
    signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
    aliases: ["Nepříbuzná úvodní rodina"]
  };
  const extraClaim: ThoughtClaim = {
    id: "claim:aaa-unrelated-family",
    nodeId: extraNode.id,
    canonicalKey: extraNode.canonicalKey,
    inputId: "segment:0",
    batchId: "batch-0000",
    chronologyIndex: 0,
    time: "2024-01-01T00:00:00.000Z",
    sourceKind: "writing",
    nodeType: extraNode.nodeType,
    status: "active",
    title: extraNode.title,
    summary: extraNode.summary,
    claim: "Nepříbuzná samostatná teze.",
    rationale: "prefix",
    relatedCanonicalKeys: [],
    sourceRef: {
      sourceKind: "writing",
      sourcePath: "/input/writings/prefix.txt",
      documentId: "writing:prefix",
      documentTitle: "Prefix",
      locator: "paragraph:1",
      sourceItemId: "paragraph:1"
    },
    relationProposals: []
  };
  const extraState: ThoughtNodeState = {
    id: "state:aaa-unrelated-family:1",
    nodeId: extraNode.id,
    stateIndex: 1,
    title: extraNode.title,
    summary: extraNode.summary,
    status: "active",
    validFrom: "2024-01-01T00:00:00.000Z",
    validUntil: null,
    claimIds: [extraClaim.id],
    sourceRefs: [],
    transitionType: "introduced",
    revisedByStateId: null
  };
  const extraWorldline: ThoughtWorldline = {
    id: "worldline:aaa-unrelated-family",
    nodeId: extraNode.id,
    firstSeen: "2024-01-01T00:00:00.000Z",
    lastSeen: "2024-01-01T00:00:00.000Z",
    currentStateId: extraState.id,
    stateIds: [extraState.id],
    claimIds: [extraClaim.id],
    invalidatedStateIds: [],
    sourceKinds: ["writing"],
    transitions: []
  };

  const expandedArtifacts: ThoughtCompilationArtifacts = {
    ...baseArtifacts,
    claims: [extraClaim, ...baseArtifacts.claims],
    nodeStates: [extraState, ...baseArtifacts.nodeStates],
    worldlines: [extraWorldline, ...baseArtifacts.worldlines],
    graph: {
      ...baseArtifacts.graph,
      nodeCount: baseArtifacts.graph.nodeCount + 1,
      claimCount: baseArtifacts.graph.claimCount + 1,
      nodeStateCount: baseArtifacts.graph.nodeStateCount + 1,
      worldlineCount: baseArtifacts.graph.worldlineCount + 1,
      nodes: [extraNode, ...baseArtifacts.graph.nodes]
    }
  };

  const expandedConsolidated = buildThoughtConsolidationArtifacts(
    expandedArtifacts,
    "/output/compiled/thought_graph.json"
  );
  const expandedMergedNode = expandedConsolidated.graph.nodes.find((node) =>
    node.memberNodeIds.includes("thought:fixed-watering-seems-sufficient")
  );
  assert.ok(expandedMergedNode);
  assert.equal(expandedMergedNode.id, baseMergedNode.id);
});

test("buildThoughtConsolidationArtifacts keeps lexical false-friend infrastructure nodes separate without shared graph neighborhood", () => {
  const nodes: ThoughtNode[] = [
    {
      id: "thought:sensor-data-layer",
      canonicalKey: "sensor-data-layer",
      nodeType: "thesis",
      title: "Senzorová data jako řídicí infrastruktura",
      summary: "Data ze senzorů koordinují automatickou péči.",
      status: "active",
      firstSeen: "2024-01-01T00:00:00.000Z",
      lastSeen: "2024-01-01T00:00:00.000Z",
      currentStateId: "state:sensor-data-layer:1",
      sourceRefs: [],
      evidence: [],
      relatedNodeIds: [],
      signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
      aliases: ["Senzorová data jako řídicí infrastruktura"]
    },
    {
      id: "thought:shared-sensor-network",
      canonicalKey: "shared-sensor-network",
      nodeType: "thesis",
      title: "Senzorová síť jako sdílená infrastruktura",
      summary: "Senzorová síť má být sdílená a interoperabilní.",
      status: "active",
      firstSeen: "2024-01-02T00:00:00.000Z",
      lastSeen: "2024-01-02T00:00:00.000Z",
      currentStateId: "state:shared-sensor-network:1",
      sourceRefs: [],
      evidence: [],
      relatedNodeIds: [],
      signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
      aliases: ["Senzorová síť jako sdílená infrastruktura"]
    },
    {
      id: "thought:dashboard-bias",
      canonicalKey: "dashboard-bias",
      nodeType: "theme",
      title: "Zkreslení řídicího panelu",
      summary: "Volba panelu může zvýraznit jen část měření.",
      status: "active",
      firstSeen: "2024-01-03T00:00:00.000Z",
      lastSeen: "2024-01-03T00:00:00.000Z",
      currentStateId: "state:dashboard-bias:1",
      sourceRefs: [],
      evidence: [],
      relatedNodeIds: [],
      signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
      aliases: ["Zkreslení řídicího panelu"]
    },
    {
      id: "thought:redundant-sensors",
      canonicalKey: "redundant-sensors",
      nodeType: "thesis",
      title: "Redundantní model senzorové infrastruktury",
      summary: "Měření nemá záviset na jediném čidle.",
      status: "active",
      firstSeen: "2024-01-04T00:00:00.000Z",
      lastSeen: "2024-01-04T00:00:00.000Z",
      currentStateId: "state:redundant-sensors:1",
      sourceRefs: [],
      evidence: [],
      relatedNodeIds: [],
      signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
      aliases: ["Redundantní model senzorové infrastruktury"]
    },
    {
      id: "thought:greenhouse-control-layer",
      canonicalKey: "greenhouse-control-layer",
      nodeType: "thesis",
      title: "Automatizace jako vrstva řízení skleníku",
      summary: "Automatizace propojuje zavlažování, větrání a stínění skleníku.",
      status: "active",
      firstSeen: "2024-01-05T00:00:00.000Z",
      lastSeen: "2024-01-05T00:00:00.000Z",
      currentStateId: "state:greenhouse-control-layer:1",
      sourceRefs: [],
      evidence: [],
      relatedNodeIds: [],
      signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
      aliases: ["Automatizace jako vrstva řízení skleníku"]
    },
    {
      id: "thought:amplifier",
      canonicalKey: "amplifier",
      nodeType: "thesis",
      title: "Automatizace jako podpora, ne nahrazení obsluhy",
      summary: "Automatizace podporuje obsluhu skleníku, ale nenahrazuje její úsudek.",
      status: "active",
      firstSeen: "2024-01-06T00:00:00.000Z",
      lastSeen: "2024-01-06T00:00:00.000Z",
      currentStateId: "state:amplifier:1",
      sourceRefs: [],
      evidence: [],
      relatedNodeIds: [],
      signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
      aliases: ["Automatizace jako podpora, ne nahrazení obsluhy"]
    }
  ];

  const edges: ThoughtEdge[] = [
    {
      id: "semantic_related:1",
      from: "thought:sensor-data-layer",
      to: "thought:shared-sensor-network",
      type: "semantic_related",
      weight: 8,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    },
    {
      id: "supports:1",
      from: "thought:shared-sensor-network",
      to: "thought:sensor-data-layer",
      type: "supports",
      weight: 1,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    },
    {
      id: "semantic_related:2",
      from: "thought:sensor-data-layer",
      to: "thought:dashboard-bias",
      type: "semantic_related",
      weight: 6,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    },
    {
      id: "semantic_related:3",
      from: "thought:shared-sensor-network",
      to: "thought:redundant-sensors",
      type: "semantic_related",
      weight: 7,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    },
    {
      id: "semantic_related:4",
      from: "thought:sensor-data-layer",
      to: "thought:greenhouse-control-layer",
      type: "semantic_related",
      weight: 4,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    },
    {
      id: "semantic_related:5",
      from: "thought:sensor-data-layer",
      to: "thought:amplifier",
      type: "semantic_related",
      weight: 3,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    },
    {
      id: "semantic_related:6",
      from: "thought:greenhouse-control-layer",
      to: "thought:amplifier",
      type: "semantic_related",
      weight: 3,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    }
  ];

  const artifacts: ThoughtCompilationArtifacts = {
    claims: [],
    nodeStates: [],
    worldlines: [],
    identityBlocks: [],
    graph: {
      generatedAt: "2026-04-22T00:00:00.000Z",
      runId: "run-false-friends",
      corpusHash: "synthetic",
      sourceCorpusPath: "/tmp/corpus.json",
      batchSize: 16,
      totalBatchCount: 1,
      completedBatchCount: 1,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      claimCount: 0,
      nodeStateCount: 0,
      worldlineCount: 0,
      identityBlockCount: 0,
      nodes,
      edges
    }
  };

  const consolidated = buildThoughtConsolidationArtifacts(artifacts, "/tmp/thought_graph.json");
  const publicFamily = consolidated.graph.nodes.find((node) =>
    node.memberNodeIds.includes("thought:shared-sensor-network")
  );
  const cognitiveFamily = consolidated.graph.nodes.find((node) =>
    node.memberNodeIds.includes("thought:sensor-data-layer")
  );

  assert.ok(publicFamily);
  assert.ok(cognitiveFamily);
  assert.notEqual(publicFamily?.id, cognitiveFamily?.id);
});

test("buildThoughtConsolidationArtifacts requires stronger family affinity before turning revision edges into one cluster", () => {
  const nodes: ThoughtNode[] = [
    {
      id: "thought:greenhouse-control-layer",
      canonicalKey: "greenhouse-control-layer",
      nodeType: "thesis",
      title: "Automatizace jako další vrstva řízení skleníku",
      summary: "Automatizace rozšiřuje běžné řízení podmínek ve skleníku.",
      status: "active",
      firstSeen: "2024-01-10T00:00:00.000Z",
      lastSeen: "2024-01-10T00:00:00.000Z",
      currentStateId: "state:greenhouse-control-layer:1",
      sourceRefs: [],
      evidence: [],
      relatedNodeIds: [],
      signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
      aliases: ["Automatizace jako další vrstva řízení skleníku"]
    },
    {
      id: "thought:automation-needs-calibration",
      canonicalKey: "automation-needs-calibration",
      nodeType: "thesis",
      title: "Automatická péče jen s pravidelnou kalibrací",
      summary: "Přínos automatiky drží jen tehdy, když jsou senzory kalibrované.",
      status: "revised",
      firstSeen: "2024-05-08T00:00:00.000Z",
      lastSeen: "2024-05-08T00:00:00.000Z",
      currentStateId: "state:automation-needs-calibration:1",
      sourceRefs: [],
      evidence: [],
      relatedNodeIds: [],
      signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
      aliases: ["Automatika funguje jen s kalibrací"]
    },
    {
      id: "thought:shared-sensor-network",
      canonicalKey: "shared-sensor-network",
      nodeType: "thesis",
      title: "Senzorová síť jako sdílená infrastruktura",
      summary: "Měření nemá záviset na jediném uzavřeném čidle.",
      status: "revised",
      firstSeen: "2024-02-05T00:00:00.000Z",
      lastSeen: "2024-02-05T00:00:00.000Z",
      currentStateId: "state:shared-sensor-network:1",
      sourceRefs: [],
      evidence: [],
      relatedNodeIds: [],
      signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
      aliases: ["Senzorová síť jako sdílená infrastruktura"]
    },
    {
      id: "thought:calibration-lags-season",
      canonicalKey: "calibration-lags-season",
      nodeType: "theme",
      title: "Kalibrace nestíhá sezonní změnu",
      summary: "Pevná kalibrace nestačí rychlé změně podmínek.",
      status: "active",
      firstSeen: "2024-03-01T00:00:00.000Z",
      lastSeen: "2024-03-01T00:00:00.000Z",
      currentStateId: "state:calibration-lags-season:1",
      sourceRefs: [],
      evidence: [],
      relatedNodeIds: [],
      signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
      aliases: ["Kalibrace nestíhá sezonní změnu"]
    },
    {
      id: "thought:manual-override",
      canonicalKey: "manual-override",
      nodeType: "theme",
      title: "Ruční převzetí řízení skleníku",
      summary: "Obsluha musí umět automatické řízení bezpečně převzít.",
      status: "active",
      firstSeen: "2024-03-02T00:00:00.000Z",
      lastSeen: "2024-03-02T00:00:00.000Z",
      currentStateId: "state:manual-override:1",
      sourceRefs: [],
      evidence: [],
      relatedNodeIds: [],
      signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
      aliases: ["Ruční převzetí řízení skleníku"]
    },
    {
      id: "thought:redundant-control",
      canonicalKey: "redundant-control",
      nodeType: "thesis",
      title: "Redundantní model řízení skleníku",
      summary: "Řízení skleníku má používat redundantní vstupy místo jediného čidla.",
      status: "active",
      firstSeen: "2024-03-03T00:00:00.000Z",
      lastSeen: "2024-03-03T00:00:00.000Z",
      currentStateId: "state:redundant-control:1",
      sourceRefs: [],
      evidence: [],
      relatedNodeIds: [],
      signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
      aliases: ["Redundantní model řízení skleníku"]
    },
    {
      id: "thought:automation-thresholds",
      canonicalKey: "automation-thresholds",
      nodeType: "thesis",
      title: "Automatizace podle prahů spolehlivosti",
      summary: "Rozsah automatiky závisí na spolehlivosti měření a riziku chyby.",
      status: "active",
      firstSeen: "2024-03-04T00:00:00.000Z",
      lastSeen: "2024-03-04T00:00:00.000Z",
      currentStateId: "state:automation-thresholds:1",
      sourceRefs: [],
      evidence: [],
      relatedNodeIds: [],
      signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
      aliases: ["Automatizace podle prahů spolehlivosti"]
    }
  ];

  const edges: ThoughtEdge[] = [
    {
      id: "revises:automation-needs-calibration:greenhouse-control-layer",
      from: "thought:automation-needs-calibration",
      to: "thought:greenhouse-control-layer",
      type: "revises",
      weight: 1,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    },
    {
      id: "semantic_related:automation-needs-calibration:greenhouse-control-layer",
      from: "thought:automation-needs-calibration",
      to: "thought:greenhouse-control-layer",
      type: "semantic_related",
      weight: 1,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    },
    {
      id: "revises:shared-sensor-network:greenhouse-control-layer",
      from: "thought:shared-sensor-network",
      to: "thought:greenhouse-control-layer",
      type: "revises",
      weight: 1,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    },
    {
      id: "semantic_related:shared-sensor-network:greenhouse-control-layer",
      from: "thought:shared-sensor-network",
      to: "thought:greenhouse-control-layer",
      type: "semantic_related",
      weight: 2,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    },
    {
      id: "semantic_related:greenhouse-control-layer:calibration-lags-season",
      from: "thought:greenhouse-control-layer",
      to: "thought:calibration-lags-season",
      type: "semantic_related",
      weight: 1,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    },
    {
      id: "semantic_related:automation-needs-calibration:calibration-lags-season",
      from: "thought:automation-needs-calibration",
      to: "thought:calibration-lags-season",
      type: "semantic_related",
      weight: 1,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    },
    {
      id: "semantic_related:greenhouse-control-layer:manual-override",
      from: "thought:greenhouse-control-layer",
      to: "thought:manual-override",
      type: "semantic_related",
      weight: 1,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    },
    {
      id: "semantic_related:automation-needs-calibration:manual-override",
      from: "thought:automation-needs-calibration",
      to: "thought:manual-override",
      type: "semantic_related",
      weight: 1,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    },
    {
      id: "semantic_related:greenhouse-control-layer:redundant-control",
      from: "thought:greenhouse-control-layer",
      to: "thought:redundant-control",
      type: "semantic_related",
      weight: 1,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    },
    {
      id: "semantic_related:automation-needs-calibration:redundant-control",
      from: "thought:automation-needs-calibration",
      to: "thought:redundant-control",
      type: "semantic_related",
      weight: 1,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    },
    {
      id: "semantic_related:shared-sensor-network:manual-override",
      from: "thought:shared-sensor-network",
      to: "thought:manual-override",
      type: "semantic_related",
      weight: 1,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    },
    {
      id: "semantic_related:shared-sensor-network:automation-thresholds",
      from: "thought:shared-sensor-network",
      to: "thought:automation-thresholds",
      type: "semantic_related",
      weight: 1,
      supportingSegmentIds: [],
      supportingClaimIds: [],
      rationales: []
    }
  ];

  const artifacts: ThoughtCompilationArtifacts = {
    claims: [],
    nodeStates: [],
    worldlines: [],
    identityBlocks: [],
    graph: {
      generatedAt: "2026-04-22T00:00:00.000Z",
      runId: "run-revision-guard",
      corpusHash: "synthetic",
      sourceCorpusPath: "/tmp/corpus.json",
      batchSize: 16,
      totalBatchCount: 1,
      completedBatchCount: 1,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      claimCount: 0,
      nodeStateCount: 0,
      worldlineCount: 0,
      identityBlockCount: 0,
      nodes,
      edges
    }
  };

  const consolidated = buildThoughtConsolidationArtifacts(artifacts, "/tmp/thought_graph.json");

  const calibrationFamily = consolidated.graph.nodes.find((node) =>
    node.memberNodeIds.includes("thought:automation-needs-calibration")
  );
  assert.ok(calibrationFamily);
  assert.deepEqual(calibrationFamily?.memberNodeIds, [
    "thought:automation-needs-calibration",
    "thought:greenhouse-control-layer"
  ]);

  const sharedSensorFamily = consolidated.graph.nodes.find((node) =>
    node.memberNodeIds.includes("thought:shared-sensor-network")
  );
  assert.ok(sharedSensorFamily);
  assert.equal(sharedSensorFamily?.memberNodeIds.length, 1);
  assert.notEqual(sharedSensorFamily?.id, calibrationFamily?.id);
});
