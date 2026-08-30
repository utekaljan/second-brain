import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { CodexCliClient } from "../codex/client.js";
import type {
  ConsolidatedThoughtGraph,
  ConsolidatedThoughtNode,
  ConsolidationReviewCandidate,
  ConsolidationReviewDecision,
  ThoughtConsolidationAffectedScope,
  ThoughtCompilationArtifacts,
  ThoughtRelationType
} from "./types.js";
import {
  applyConsolidationReviewDecisions,
  buildConsolidationReviewCandidates,
  disambiguateDuplicateNodeTitles,
  refineConsolidatedThoughtGraph
} from "./consolidation_refine.js";
import { buildConsolidationStateArtifacts } from "./consolidation_state.js";

function createNode(options: {
  id: string;
  canonicalKey: string;
  title: string;
  summary?: string;
  nodeType?: ConsolidatedThoughtNode["nodeType"];
  status?: ConsolidatedThoughtNode["status"];
  aliases?: string[];
  frameMemberships?: ConsolidatedThoughtNode["frameMemberships"];
  memberCanonicalKeys?: string[];
  memberNodeIds?: string[];
  memberClaimIds?: string[];
  memberStateIds?: string[];
  currentStateIds?: string[];
  memberWorldlineIds?: string[];
}): ConsolidatedThoughtNode {
  return {
    id: options.id,
    canonicalKey: options.canonicalKey,
    title: options.title,
    summary: options.summary ?? options.title,
    nodeType: options.nodeType ?? "thesis",
    status: options.status ?? "active",
    firstSeen: "2024-01-01T00:00:00.000Z",
    lastSeen: "2024-04-01T00:00:00.000Z",
    sourceRefs: [],
    relatedNodeIds: [],
    aliases: options.aliases ?? [options.title],
    frameMemberships: options.frameMemberships ?? [],
    signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
    memberNodeIds: options.memberNodeIds ?? [options.id.replace("consolidated", "thought")],
    memberCanonicalKeys: options.memberCanonicalKeys ?? [options.canonicalKey],
    memberClaimIds: options.memberClaimIds ?? [`claim:${options.canonicalKey}`],
    memberStateIds: options.memberStateIds ?? [`state:${options.canonicalKey}`],
    currentStateIds: options.currentStateIds ?? [`state:${options.canonicalKey}`],
    memberWorldlineIds: options.memberWorldlineIds ?? [`worldline:${options.canonicalKey}`],
    consolidationReasons: ["single_node"]
  };
}

function createEdge(
  from: string,
  to: string,
  type: ThoughtRelationType,
  weight: number
): ConsolidatedThoughtGraph["edges"][number] {
  return {
    id: `${type}:${from}:${to}`,
    from,
    to,
    type,
    weight,
    supportingSourceNodeIds: [from, to],
    supportingEdgeIds: [`${type}:${from}:${to}`],
    sourceRelationTypes: [type]
  };
}

function createProjectPaths(root: string) {
  const outputDir = path.join(root, "output");
  const stateDir = path.join(outputDir, "state");
  const compiledDir = path.join(outputDir, "compiled");
  const normalizedDir = path.join(outputDir, "normalized");
  const wikiDir = path.join(outputDir, "wiki");
  const exportsDir = path.join(outputDir, "exports");
  const siteDir = path.join(outputDir, "site");

  return {
    root,
    inputDir: path.join(root, "input"),
    conversationsDir: path.join(root, "input", "conversations"),
    writingsDir: path.join(root, "input", "writings"),
    chatsDir: path.join(root, "input", "chats"),
    outputDir,
    normalizedDir,
    compiledDir,
    normalizedConversationsDir: path.join(normalizedDir, "conversations"),
    normalizedWritingsDir: path.join(normalizedDir, "writings"),
    normalizedChatsDir: path.join(normalizedDir, "chats"),
    normalizedUnifiedDir: path.join(normalizedDir, "unified"),
    manifestsDir: path.join(outputDir, "manifests"),
    wikiDir,
    wikiThoughtsDir: path.join(wikiDir, "thoughts"),
    wikiQuestionsDir: path.join(wikiDir, "questions"),
    wikiThesesDir: path.join(wikiDir, "theses"),
    wikiThreadsDir: path.join(wikiDir, "threads"),
    wikiThemesDir: path.join(wikiDir, "themes"),
    wikiTensionsDir: path.join(wikiDir, "tensions"),
    wikiChronologyDir: path.join(wikiDir, "chronology"),
    wikiReferencesDir: path.join(wikiDir, "references"),
    wikiIndexesDir: path.join(wikiDir, "indexes"),
    exportsDir,
    exportsMergedDir: path.join(exportsDir, "merged"),
    exportsGptDir: path.join(exportsDir, "gpt"),
    siteDir,
    siteAssetsDir: path.join(siteDir, "assets"),
    stateDir,
    stateRunsDir: path.join(stateDir, "runs"),
    stateHashesDir: path.join(stateDir, "hashes"),
    stateCheckpointsDir: path.join(stateDir, "checkpoints"),
    stateAuditsDir: path.join(stateDir, "audits")
  };
}

function createResumeArtifacts(root: string): {
  artifacts: ThoughtCompilationArtifacts;
  graph: ConsolidatedThoughtGraph;
} {
  const corpusPath = path.join(root, "output", "normalized", "unified", "corpus.json");
  const nodes = Array.from({ length: 8 }, (_, index) =>
    createNode({
      id: `consolidated:${String(index + 1).padStart(4, "0")}:greenhouse-plan-${index + 1}`,
      canonicalKey: `greenhouse-plan-${index + 1}`,
      title: `Syntetický plán skleníku ${index + 1}`,
      aliases: [`Syntetická varianta plánu skleníku ${index + 1}`],
      memberCanonicalKeys: [`greenhouse-plan-${index + 1}`],
      memberNodeIds: [`thought:greenhouse-plan-${index + 1}`],
      memberClaimIds: [`claim:greenhouse-plan-${index + 1}`],
      memberStateIds: [`state:greenhouse-plan-${index + 1}`],
      currentStateIds: [`state:greenhouse-plan-${index + 1}`],
      memberWorldlineIds: [`worldline:greenhouse-plan-${index + 1}`]
    })
  );

  for (const [index, node] of nodes.entries()) {
    node.sourceRefs = [
      {
        sourceKind: "writing",
        sourcePath: "/tmp/a.txt",
        documentId: "writing:shared-a",
        documentTitle: "Shared A",
        locator: `paragraph:${index + 1}`,
        sourceItemId: `paragraph:${index + 1}`
      },
      {
        sourceKind: "writing",
        sourcePath: "/tmp/b.txt",
        documentId: "writing:shared-b",
        documentTitle: "Shared B",
        locator: `paragraph:${index + 1}`,
        sourceItemId: `paragraph:${index + 1}`
      }
    ];
  }

  const edges = Array.from({ length: 7 }, (_, index) =>
    createEdge(nodes[index]!.id, nodes[index + 1]!.id, "semantic_related", 7)
  );

  const graph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-05-06T00:00:00.000Z",
    sourceRunId: "thought-compiler-test-run",
    sourceGraphPath: path.join(root, "output", "compiled", "thought_graph.json"),
    sourceNodeCount: nodes.length,
    sourceEdgeCount: edges.length,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges
  };

  const claims = nodes.map((node, index) => ({
    id: `claim:greenhouse-plan-${index + 1}`,
    nodeId: `thought:greenhouse-plan-${index + 1}`,
    canonicalKey: `greenhouse-plan-${index + 1}`,
    inputId: `segment:${index + 1}`,
    batchId: "batch-0001",
    chronologyIndex: index + 1,
    time: "2026-05-06T00:00:00.000Z",
    sourceKind: "writing" as const,
    nodeType: "thesis" as const,
    status: "active" as const,
    title: node.title,
    summary: node.summary,
    claim: `Claim ${index + 1}`,
    rationale: `Rationale ${index + 1}`,
    relatedCanonicalKeys: [],
    sourceRef: {
      sourceKind: "writing" as const,
      sourcePath: `/tmp/source-${index + 1}.txt`,
      documentId: `writing:doc-${index + 1}`,
      documentTitle: `Doc ${index + 1}`,
      locator: `paragraph:${index + 1}`,
      sourceItemId: `paragraph:${index + 1}`
    },
    relationProposals: []
  }));

  mkdirSync(path.dirname(corpusPath), { recursive: true });
  writeFileSync(
    corpusPath,
    `${JSON.stringify({
      segments: claims.map((claim, index) => ({
        sourceRef: claim.sourceRef,
        text: `Segment text ${index + 1}`,
        textPreview: `Preview ${index + 1}`
      }))
    })}\n`,
    "utf8"
  );

  return {
    graph,
    artifacts: {
      graph: {
        generatedAt: "2026-05-06T00:00:00.000Z",
        runId: "thought-compiler-test-run",
        corpusHash: "corpus-hash",
        sourceCorpusPath: corpusPath,
        batchSize: 32,
        totalBatchCount: 1,
        completedBatchCount: 1,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        claimCount: claims.length,
        nodeStateCount: 0,
        worldlineCount: 0,
        identityBlockCount: 0,
        nodes: [],
        edges: []
      },
      claims,
      nodeStates: [],
      worldlines: [],
      identityBlocks: []
    }
  };
}

function createIncrementalChangeVariant(root: string): {
  artifacts: ThoughtCompilationArtifacts;
  graph: ConsolidatedThoughtGraph;
} {
  const base = createResumeArtifacts(root);
  const mutatedGraph: ConsolidatedThoughtGraph = {
    ...base.graph,
    generatedAt: "2026-05-06T01:00:00.000Z",
    nodes: base.graph.nodes.map((node) =>
      node.id === "consolidated:0008:greenhouse-plan-8"
        ? {
            ...node,
            title: "Syntetický plán skleníku 8 po měsíčním doplnění",
            aliases: ["Syntetická varianta plánu skleníku 8 po měsíčním doplnění"]
          }
        : node
    )
  };

  const mutatedClaims = base.artifacts.claims.map((claim) =>
    claim.id === "claim:greenhouse-plan-8"
      ? {
          ...claim,
          claim: "Claim 8 after additive monthly update",
          rationale: "Rationale 8 after additive monthly update"
        }
      : claim
  );

  const corpusPath = base.artifacts.graph.sourceCorpusPath;
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
    segments: Array<{
      sourceRef: { documentId: string };
      text: string;
      textPreview: string;
    }>;
  };
  const updatedCorpus = {
    ...corpus,
    segments: corpus.segments.map((segment) =>
      segment.sourceRef.documentId === "writing:doc-8"
        ? {
            ...segment,
            text: "Segment text 8 after additive monthly update",
            textPreview: "Preview 8 after additive monthly update"
          }
        : segment
    )
  };
  writeFileSync(corpusPath, `${JSON.stringify(updatedCorpus)}\n`, "utf8");

  return {
    graph: mutatedGraph,
    artifacts: {
      ...base.artifacts,
      claims: mutatedClaims
    }
  };
}

function writeSegmentIndexArtifact(paths: ReturnType<typeof createProjectPaths>, options: {
  previousCorpusHash: string | null;
  totalPrimarySegmentCount: number;
  unchangedCount: number;
  addedCount: number;
  changedCount?: number;
  removedCount?: number;
}): void {
  const target = path.join(paths.stateDir, "semantic-cache", "source_segment_index.json");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    target,
    `${JSON.stringify({
      version: 3,
      generatedAt: "2026-05-06T02:30:00.000Z",
      corpusHash: "current-corpus",
      documents: {},
      segments: {},
      stats: {
        documentCount: 0,
        segmentCount: options.totalPrimarySegmentCount,
        primarySegmentCount: options.totalPrimarySegmentCount,
        primarySegmentsWithCachedContributions: options.unchangedCount
      },
      diff: {
        previousGeneratedAt: options.previousCorpusHash ? "2026-05-06T01:30:00.000Z" : null,
        previousCorpusHash: options.previousCorpusHash,
        documents: {
          unchangedCount: 0,
          addedCount: 0,
          changedCount: 0,
          removedCount: 0,
          addedDocumentIds: [],
          changedDocumentIds: [],
          removedDocumentIds: []
        },
        primarySegments: {
          unchangedCount: options.unchangedCount,
          addedCount: options.addedCount,
          changedCount: options.changedCount ?? 0,
          removedCount: options.removedCount ?? 0,
          bySourceKind: {
            writing: {
              unchangedCount: options.unchangedCount,
              addedCount: options.addedCount,
              changedCount: options.changedCount ?? 0,
              removedCount: options.removedCount ?? 0
            },
            conversation: {
              unchangedCount: 0,
              addedCount: 0,
              changedCount: 0,
              removedCount: 0
            },
            chat: {
              unchangedCount: 0,
              addedCount: 0,
              changedCount: 0,
              removedCount: 0
            }
          },
          addedSegmentIdsSample: [],
          changedSegmentIdsSample: [],
          removedSegmentIdsSample: []
        }
      }
    }, null, 2)}\n`,
    "utf8"
  );
}

class FakeConsolidationClient {
  readonly calls: string[] = [];
  readonly prompts: string[] = [];
  readonly synthesisClusterIds: string[] = [];

  constructor(
    private readonly failOnceAtBatchId: string | null = null,
    private readonly failedBatches = new Set<string>(),
    private readonly rewriteClusterId: ((clusterId: string, index: number) => string) | null = null
  ) {}

  execSemanticBatch<T>(options: { prompt: string }): { parsed: T } {
    const batchIdMatch = options.prompt.match(/"batchId": "([^"]+)"/);
    assert.ok(batchIdMatch, "batchId missing from prompt");
    const batchId = batchIdMatch[1]!;
    this.calls.push(batchId);
    this.prompts.push(options.prompt);

    if (this.failOnceAtBatchId === batchId && !this.failedBatches.has(batchId)) {
      this.failedBatches.add(batchId);
      throw new Error(`Synthetic stop at ${batchId}`);
    }

    if (batchId.startsWith("review-batch-") || batchId.startsWith("review-pass-")) {
      const caseIds = Array.from(options.prompt.matchAll(/"caseId": "([^"]+)"/g)).map(
        (match) => match[1]!
      );
      return {
        parsed: {
          batchId,
          items: caseIds.map((caseId) => ({
            caseId,
            decision: "keep_separate",
            rationale: `Decision for ${caseId}`
          }))
        } as T
      };
    }

    const clusterIds = Array.from(options.prompt.matchAll(/"clusterId": "([^"]+)"/g)).map(
      (match) => match[1]!
    );
    this.synthesisClusterIds.push(...clusterIds);
    return {
      parsed: {
        batchId,
        items: clusterIds.map((clusterId, index) => ({
          clusterId: this.rewriteClusterId?.(clusterId, index) ?? clusterId,
          title: `Synth ${clusterId}`,
          summary: `Summary ${clusterId}`
        }))
      } as T
    };
  }
}

class FixedPointMergeClient {
  readonly calls: string[] = [];
  private merged = false;

  execSemanticBatch<T>(options: { prompt: string }): { parsed: T } {
    const batchId = options.prompt.match(/"batchId": "([^"]+)"/)?.[1];
    assert.ok(batchId);
    this.calls.push(batchId);
    if (batchId.startsWith("review")) {
      const caseIds = Array.from(options.prompt.matchAll(/"caseId": "([^"]+)"/g)).map(
        (match) => match[1]!
      );
      return {
        parsed: {
          batchId,
          items: caseIds.map((caseId, index) => {
            const merge = batchId.startsWith("review-pass-02") && index === 0 && !this.merged;
            if (merge) this.merged = true;
            return {
              caseId,
              decision: merge ? "merge_family" : "keep_separate",
              rationale: merge
                ? "Syntéza odhalila jednu duplicitní rodinu."
                : "Rodiny zůstávají odlišné."
            };
          })
        } as T
      };
    }
    const clusterIds = Array.from(options.prompt.matchAll(/"clusterId": "([^"]+)"/g)).map(
      (match) => match[1]!
    );
    return {
      parsed: {
        batchId,
        items: clusterIds.map((clusterId) => ({
          clusterId,
          title: `${batchId} ${clusterId}`,
          summary: `${batchId} summary ${clusterId}`
        }))
      } as T
    };
  }
}

test("buildConsolidationReviewCandidates surfaces revision families with blocking overlap", () => {
  const left = createNode({
    id: "consolidated:0001:scheduled-watering",
    canonicalKey: "scheduled-watering",
    title: "Pravidelná zálivka podporuje růst",
    aliases: ["Pevný režim zálivky podporuje růst"]
  });
  const right = createNode({
    id: "consolidated:0002:scheduled-watering-with-moisture-checks",
    canonicalKey: "scheduled-watering-with-moisture-checks",
    title: "Pravidelná zálivka funguje s kontrolou vlhkosti",
    aliases: ["Pevný režim zálivky funguje při kontrole vlhkosti"]
  });

  const graph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-04-21T00:00:00.000Z",
    sourceRunId: "run-1",
    sourceGraphPath: "/tmp/thought_graph.json",
    sourceNodeCount: 2,
    sourceEdgeCount: 3,
    nodeCount: 2,
    edgeCount: 3,
    nodes: [left, right],
    edges: [
      createEdge(left.id, right.id, "revises", 2),
      createEdge(left.id, right.id, "semantic_related", 6),
      createEdge(left.id, right.id, "tensions_with", 1)
    ]
  };

  const candidates = buildConsolidationReviewCandidates(graph);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.reason, "revision_and_blocking_overlap");
});

test("buildConsolidationReviewCandidates skips merely related neighbors without lexical affinity", () => {
  const left = createNode({
    id: "consolidated:0001:irrigation-network",
    canonicalKey: "irrigation-network",
    title: "Skleníkový rozvod závlahy",
    aliases: ["Závlaha vede vodu mezi záhony"]
  });
  const right = createNode({
    id: "consolidated:0002:panel-fragility",
    canonicalKey: "panel-fragility",
    title: "Křehkost skleněných panelů",
    aliases: ["Panely praskají při rychlé změně teploty"]
  });

  left.sourceRefs = [
    {
      sourceKind: "writing",
      sourcePath: "/tmp/a.txt",
      documentId: "writing:a",
      documentTitle: "A",
      locator: "paragraph:1",
      sourceItemId: "paragraph:1"
    }
  ];
  right.sourceRefs = [
    {
      sourceKind: "writing",
      sourcePath: "/tmp/a.txt",
      documentId: "writing:a",
      documentTitle: "A",
      locator: "paragraph:2",
      sourceItemId: "paragraph:2"
    }
  ];

  const graph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-04-21T00:00:00.000Z",
    sourceRunId: "run-1",
    sourceGraphPath: "/tmp/thought_graph.json",
    sourceNodeCount: 2,
    sourceEdgeCount: 1,
    nodeCount: 2,
    edgeCount: 1,
    nodes: [left, right],
    edges: [createEdge(left.id, right.id, "semantic_related", 12)]
  };

  const candidates = buildConsolidationReviewCandidates(graph);
  assert.equal(candidates.length, 0);
});

test("buildConsolidationReviewCandidates surfaces graph-neighborhood families when shared topology also has provenance and wording anchors", () => {
  const left = createNode({
    id: "consolidated:0001:adaptive-irrigation-layer",
    canonicalKey: "adaptive-irrigation-layer",
    title: "Adaptivní zavlažování jako nová vrstva péče",
    aliases: [
      "Adaptivní zálivka jako vrstva péče",
      "Adaptivní zavlažování rozšiřuje péči o skleník"
    ]
  });
  const right = createNode({
    id: "consolidated:0002:irrigation-care-amplifier",
    canonicalKey: "irrigation-care-amplifier",
    title: "Adaptivní zavlažování jako zesílení péče o skleník",
    aliases: [
      "Adaptivní zálivka zesiluje péči o skleník",
      "Adaptivní zavlažování rozšiřuje péči o skleník"
    ]
  });
  const sharedNeighborA = createNode({
    id: "consolidated:0003:moisture-decisions",
    canonicalKey: "moisture-decisions",
    title: "Vlhkost půdy zpřesňuje rozhodování o zálivce"
  });
  const sharedNeighborB = createNode({
    id: "consolidated:0004:garden-tools",
    canonicalKey: "garden-tools",
    title: "Nástroje rozšiřují možnosti péče o zahradu"
  });
  const sharedNeighborC = createNode({
    id: "consolidated:0005:harvest-capacity",
    canonicalKey: "harvest-capacity",
    title: "Pravidelná péče zvyšuje kapacitu sklizně"
  });

  left.sourceRefs = [
    {
      sourceKind: "writing",
      sourcePath: "/tmp/greenhouse-a.txt",
      documentId: "writing:greenhouse-a",
      documentTitle: "Synthetic greenhouse A",
      locator: "paragraph:1",
      sourceItemId: "paragraph:1"
    },
    {
      sourceKind: "writing",
      sourcePath: "/tmp/greenhouse-b.txt",
      documentId: "writing:greenhouse-b",
      documentTitle: "Synthetic greenhouse B",
      locator: "paragraph:1",
      sourceItemId: "paragraph:1"
    }
  ];
  right.sourceRefs = [
    {
      sourceKind: "writing",
      sourcePath: "/tmp/greenhouse-a.txt",
      documentId: "writing:greenhouse-a",
      documentTitle: "Synthetic greenhouse A",
      locator: "paragraph:2",
      sourceItemId: "paragraph:2"
    },
    {
      sourceKind: "writing",
      sourcePath: "/tmp/greenhouse-b.txt",
      documentId: "writing:greenhouse-b",
      documentTitle: "Synthetic greenhouse B",
      locator: "paragraph:2",
      sourceItemId: "paragraph:2"
    }
  ];

  const graph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-04-21T00:00:00.000Z",
    sourceRunId: "run-1",
    sourceGraphPath: "/tmp/thought_graph.json",
    sourceNodeCount: 5,
    sourceEdgeCount: 8,
    nodeCount: 5,
    edgeCount: 8,
    nodes: [left, right, sharedNeighborA, sharedNeighborB, sharedNeighborC],
    edges: [
      createEdge(left.id, right.id, "semantic_related", 3),
      createEdge(left.id, sharedNeighborA.id, "semantic_related", 4),
      createEdge(right.id, sharedNeighborA.id, "supports", 3),
      createEdge(left.id, sharedNeighborB.id, "supports", 2),
      createEdge(right.id, sharedNeighborB.id, "semantic_related", 2),
      createEdge(left.id, sharedNeighborC.id, "semantic_related", 2),
      createEdge(right.id, sharedNeighborC.id, "semantic_related", 2),
      createEdge(sharedNeighborA.id, sharedNeighborB.id, "semantic_related", 1)
    ]
  };

  const candidates = buildConsolidationReviewCandidates(graph);
  const target = candidates.find(
    (candidate) =>
      candidate.leftNodeId === left.id && candidate.rightNodeId === right.id
  );
  assert.ok(target);
  assert.equal(target.reason, "same_source_family_review");
  assert.equal(target.sharedPositiveNeighborCount, 3);
  assert.ok(target.positiveNeighborJaccard >= 0.35);
});

test("buildConsolidationReviewCandidates skips graph-neighborhood siblings without a visible family anchor", () => {
  const left = createNode({
    id: "consolidated:0001:drip-irrigation-network",
    canonicalKey: "drip-irrigation-network",
    title: "Síť kapkové závlahy ve skleníku",
    aliases: ["Rozvody vody mezi záhony"]
  });
  const right = createNode({
    id: "consolidated:0002:thermometer-calibration",
    canonicalKey: "thermometer-calibration",
    title: "Kalibrace optického teploměru",
    aliases: ["Senzor teploty vyžaduje referenční bod"]
  });
  const sharedA = createNode({
    id: "consolidated:0003:distributed-valves",
    canonicalKey: "distributed-valves",
    title: "Rozdělené ventily pro jednotlivé záhony"
  });
  const sharedB = createNode({
    id: "consolidated:0004:manual-override",
    canonicalKey: "manual-override",
    title: "Ruční přepnutí automatické zálivky"
  });
  const sharedC = createNode({
    id: "consolidated:0005:pump-response-lag",
    canonicalKey: "pump-response-lag",
    title: "Čerpadlo reaguje na změnu tlaku se zpožděním"
  });

  left.sourceRefs = [
    {
      sourceKind: "writing",
      sourcePath: "/tmp/infra.txt",
      documentId: "writing:infra",
      documentTitle: "Infra",
      locator: "paragraph:1",
      sourceItemId: "paragraph:1"
    },
    {
      sourceKind: "writing",
      sourcePath: "/tmp/mixed.txt",
      documentId: "writing:mixed",
      documentTitle: "Mixed",
      locator: "paragraph:1",
      sourceItemId: "paragraph:1"
    }
  ];
  right.sourceRefs = [
    {
      sourceKind: "writing",
      sourcePath: "/tmp/power.txt",
      documentId: "writing:power",
      documentTitle: "Power",
      locator: "paragraph:1",
      sourceItemId: "paragraph:1"
    },
    {
      sourceKind: "writing",
      sourcePath: "/tmp/mixed.txt",
      documentId: "writing:mixed",
      documentTitle: "Mixed",
      locator: "paragraph:2",
      sourceItemId: "paragraph:2"
    }
  ];

  const graph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-04-21T00:00:00.000Z",
    sourceRunId: "run-1",
    sourceGraphPath: "/tmp/thought_graph.json",
    sourceNodeCount: 5,
    sourceEdgeCount: 7,
    nodeCount: 5,
    edgeCount: 7,
    nodes: [left, right, sharedA, sharedB, sharedC],
    edges: [
      createEdge(left.id, right.id, "semantic_related", 7),
      createEdge(left.id, sharedA.id, "semantic_related", 3),
      createEdge(right.id, sharedA.id, "semantic_related", 3),
      createEdge(left.id, sharedB.id, "supports", 2),
      createEdge(right.id, sharedB.id, "semantic_related", 2),
      createEdge(left.id, sharedC.id, "semantic_related", 2),
      createEdge(right.id, sharedC.id, "supports", 2)
    ]
  };

  const candidates = buildConsolidationReviewCandidates(graph);
  const target = candidates.find(
    (candidate) => candidate.leftNodeId === left.id && candidate.rightNodeId === right.id
  );
  assert.equal(target, undefined);
});

test("buildConsolidationReviewCandidates keeps same-family refinements in review", () => {
  const left = createNode({
    id: "consolidated:0001:drip-irrigation-network",
    canonicalKey: "drip-irrigation-network",
    title: "Kapková závlaha jako síť skleníku",
    aliases: ["Skleník používá síť kapkové závlahy"]
  });
  const right = createNode({
    id: "consolidated:0002:not-just-a-timer",
    canonicalKey: "not-just-a-timer",
    title: "Časovač není celá kapková závlaha skleníku",
    aliases: ["Nestačí jen časovat síť kapkové závlahy"]
  });
  const sharedA = createNode({
    id: "consolidated:0003:distributed-valves",
    canonicalKey: "distributed-valves",
    title: "Rozdělené ventily pro jednotlivé záhony"
  });
  const sharedB = createNode({
    id: "consolidated:0004:moisture-thresholds",
    canonicalKey: "moisture-thresholds",
    title: "Spuštění zálivky podle prahů vlhkosti"
  });
  const sharedC = createNode({
    id: "consolidated:0005:pump-response-lag",
    canonicalKey: "pump-response-lag",
    title: "Čerpadlo reaguje na změnu tlaku se zpožděním"
  });

  left.sourceRefs = [
    {
      sourceKind: "writing",
      sourcePath: "/tmp/infra-a.txt",
      documentId: "writing:infra-a",
      documentTitle: "Infra A",
      locator: "paragraph:1",
      sourceItemId: "paragraph:1"
    },
    {
      sourceKind: "writing",
      sourcePath: "/tmp/infra-b.txt",
      documentId: "writing:infra-b",
      documentTitle: "Infra B",
      locator: "paragraph:1",
      sourceItemId: "paragraph:1"
    }
  ];
  right.sourceRefs = [
    {
      sourceKind: "writing",
      sourcePath: "/tmp/infra-a.txt",
      documentId: "writing:infra-a",
      documentTitle: "Infra A",
      locator: "paragraph:2",
      sourceItemId: "paragraph:2"
    },
    {
      sourceKind: "writing",
      sourcePath: "/tmp/infra-b.txt",
      documentId: "writing:infra-b",
      documentTitle: "Infra B",
      locator: "paragraph:2",
      sourceItemId: "paragraph:2"
    }
  ];

  const graph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-04-21T00:00:00.000Z",
    sourceRunId: "run-1",
    sourceGraphPath: "/tmp/thought_graph.json",
    sourceNodeCount: 5,
    sourceEdgeCount: 7,
    nodeCount: 5,
    edgeCount: 7,
    nodes: [left, right, sharedA, sharedB, sharedC],
    edges: [
      createEdge(left.id, right.id, "semantic_related", 7),
      createEdge(left.id, sharedA.id, "semantic_related", 3),
      createEdge(right.id, sharedA.id, "supports", 2),
      createEdge(left.id, sharedB.id, "semantic_related", 2),
      createEdge(right.id, sharedB.id, "semantic_related", 2),
      createEdge(left.id, sharedC.id, "semantic_related", 2),
      createEdge(right.id, sharedC.id, "semantic_related", 2)
    ]
  };

  const candidates = buildConsolidationReviewCandidates(graph);
  const target = candidates.find(
    (candidate) => candidate.leftNodeId === left.id && candidate.rightNodeId === right.id
  );
  assert.ok(target);
  assert.equal(target.reason, "strong_related_family_review");
});

test("buildConsolidationReviewCandidates surfaces duplicate synthesized titles without a direct edge", () => {
  const left = createNode({
    id: "consolidated:0001:fixed-watering-window",
    canonicalKey: "fixed-watering-window",
    title: "Zálivka ve stejném časovém okně",
    nodeType: "tension"
  });
  const right = createNode({
    id: "consolidated:0002:weather-adjusted-window",
    canonicalKey: "weather-adjusted-window",
    title: "Zálivka ve stejném časovém okně",
    nodeType: "theme"
  });
  for (const [index, node] of [left, right].entries()) {
    node.sourceRefs = [{
      sourceKind: "writing",
      sourcePath: "/tmp/synthetic-watering-schedule.txt",
      documentId: "writing:synthetic-watering-schedule",
      documentTitle: "Synthetic watering schedule",
      locator: `paragraph:${index + 1}`,
      sourceItemId: `paragraph:${index + 1}`
    }];
  }
  const graph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-07-11T00:00:00.000Z",
    sourceRunId: "run-1",
    sourceGraphPath: "/tmp/thought_graph.json",
    sourceNodeCount: 2,
    sourceEdgeCount: 0,
    nodeCount: 2,
    edgeCount: 0,
    nodes: [left, right],
    edges: []
  };

  const candidates = buildConsolidationReviewCandidates(graph);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.reason, "duplicate_title_review");
  assert.equal(candidates[0]?.titleScore, 1);
});

test("buildConsolidationReviewCandidates surfaces duplicate summaries across documents", () => {
  const sharedSummary =
    "Senzor muze vykazovat pomaly posun nuly, proto se jeho mereni pravidelne porovnava s pevnym referencnim bodem.";
  const left = createNode({
    id: "consolidated:0001:sensor-zero-drift",
    canonicalKey: "sensor-zero-drift",
    title: "Posun nuly u senzoru",
    summary: sharedSummary
  });
  const right = createNode({
    id: "consolidated:0002:reference-point-check",
    canonicalKey: "reference-point-check",
    title: "Kontrola referenčního bodu",
    summary: sharedSummary
  });
  left.sourceRefs = [{
    sourceKind: "writing",
    sourcePath: "/tmp/a.txt",
    documentId: "writing:a",
    documentTitle: "A",
    locator: "paragraph:1",
    sourceItemId: "paragraph:1"
  }];
  right.sourceRefs = [{
    sourceKind: "writing",
    sourcePath: "/tmp/b.txt",
    documentId: "writing:b",
    documentTitle: "B",
    locator: "paragraph:1",
    sourceItemId: "paragraph:1"
  }];
  const graph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-07-13T00:00:00.000Z",
    sourceRunId: "run-1",
    sourceGraphPath: "/tmp/thought_graph.json",
    sourceNodeCount: 2,
    sourceEdgeCount: 0,
    nodeCount: 2,
    edgeCount: 0,
    nodes: [left, right],
    edges: []
  };

  const candidates = buildConsolidationReviewCandidates(graph);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.reason, "duplicate_summary_review");
  assert.equal(candidates[0]?.summaryScore, 1);
  const refined = applyConsolidationReviewDecisions(
    graph,
    [{
      caseId: candidates[0]!.caseId,
      decision: "merge_family",
      rationale: "Jde o stejne tvrzeni formulovane pod jinymi nazvy."
    }],
    candidates
  );
  assert.equal(refined.nodeCount, 1);
});

test("buildConsolidationReviewCandidates surfaces near titles in one source for the same node type", () => {
  const left = createNode({
    id: "consolidated:0001:reference-reading-drift",
    canonicalKey: "reference-reading-drift",
    title: "Odchylka referenčního měření",
    nodeType: "thread"
  });
  const right = createNode({
    id: "consolidated:0002:reference-reading-drift-trace",
    canonicalKey: "reference-reading-drift-trace",
    title: "Odchylka referenčního měření senzoru",
    nodeType: "thread"
  });
  for (const [index, node] of [left, right].entries()) {
    node.sourceRefs = [{
      sourceKind: "writing",
      sourcePath: "/tmp/synthetic-sensor-calibration.txt",
      documentId: "writing:synthetic-sensor-calibration",
      documentTitle: "Synthetic sensor calibration",
      locator: `paragraph:${index + 1}`,
      sourceItemId: `paragraph:${index + 1}`
    }];
  }
  const graph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-07-11T00:00:00.000Z",
    sourceRunId: "run-1",
    sourceGraphPath: "/tmp/thought_graph.json",
    sourceNodeCount: 2,
    sourceEdgeCount: 0,
    nodeCount: 2,
    edgeCount: 0,
    nodes: [left, right],
    edges: []
  };

  const candidates = buildConsolidationReviewCandidates(graph);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.reason, "same_source_title_review");
  assert.ok((candidates[0]?.titleScore ?? 0) >= 0.55);
});

test("buildConsolidationReviewCandidates does not connect title-only pairs across unrelated sources", () => {
  const left = createNode({
    id: "consolidated:0001:calibration-a",
    canonicalKey: "calibration-a",
    title: "Senzor potřebuje kalibraci"
  });
  const right = createNode({
    id: "consolidated:0002:calibration-b",
    canonicalKey: "calibration-b",
    title: "Senzor potřebuje kalibraci"
  });
  left.sourceRefs = [{
    sourceKind: "writing",
    sourcePath: "/tmp/a.txt",
    documentId: "writing:a",
    documentTitle: "A",
    locator: "paragraph:1",
    sourceItemId: "paragraph:1"
  }];
  right.sourceRefs = [{
    sourceKind: "writing",
    sourcePath: "/tmp/b.txt",
    documentId: "writing:b",
    documentTitle: "B",
    locator: "paragraph:1",
    sourceItemId: "paragraph:1"
  }];
  const graph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-07-11T00:00:00.000Z",
    sourceRunId: "run-1",
    sourceGraphPath: "/tmp/thought_graph.json",
    sourceNodeCount: 2,
    sourceEdgeCount: 0,
    nodeCount: 2,
    edgeCount: 0,
    nodes: [left, right],
    edges: []
  };

  assert.equal(buildConsolidationReviewCandidates(graph).length, 0);
});

test("buildConsolidationReviewCandidates preserves blocking relations for duplicate titles", () => {
  const left = createNode({
    id: "consolidated:0001:watering-window-thesis",
    canonicalKey: "watering-window-thesis",
    title: "Zálivka ve stejném časovém okně"
  });
  const right = createNode({
    id: "consolidated:0002:watering-window-counterpoint",
    canonicalKey: "watering-window-counterpoint",
    title: "Zálivka ve stejném časovém okně"
  });
  for (const [index, node] of [left, right].entries()) {
    node.sourceRefs = [{
      sourceKind: "writing",
      sourcePath: "/tmp/synthetic-watering-window.txt",
      documentId: "writing:synthetic-watering-window",
      documentTitle: "Synthetic watering window",
      locator: `paragraph:${index + 1}`,
      sourceItemId: `paragraph:${index + 1}`
    }];
  }
  const graph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-07-11T00:00:00.000Z",
    sourceRunId: "run-1",
    sourceGraphPath: "/tmp/thought_graph.json",
    sourceNodeCount: 2,
    sourceEdgeCount: 1,
    nodeCount: 2,
    edgeCount: 1,
    nodes: [left, right],
    edges: [createEdge(left.id, right.id, "tensions_with", 1)]
  };

  assert.equal(buildConsolidationReviewCandidates(graph).length, 0);
});

test("disambiguateDuplicateNodeTitles reuses a concise alias without merging identities", () => {
  const broad = createNode({
    id: "consolidated:0001:fixed-watering-window",
    canonicalKey: "fixed-watering-window",
    title: "Zálivka ve stejném časovém okně",
    nodeType: "tension",
    aliases: ["Zálivka ve stejném časovém okně", "Pevná zálivka podle ranního okna"],
    memberNodeIds: ["thought:fixed-watering-window", "thought:shared-watering-window"]
  });
  const narrow = createNode({
    id: "consolidated:0002:moisture-adjusted-window",
    canonicalKey: "moisture-adjusted-window",
    title: "Zálivka ve stejném časovém okně",
    nodeType: "theme",
    aliases: [
      "Zálivka ve stejném časovém okně",
      "Zálivka podle vlhkosti půdy",
      "Zálivka podle naměřené vlhkosti půdy šetří vodu lépe než neměnný ranní časový plán."
    ]
  });
  const graph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-07-11T00:00:00.000Z",
    sourceRunId: "run-1",
    sourceGraphPath: "/tmp/thought_graph.json",
    sourceNodeCount: 3,
    sourceEdgeCount: 0,
    nodeCount: 2,
    edgeCount: 0,
    nodes: [broad, narrow],
    edges: []
  };

  const refined = disambiguateDuplicateNodeTitles(graph);
  assert.equal(refined.nodeCount, 2);
  assert.equal(refined.nodes.find((node) => node.id === broad.id)?.title, broad.title);
  assert.equal(
    refined.nodes.find((node) => node.id === narrow.id)?.title,
    "Zálivka podle vlhkosti půdy"
  );
  assert.ok(
    refined.nodes
      .find((node) => node.id === narrow.id)
      ?.consolidationReasons.includes("duplicate_title_disambiguation")
  );
});

test("disambiguateDuplicateNodeTitles distinguishes cross-type near titles inside one source", () => {
  const thesis = createNode({
    id: "consolidated:0001:reference-point-calibration",
    canonicalKey: "reference-point-calibration",
    title: "Kalibrace senzoru a referenční bod",
    nodeType: "thesis"
  });
  const theme = createNode({
    id: "consolidated:0002:calibration-reference-point",
    canonicalKey: "calibration-reference-point",
    title: "Referenční bod a kalibrace senzoru",
    nodeType: "theme",
    aliases: ["Drift je hlubší problém než jednorázový šum"]
  });
  for (const [index, node] of [thesis, theme].entries()) {
    node.sourceRefs = [{
      sourceKind: "writing",
      sourcePath: "/tmp/synthetic-sensor-reference.txt",
      documentId: "writing:synthetic-sensor-reference",
      documentTitle: "Synthetic sensor reference",
      locator: `paragraph:${index + 1}`,
      sourceItemId: `paragraph:${index + 1}`
    }];
  }
  const graph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-07-11T00:00:00.000Z",
    sourceRunId: "run-1",
    sourceGraphPath: "/tmp/thought_graph.json",
    sourceNodeCount: 2,
    sourceEdgeCount: 0,
    nodeCount: 2,
    edgeCount: 0,
    nodes: [thesis, theme],
    edges: []
  };

  const refined = disambiguateDuplicateNodeTitles(graph);
  assert.equal(refined.nodes.find((node) => node.id === thesis.id)?.title, thesis.title);
  assert.equal(
    refined.nodes.find((node) => node.id === theme.id)?.title,
    "Drift je hlubší problém než jednorázový šum"
  );
  assert.ok(
    refined.nodes
      .find((node) => node.id === theme.id)
      ?.consolidationReasons.includes("title_collision_disambiguation")
  );
});

test("applyConsolidationReviewDecisions merges reviewed families and preserves aggregated provenance", () => {
  const left = createNode({
    id: "consolidated:0001:scheduled-watering",
    canonicalKey: "scheduled-watering",
    title: "Pravidelná zálivka podporuje růst",
    memberNodeIds: ["thought:scheduled-watering"],
    memberCanonicalKeys: ["scheduled-watering"],
    memberClaimIds: ["claim:scheduled-watering"],
    memberStateIds: ["state:scheduled-watering"],
    memberWorldlineIds: ["worldline:scheduled-watering"],
    frameMemberships: [
      {
        documentId: "writing:synthetic-fixed-watering",
        frameId: "frame:writing:synthetic-fixed-watering:01",
        frameLabel: "Pevný plán zálivky jako výchozí režim",
        subframeId: null,
        subframeLabel: null,
        frameRole: "main_claim",
        occurrenceCount: 1
      }
    ]
  });
  const right = createNode({
    id: "consolidated:0002:scheduled-watering-with-moisture-checks",
    canonicalKey: "scheduled-watering-with-moisture-checks",
    title: "Pravidelná zálivka s kontrolou vlhkosti",
    memberNodeIds: ["thought:scheduled-watering-with-moisture-checks"],
    memberCanonicalKeys: ["scheduled-watering-with-moisture-checks"],
    memberClaimIds: ["claim:scheduled-watering-with-moisture-checks"],
    memberStateIds: ["state:scheduled-watering-with-moisture-checks"],
    memberWorldlineIds: ["worldline:scheduled-watering-with-moisture-checks"],
    frameMemberships: [
      {
        documentId: "writing:synthetic-moisture-aware-watering",
        frameId: "frame:writing:synthetic-moisture-aware-watering:02",
        frameLabel: "Kontrola vlhkosti jako revize pevného plánu",
        subframeId: null,
        subframeLabel: null,
        frameRole: "revision_branch",
        occurrenceCount: 1
      }
    ]
  });
  const third = createNode({
    id: "consolidated:0003:pump-failure-risk",
    canonicalKey: "pump-failure-risk",
    title: "Porucha čerpadla přeruší zálivku",
    nodeType: "tension",
    memberNodeIds: ["thought:pump-failure-risk"],
    memberCanonicalKeys: ["pump-failure-risk"],
    memberClaimIds: ["claim:pump-failure-risk"],
    memberStateIds: ["state:pump-failure-risk"],
    memberWorldlineIds: ["worldline:pump-failure-risk"]
  });

  const graph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-04-21T00:00:00.000Z",
    sourceRunId: "run-1",
    sourceGraphPath: "/tmp/thought_graph.json",
    sourceNodeCount: 3,
    sourceEdgeCount: 2,
    nodeCount: 3,
    edgeCount: 2,
    nodes: [left, right, third],
    edges: [
      createEdge(left.id, right.id, "revises", 2),
      createEdge(left.id, third.id, "tensions_with", 1)
    ]
  };

  const decisions: ConsolidationReviewDecision[] = [
    {
      caseId: `review|${left.id}|${right.id}`,
      decision: "merge_family",
      rationale: "Jde o jednu rodinu plánování zálivky s pozdějším zpřesněním."
    }
  ];

  const refined = applyConsolidationReviewDecisions(graph, decisions);
  assert.equal(refined.nodeCount, 2);
  const merged = refined.nodes.find((node) =>
    node.memberCanonicalKeys.includes("scheduled-watering-with-moisture-checks")
  );
  assert.ok(merged);
  assert.deepEqual(
    merged?.memberCanonicalKeys.sort((leftValue, rightValue) => leftValue.localeCompare(rightValue)),
    ["scheduled-watering", "scheduled-watering-with-moisture-checks"]
  );
  assert.ok(merged?.consolidationReasons.includes("llm_review_merge"));
  assert.equal(merged?.frameMemberships?.length, 2);
  assert.ok(
    merged?.frameMemberships?.some(
      (membership) =>
        membership.documentId === "writing:synthetic-fixed-watering" &&
        membership.frameRole === "main_claim"
    )
  );
  assert.ok(
    merged?.frameMemberships?.some(
      (membership) =>
        membership.documentId === "writing:synthetic-moisture-aware-watering" &&
        membership.frameRole === "revision_branch"
    )
  );
  assert.ok(refined.edges.some((edge) => edge.type === "tensions_with"));
});

test("applyConsolidationReviewDecisions rejects graph-neighborhood merges without a user-facing lexical anchor", () => {
  const left = createNode({
    id: "consolidated:0001:moisture-aware-watering",
    canonicalKey: "moisture-aware-watering",
    title: "Pravidelná zálivka s kontrolou vlhkosti",
    aliases: ["Zálivka se koriguje podle vlhkosti půdy"]
  });
  const right = createNode({
    id: "consolidated:0002:thermometer-calibration",
    canonicalKey: "thermometer-calibration",
    title: "Kalibrace optického teploměru",
    aliases: ["Teplotní senzor se porovnává s referenčním bodem"]
  });

  const graph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-04-21T00:00:00.000Z",
    sourceRunId: "run-1",
    sourceGraphPath: "/tmp/thought_graph.json",
    sourceNodeCount: 2,
    sourceEdgeCount: 1,
    nodeCount: 2,
    edgeCount: 1,
    nodes: [left, right],
    edges: [createEdge(left.id, right.id, "semantic_related", 8)]
  };

  const decisions: ConsolidationReviewDecision[] = [
    {
      caseId: `review|${left.id}|${right.id}`,
      decision: "merge_family",
      rationale: "Silně souvisejí v jednom provozním grafu."
    }
  ];
  const candidates: ConsolidationReviewCandidate[] = [
    {
      caseId: `review|${left.id}|${right.id}`,
      leftNodeId: left.id,
      rightNodeId: right.id,
      leftTitle: left.title,
      rightTitle: right.title,
      leftCanonicalKeys: left.memberCanonicalKeys,
      rightCanonicalKeys: right.memberCanonicalKeys,
      leftNodeType: left.nodeType,
      rightNodeType: right.nodeType,
      leftAliases: left.aliases,
      rightAliases: right.aliases,
      leftDocumentIds: ["writing:synthetic-moisture-aware-watering"],
      rightDocumentIds: ["writing:synthetic-thermometer-calibration"],
      sharedDocumentIds: [],
      sharedDocumentOverlapRatio: 0,
      titleScore: 0.05,
      aliasScore: 0.04,
      canonicalScore: 0.19,
      semanticWeight: 8,
      revisionWeight: 0,
      blockingWeight: 0,
      sharedPositiveNeighborCount: 5,
      positiveNeighborJaccard: 0.5,
      reason: "graph_neighborhood_family_review"
    }
  ];

  const refined = applyConsolidationReviewDecisions(graph, decisions, candidates);
  assert.equal(refined.nodeCount, 2);
});

test("applyConsolidationReviewDecisions accepts graph-neighborhood merges when lexical phrasing also lines up", () => {
  const left = createNode({
    id: "consolidated:0001:measurement-without-drift",
    canonicalKey: "measurement-without-drift",
    title: "Měření bez kalibračního posunu",
    aliases: ["Měření bez systematické chyby"]
  });
  const right = createNode({
    id: "consolidated:0002:sensor-drift-correction",
    canonicalKey: "sensor-drift-correction",
    title: "Korekce systematické chyby senzoru",
    aliases: ["Měření bez systematické kalibrační chyby"]
  });

  const graph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-04-21T00:00:00.000Z",
    sourceRunId: "run-1",
    sourceGraphPath: "/tmp/thought_graph.json",
    sourceNodeCount: 2,
    sourceEdgeCount: 1,
    nodeCount: 2,
    edgeCount: 1,
    nodes: [left, right],
    edges: [createEdge(left.id, right.id, "semantic_related", 6)]
  };

  const decisions: ConsolidationReviewDecision[] = [
    {
      caseId: `review|${left.id}|${right.id}`,
      decision: "merge_family",
      rationale: "Jde o stejnou rodinu měření bez systematické chyby."
    }
  ];
  const candidates: ConsolidationReviewCandidate[] = [
    {
      caseId: `review|${left.id}|${right.id}`,
      leftNodeId: left.id,
      rightNodeId: right.id,
      leftTitle: left.title,
      rightTitle: right.title,
      leftCanonicalKeys: left.memberCanonicalKeys,
      rightCanonicalKeys: right.memberCanonicalKeys,
      leftNodeType: left.nodeType,
      rightNodeType: right.nodeType,
      leftAliases: left.aliases,
      rightAliases: right.aliases,
      leftDocumentIds: [
        "writing:synthetic-sensor-calibration",
        "writing:synthetic-drift-correction"
      ],
      rightDocumentIds: [
        "writing:synthetic-sensor-calibration",
        "writing:synthetic-drift-correction"
      ],
      sharedDocumentIds: [
        "writing:synthetic-sensor-calibration",
        "writing:synthetic-drift-correction"
      ],
      sharedDocumentOverlapRatio: 1,
      titleScore: 0.04,
      aliasScore: 0.14,
      canonicalScore: 0,
      semanticWeight: 6,
      revisionWeight: 0,
      blockingWeight: 0,
      sharedPositiveNeighborCount: 4,
      positiveNeighborJaccard: 0.5,
      reason: "graph_neighborhood_family_review"
    }
  ];

  const refined = applyConsolidationReviewDecisions(graph, decisions, candidates);
  assert.equal(refined.nodeCount, 1);
});

test("refineConsolidatedThoughtGraph resumes from persisted review and synthesis checkpoints", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "second-brain-consolidation-resume-"));
  const paths = createProjectPaths(root);
  const { artifacts, graph } = createResumeArtifacts(root);

  const failingClient = new FakeConsolidationClient("synthesis-batch-0002");
  assert.throws(() =>
    refineConsolidatedThoughtGraph({
      paths,
      artifacts,
      consolidated: { graph },
      client: failingClient as unknown as CodexCliClient,
      model: "gpt-5.4",
      reasoningEffort: "medium"
    })
  );

  assert.deepEqual(failingClient.calls, [
    "review-batch-0001",
    "review-batch-0002",
    "synthesis-batch-0001",
    "synthesis-batch-0002"
  ]);

  const checkpointPath = path.join(paths.stateCheckpointsDir, "thought-consolidation.json");
  const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as {
    runId: string;
    status: string;
    completedReviewBatchIds: string[];
    completedSynthesisBatchIds: string[];
  };
  assert.equal(checkpoint.status, "failed");
  assert.deepEqual(checkpoint.completedReviewBatchIds, [
    "review-batch-0001",
    "review-batch-0002"
  ]);
  assert.deepEqual(checkpoint.completedSynthesisBatchIds, ["synthesis-batch-0001"]);

  const reviewDecisionsPath = path.join(
    paths.stateRunsDir,
    checkpoint.runId,
    "consolidation",
    "consolidation_review_decisions.partial.json"
  );
  const synthesisPath = path.join(
    paths.stateRunsDir,
    checkpoint.runId,
    "consolidation",
    "consolidation_synthesis.partial.json"
  );
  assert.equal(
    (JSON.parse(readFileSync(reviewDecisionsPath, "utf8")) as ConsolidationReviewDecision[]).length,
    7
  );
  assert.equal(
    (JSON.parse(readFileSync(synthesisPath, "utf8")) as Array<{ clusterId: string }>).length,
    6
  );

  const resumeClient = new FakeConsolidationClient();
  const rebuiltDeterministicGraph: ConsolidatedThoughtGraph = {
    ...graph,
    generatedAt: "2026-05-06T00:10:00.000Z"
  };
  const refined = refineConsolidatedThoughtGraph({
    paths,
    artifacts,
    consolidated: { graph: rebuiltDeterministicGraph },
    client: resumeClient as unknown as CodexCliClient,
    model: "gpt-5.4",
    reasoningEffort: "medium"
  });

  assert.deepEqual(resumeClient.calls, [
    "synthesis-batch-0002",
    "review-pass-02-batch-0001",
    "review-pass-02-batch-0002"
  ]);
  assert.equal(refined.reviewDecisions?.length, 7);
  assert.equal(refined.synthesis?.length, 8);
  assert.equal(refined.graph.nodes.every((node) => node.title.startsWith("Synth ")), true);

  const completedCheckpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as {
    status: string;
    completedSynthesisBatchIds: string[];
  };
  assert.equal(completedCheckpoint.status, "completed");
  assert.deepEqual(completedCheckpoint.completedSynthesisBatchIds, [
    "synthesis-batch-0001",
    "synthesis-batch-0002"
  ]);

  const completedReuseClient = new FakeConsolidationClient();
  const completedReuseGraph: ConsolidatedThoughtGraph = {
    ...graph,
    generatedAt: "2026-05-06T00:20:00.000Z"
  };
  const reused = refineConsolidatedThoughtGraph({
    paths,
    artifacts,
    consolidated: { graph: completedReuseGraph },
    client: completedReuseClient as unknown as CodexCliClient,
    model: "gpt-5.4",
    reasoningEffort: "medium"
  });

  assert.deepEqual(completedReuseClient.calls, []);
  assert.equal(reused.reviewDecisions?.length, 7);
  assert.equal(reused.synthesis?.length, 8);
});

test("refineConsolidatedThoughtGraph merges a duplicate exposed only after synthesis", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "second-brain-consolidation-fixed-point-"));
  const paths = createProjectPaths(root);
  const { artifacts, graph } = createResumeArtifacts(root);
  const client = new FixedPointMergeClient();

  const refined = refineConsolidatedThoughtGraph({
    paths,
    artifacts,
    consolidated: { graph },
    client: client as unknown as CodexCliClient,
    model: "gpt-5.5",
    reasoningEffort: "high",
    forceNewRun: true
  });

  assert.equal(refined.graph.nodeCount, graph.nodeCount - 1);
  assert.equal(client.calls.some((call) => call.startsWith("synthesis-pass-02")), true);
  assert.equal(client.calls.some((call) => call.startsWith("review-pass-03")), true);
  const checkpoint = JSON.parse(readFileSync(
    path.join(paths.stateCheckpointsDir, "thought-consolidation.json"),
    "utf8"
  )) as { status: string; reviewPassCount: number; fixedPointReached: boolean };
  assert.equal(checkpoint.status, "completed");
  assert.equal(checkpoint.reviewPassCount, 3);
  assert.equal(checkpoint.fixedPointReached, true);
});

test("refineConsolidatedThoughtGraph sends readable titles in stable lexical synthesis batches", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "second-brain-consolidation-titles-"));
  const paths = createProjectPaths(root);
  const { artifacts, graph } = createResumeArtifacts(root);
  const client = new FakeConsolidationClient();

  refineConsolidatedThoughtGraph({
    paths,
    artifacts,
    consolidated: {
      graph: {
        ...graph,
        nodes: graph.nodes.slice().reverse()
      }
    },
    client: client as unknown as CodexCliClient,
    model: "gpt-5.4",
    reasoningEffort: "medium",
    forceNewRun: true
  });

  const synthesisPrompt = client.prompts.find((prompt) => prompt.includes('"clusterId"'));
  assert.ok(synthesisPrompt);
  assert.match(synthesisPrompt, /Nevytvářej dvě prakticky totožná summary/);
  assert.match(synthesisPrompt, /vlastní rozlišující jádro/);
  const payload = JSON.parse(synthesisPrompt.split("Batch payload:\n")[1]!) as {
    items: Array<{
      clusterId: string;
      sourceDocumentIds: string[];
      memberTitles: string[];
      memberCanonicalKeys: string[];
    }>;
  };
  assert.equal(payload.items[0]?.clusterId, "consolidated:0001:greenhouse-plan-1");
  assert.deepEqual(payload.items[0]?.sourceDocumentIds, ["writing:shared-a", "writing:shared-b"]);
  assert.equal(payload.items[0]?.memberTitles[0], "Syntetický plán skleníku 1");
  assert.deepEqual(payload.items[0]?.memberCanonicalKeys, ["greenhouse-plan-1"]);
});

test("refineConsolidatedThoughtGraph resumes an unfinished force-new run", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "second-brain-consolidation-force-resume-"));
  const paths = createProjectPaths(root);
  const { artifacts, graph } = createResumeArtifacts(root);
  const failingClient = new FakeConsolidationClient("synthesis-batch-0002");

  assert.throws(() =>
    refineConsolidatedThoughtGraph({
      paths,
      artifacts,
      consolidated: { graph },
      client: failingClient as unknown as CodexCliClient,
      model: "gpt-5.4",
      reasoningEffort: "medium",
      forceNewRun: true
    })
  );
  const failedCheckpoint = JSON.parse(
    readFileSync(path.join(paths.stateCheckpointsDir, "thought-consolidation.json"), "utf8")
  ) as { runId: string };

  const resumeClient = new FakeConsolidationClient();
  refineConsolidatedThoughtGraph({
    paths,
    artifacts,
    consolidated: { graph },
    client: resumeClient as unknown as CodexCliClient,
    model: "gpt-5.4",
    reasoningEffort: "medium",
    forceNewRun: true
  });

  assert.deepEqual(resumeClient.calls, [
    "synthesis-batch-0002",
    "review-pass-02-batch-0001",
    "review-pass-02-batch-0002"
  ]);
  const completedCheckpoint = JSON.parse(
    readFileSync(path.join(paths.stateCheckpointsDir, "thought-consolidation.json"), "utf8")
  ) as { runId: string; status: string };
  assert.equal(completedCheckpoint.runId, failedCheckpoint.runId);
  assert.equal(completedCheckpoint.status, "completed");
});

test("refineConsolidatedThoughtGraph does not reuse a completed checkpoint when model changes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "second-brain-consolidation-model-mismatch-"));
  const paths = createProjectPaths(root);
  const { artifacts, graph } = createResumeArtifacts(root);

  const firstClient = new FakeConsolidationClient();
  refineConsolidatedThoughtGraph({
    paths,
    artifacts,
    consolidated: { graph },
    client: firstClient as unknown as CodexCliClient,
    model: "gpt-5.4",
    reasoningEffort: "medium"
  });

  const checkpointPath = path.join(paths.stateCheckpointsDir, "thought-consolidation.json");
  const firstCheckpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as {
    runId: string;
    status: string;
  };
  assert.equal(firstCheckpoint.status, "completed");
  assert.equal(firstClient.calls.length > 0, true);

  const secondClient = new FakeConsolidationClient();
  refineConsolidatedThoughtGraph({
    paths,
    artifacts,
    consolidated: { graph },
    client: secondClient as unknown as CodexCliClient,
    model: "gpt-5.5",
    reasoningEffort: "high"
  });

  const secondCheckpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as {
    runId: string;
    status: string;
    model: string;
    reasoningEffort: string;
  };
  assert.equal(secondCheckpoint.status, "completed");
  assert.notEqual(secondCheckpoint.runId, firstCheckpoint.runId);
  assert.equal(secondCheckpoint.model, "gpt-5.5");
  assert.equal(secondCheckpoint.reasoningEffort, "high");
  assert.equal(secondClient.calls.length > 0, true);
});

test("refineConsolidatedThoughtGraph reuses unchanged review and synthesis work across a changed graph", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "second-brain-consolidation-incremental-reuse-"));
  const paths = createProjectPaths(root);
  const base = createResumeArtifacts(root);

  const firstClient = new FakeConsolidationClient();
  const first = refineConsolidatedThoughtGraph({
    paths,
    artifacts: base.artifacts,
    consolidated: { graph: base.graph },
    client: firstClient as unknown as CodexCliClient,
    model: "gpt-5.4",
    reasoningEffort: "medium"
  });
  assert.deepEqual(firstClient.calls, [
    "review-batch-0001",
    "review-batch-0002",
    "synthesis-batch-0001",
    "synthesis-batch-0002",
    "review-pass-02-batch-0001",
    "review-pass-02-batch-0002"
  ]);
  assert.deepEqual(first.incremental, {
    mode: "incremental",
    reviewCandidateCount: 7,
    reusedReviewDecisionCount: 0,
    generatedReviewDecisionCount: 7,
    synthesisClusterCount: 8,
    reusedSynthesisCount: 0,
    generatedSynthesisCount: 8
  });

  const variant = createIncrementalChangeVariant(root);
  writeSegmentIndexArtifact(paths, {
    previousCorpusHash: "previous-corpus",
    totalPrimarySegmentCount: 8,
    unchangedCount: 7,
    addedCount: 1
  });
  const secondClient = new FakeConsolidationClient();
  const second = refineConsolidatedThoughtGraph({
    paths,
    artifacts: variant.artifacts,
    consolidated: { graph: variant.graph },
    client: secondClient as unknown as CodexCliClient,
    model: "gpt-5.4",
    reasoningEffort: "medium"
  });

  assert.equal(secondClient.calls.length, 3);
  assert.equal(secondClient.calls.some((call) => call.startsWith("review-batch-")), true);
  assert.equal(secondClient.calls.some((call) => call.startsWith("synthesis-batch-")), true);
  assert.deepEqual(second.incremental, {
    mode: "incremental",
    reviewCandidateCount: 7,
    reusedReviewDecisionCount: 6,
    generatedReviewDecisionCount: 1,
    synthesisClusterCount: 8,
    reusedSynthesisCount: 7,
    generatedSynthesisCount: 1
  });
  assert.equal(second.diagnostics?.recommendation.broaderConsolidationRerunRecommended, false);
  assert.equal(second.diagnostics?.recommendation.severity, "none");
  assert.equal(
    existsSync(path.join(paths.stateAuditsDir, "consolidation_diagnostics.json")),
    true
  );
  assert.equal(
    existsSync(path.join(paths.stateAuditsDir, "consolidation_diagnostics.md")),
    true
  );
});

test("refineConsolidatedThoughtGraph skips synthesis prompts for unaffected families with prior phrasing", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "second-brain-consolidation-affected-synthesis-"));
  const paths = createProjectPaths(root);
  const { artifacts, graph } = createResumeArtifacts(root);
  const previousState = buildConsolidationStateArtifacts({
    graph,
    segmentIndex: null
  });
  const affectedFamilyId = graph.nodes[7]!.id;
  const reusedFamilyIds = graph.nodes.slice(0, 7).map((node) => node.id);
  const affectedScope: ThoughtConsolidationAffectedScope = {
    version: 1,
    generatedAt: "2026-05-06T03:00:00.000Z",
    mode: "incremental",
    sourceRunId: graph.sourceRunId,
    previousSourceRunId: graph.sourceRunId,
    previousFamilyCount: graph.nodeCount,
    currentFamilyCount: graph.nodeCount,
    localRecomputeFamilyIds: [affectedFamilyId],
    affectedFamilyIds: [affectedFamilyId],
    reviewScopeFamilyIds: [affectedFamilyId],
    synthesisScopeFamilyIds: [affectedFamilyId],
    dependencyExpandedClosureFamilyIds: [affectedFamilyId],
    reusedFamilyIds,
    addedFamilyIds: [],
    removedFamilyIds: [],
    changedFamilyIds: [affectedFamilyId],
    neighborExpandedFamilyIds: [],
    affectedEdgeIds: [],
    invalidatedReviewCaseIds: [],
    invalidatedSynthesisFamilyIds: [affectedFamilyId],
    broaderPathUsed: true,
    fallbackMode: "global_deterministic",
    fallbackReasons: [],
    stats: {
      localRecomputeFamilyCount: 1,
      localRecomputeFamilyShare: 1 / graph.nodeCount,
      affectedFamilyCount: 1,
      reusedFamilyCount: reusedFamilyIds.length,
      affectedFamilyShare: 1 / graph.nodeCount,
      reviewScopeFamilyCount: 1,
      synthesisScopeFamilyCount: 1,
      dependencyExpandedClosureFamilyCount: 1,
      dependencyExpandedClosureShare: 1 / graph.nodeCount,
      affectedEdgeCount: 0,
      invalidatedReviewCaseCount: 0,
      invalidatedSynthesisCount: 1
    }
  };

  const client = new FakeConsolidationClient();
  const refined = refineConsolidatedThoughtGraph({
    paths,
    artifacts,
    consolidated: { graph },
    client: client as unknown as CodexCliClient,
    affectedScope,
    previousFamilyIndex: previousState.familyIndex,
    model: "gpt-5.4",
    reasoningEffort: "medium"
  });

  assert.deepEqual(client.synthesisClusterIds, [affectedFamilyId]);
  assert.equal(refined.incremental?.reusedSynthesisCount, 7);
  assert.equal(refined.incremental?.generatedSynthesisCount, 1);
  assert.equal(refined.graph.nodes[0]?.title, previousState.familyIndex.families[0]?.title);
  assert.equal(refined.graph.nodes[7]?.title, `Synth ${affectedFamilyId}`);
});

test("refineConsolidatedThoughtGraph reviews only affected ambiguity cases", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "second-brain-consolidation-affected-review-"));
  const paths = createProjectPaths(root);
  const { artifacts, graph } = createResumeArtifacts(root);
  const previousState = buildConsolidationStateArtifacts({
    graph,
    segmentIndex: null
  });
  const allCandidates = buildConsolidationReviewCandidates(graph);
  const affectedFamilyId = allCandidates[0]!.leftNodeId;
  const expectedCandidates = allCandidates.filter(
    (candidate) =>
      candidate.leftNodeId === affectedFamilyId || candidate.rightNodeId === affectedFamilyId
  );
  const reusedFamilyIds = graph.nodes
    .map((node) => node.id)
    .filter((familyId) => familyId !== affectedFamilyId);
  const affectedScope: ThoughtConsolidationAffectedScope = {
    version: 1,
    generatedAt: "2026-05-06T03:10:00.000Z",
    mode: "incremental",
    sourceRunId: graph.sourceRunId,
    previousSourceRunId: graph.sourceRunId,
    previousFamilyCount: graph.nodeCount,
    currentFamilyCount: graph.nodeCount,
    localRecomputeFamilyIds: [affectedFamilyId],
    affectedFamilyIds: [affectedFamilyId],
    reviewScopeFamilyIds: [affectedFamilyId],
    synthesisScopeFamilyIds: [affectedFamilyId],
    dependencyExpandedClosureFamilyIds: [affectedFamilyId],
    reusedFamilyIds,
    addedFamilyIds: [],
    removedFamilyIds: [],
    changedFamilyIds: [affectedFamilyId],
    neighborExpandedFamilyIds: [],
    affectedEdgeIds: [],
    invalidatedReviewCaseIds: [],
    invalidatedSynthesisFamilyIds: [affectedFamilyId],
    broaderPathUsed: false,
    fallbackMode: "none",
    fallbackReasons: [],
    stats: {
      localRecomputeFamilyCount: 1,
      localRecomputeFamilyShare: 1 / graph.nodeCount,
      affectedFamilyCount: 1,
      reusedFamilyCount: reusedFamilyIds.length,
      affectedFamilyShare: 1 / graph.nodeCount,
      reviewScopeFamilyCount: 1,
      synthesisScopeFamilyCount: 1,
      dependencyExpandedClosureFamilyCount: 1,
      dependencyExpandedClosureShare: 1 / graph.nodeCount,
      affectedEdgeCount: 0,
      invalidatedReviewCaseCount: 0,
      invalidatedSynthesisCount: 1
    }
  };

  const client = new FakeConsolidationClient();
  const refined = refineConsolidatedThoughtGraph({
    paths,
    artifacts,
    consolidated: { graph },
    client: client as unknown as CodexCliClient,
    affectedScope,
    previousFamilyIndex: previousState.familyIndex,
    model: "gpt-5.4",
    reasoningEffort: "medium"
  });

  assert.equal(refined.reviewCandidates?.length, expectedCandidates.length);
  assert.equal(
    refined.reviewCandidates?.every(
      (candidate) =>
        candidate.leftNodeId === affectedFamilyId || candidate.rightNodeId === affectedFamilyId
    ),
    true
  );
  assert.equal(refined.incremental?.generatedReviewDecisionCount, expectedCandidates.length);
  assert.deepEqual(client.synthesisClusterIds, [affectedFamilyId]);
});

test("refineConsolidatedThoughtGraph recommends a consolidation-only rerun when generated synthesis share is high", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "second-brain-consolidation-drift-"));
  const paths = createProjectPaths(root);
  const { artifacts, graph } = createResumeArtifacts(root);
  writeSegmentIndexArtifact(paths, {
    previousCorpusHash: "previous-corpus",
    totalPrimarySegmentCount: 8,
    unchangedCount: 5,
    addedCount: 3
  });

  const client = new FakeConsolidationClient();
  const refined = refineConsolidatedThoughtGraph({
    paths,
    artifacts,
    consolidated: { graph },
    client: client as unknown as CodexCliClient,
    model: "gpt-5.4",
    reasoningEffort: "medium"
  });

  assert.equal(refined.diagnostics?.reuse.generatedSynthesisShare, 1);
  assert.equal(refined.diagnostics?.recommendation.broaderConsolidationRerunRecommended, true);
  assert.equal(refined.diagnostics?.recommendation.severity, "recommend");
});

test("refineConsolidatedThoughtGraph forceNewRun bypasses incremental reuse caches", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "second-brain-consolidation-force-rerun-"));
  const paths = createProjectPaths(root);
  const { artifacts, graph } = createResumeArtifacts(root);

  const firstClient = new FakeConsolidationClient();
  refineConsolidatedThoughtGraph({
    paths,
    artifacts,
    consolidated: { graph },
    client: firstClient as unknown as CodexCliClient,
    model: "gpt-5.4",
    reasoningEffort: "medium"
  });

  const rerunClient = new FakeConsolidationClient();
  const rerun = refineConsolidatedThoughtGraph({
    paths,
    artifacts,
    consolidated: { graph: { ...graph, generatedAt: "2026-05-06T02:00:00.000Z" } },
    client: rerunClient as unknown as CodexCliClient,
    model: "gpt-5.4",
    reasoningEffort: "medium",
    forceNewRun: true
  });

  assert.deepEqual(rerunClient.calls, [
    "review-batch-0001",
    "review-batch-0002",
    "synthesis-batch-0001",
    "synthesis-batch-0002",
    "review-pass-02-batch-0001",
    "review-pass-02-batch-0002"
  ]);
  assert.deepEqual(rerun.incremental, {
    mode: "force_new_run",
    reviewCandidateCount: 7,
    reusedReviewDecisionCount: 0,
    generatedReviewDecisionCount: 7,
    synthesisClusterCount: 8,
    reusedSynthesisCount: 0,
    generatedSynthesisCount: 8
  });
});

test("refineConsolidatedThoughtGraph preserves a stable family id when synthesis rewrites its readable suffix", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "second-brain-consolidation-diacritics-"));
  const paths = createProjectPaths(root);
  const corpusPath = path.join(root, "output", "normalized", "unified", "corpus.json");
  mkdirSync(path.dirname(corpusPath), { recursive: true });
  writeFileSync(
    corpusPath,
    `${JSON.stringify({
      segments: [
        {
          sourceRef: {
            sourceKind: "writing",
            sourcePath: "/tmp/source.txt",
            documentId: "writing:test",
            documentTitle: "Test",
            locator: "paragraph:1",
            sourceItemId: "paragraph:1"
          },
          text: "Segment text",
          textPreview: "Segment text"
        }
      ]
    })}\n`,
    "utf8"
  );

  const graph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-05-07T00:00:00.000Z",
    sourceRunId: "thought-compiler-test-run",
    sourceGraphPath: path.join(root, "output", "compiled", "thought_graph.json"),
    sourceNodeCount: 1,
    sourceEdgeCount: 0,
    nodeCount: 1,
    edgeCount: 0,
    nodes: [
      createNode({
        id: "consolidated:0042:sensor-reading-drifts-between-calibrations",
        canonicalKey: "sensor-reading-drifts-between-calibrations",
        title: "Měření senzoru se mezi kalibracemi pomalu posouvá",
        aliases: ["Mereni senzoru se mezi kalibracemi pomalu posouva"],
        memberCanonicalKeys: ["sensor-reading-drifts-between-calibrations"],
        memberNodeIds: ["thought:0042"],
        memberClaimIds: ["claim:0042"],
        memberStateIds: ["state:0042"],
        currentStateIds: ["state:0042"],
        memberWorldlineIds: ["worldline:0042"]
      })
    ],
    edges: []
  };

  const artifacts: ThoughtCompilationArtifacts = {
    graph: {
      generatedAt: "2026-05-07T00:00:00.000Z",
      runId: "thought-compiler-test-run",
      corpusHash: "corpus-hash",
      sourceCorpusPath: corpusPath,
      batchSize: 32,
      totalBatchCount: 1,
      completedBatchCount: 1,
      nodeCount: 1,
      edgeCount: 0,
      claimCount: 1,
      nodeStateCount: 0,
      worldlineCount: 0,
      identityBlockCount: 0,
      nodes: [],
      edges: []
    },
    claims: [
      {
        id: "claim:0042",
        nodeId: "thought:0042",
        canonicalKey: "sensor-reading-drifts-between-calibrations",
        inputId: "segment:1",
        batchId: "batch-0001",
        chronologyIndex: 1,
        time: "2026-05-07T00:00:00.000Z",
        sourceKind: "writing",
        nodeType: "thesis",
        status: "active",
        title: "Měření senzoru se mezi kalibracemi pomalu posouvá",
        summary: "Syntetické shrnutí driftu senzoru.",
        claim: "Senzor může mezi kalibracemi vykazovat pomalý posun.",
        rationale: "Syntetický segment popisuje měřitelný drift.",
        relatedCanonicalKeys: [],
        sourceRef: {
          sourceKind: "writing",
          sourcePath: "/tmp/source.txt",
          documentId: "writing:test",
          documentTitle: "Test",
          locator: "paragraph:1",
          sourceItemId: "paragraph:1"
        },
        relationProposals: []
      }
    ],
    nodeStates: [],
    worldlines: [],
    identityBlocks: []
  };

  const client = new FakeConsolidationClient(
    null,
    new Set<string>(),
    (clusterId, index) =>
      index === 0
        ? `${clusterId.split(":").slice(0, 2).join(":")}:novy prirozeny titulek`
        : clusterId
  );
  const refined = refineConsolidatedThoughtGraph({
    paths,
    artifacts,
    consolidated: { graph },
    client: client as unknown as CodexCliClient,
    model: "gpt-5.4",
    reasoningEffort: "medium"
  });

  assert.equal(refined.synthesis?.[0]?.clusterId, graph.nodes[0]?.id);
  assert.equal(refined.graph.nodes[0]?.id, graph.nodes[0]?.id);
  assert.equal(refined.graph.nodes[0]?.title.startsWith("Synth "), true);
});
