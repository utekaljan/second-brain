import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { CodexCliClient } from "../codex/client.js";
import type { ConsolidatedThoughtGraph, ConsolidatedThoughtNode } from "../compiler/types.js";
import { getProjectPaths } from "../system/paths.js";
import type { MacroNodeAssessment } from "./macro_map.js";
import { computeConsolidatedGraphSemanticHash } from "./artifact_identity.js";
import {
  acceptedHighSalienceOmissions,
  applyAtlasDisplayOverrides,
  buildScaledThoughtMacroMap,
  maxAllowedConstellationMembers,
  prepareScaledMacroMapIncrementalReuse,
  selectMacroAtlasRepresentatives,
  validateMembershipBatch,
  validateSavedCoverageSubset
} from "./macro_map_scaled.js";

class IncrementalMacroClient {
  readonly calls: Array<"atlas" | "membership" | "trajectory"> = [];

  constructor(private readonly initialNodeIds: string[]) {}

  execSemanticBatch<T>(options: { prompt: string }): { parsed: T } {
    if (options.prompt.startsWith("Navrhuješ globální atlas")) {
      this.calls.push("atlas");
      return {
        parsed: {
          atlasTitle: "Testovací atlas",
          atlasSummary: "Stabilní atlas pro inkrementální regresi.",
          constellations: Array.from({ length: 8 }, (_, index) => ({
            key: `oblast-${index + 1}`,
            title: `Oblast ${index + 1}`,
            summary: `Souhrn oblasti ${index + 1}`,
            rationale: `Důvod oblasti ${index + 1}`,
            trajectoryHint: `Vývoj oblasti ${index + 1}`,
            atlasRole: index < 2 ? "core_direction" : "active_exploration",
            confidence: 0.9,
            uncertainty: "Testovací nejistota",
            seedNodeIds: this.initialNodeIds.slice(index * 3, index * 3 + 3)
          }))
        } as T
      };
    }

    if (options.prompt.startsWith("Přiřaď dávku uzlů")) {
      this.calls.push("membership");
      const payload = JSON.parse(options.prompt.split("NODES\n")[1]!) as {
        batchId: string;
        nodes: Array<{ id: string }>;
      };
      return {
        parsed: {
          batchId: payload.batchId,
          items: payload.nodes.map((item) => {
            const number = Number(item.id.split(":")[1] ?? "1");
            return {
              nodeId: item.id,
              memberships: [{
                constellationKey: `oblast-${((number - 1) % 8) + 1}`,
                role: "supporting",
                currentPosition: true,
                openQuestion: false,
                tension: false
              }],
              omissionReason: "mapped",
              rationale: "Inkrementální testovací přiřazení"
            };
          })
        } as T
      };
    }

    this.calls.push("trajectory");
    const payload = JSON.parse(options.prompt.split("MAKRO MAPA\n")[1]!) as {
      constellations: Array<{
        id: string;
        members: Array<{ id: string; currentPosition: boolean }>;
      }>;
    };
    const chosen = payload.constellations.slice(0, 2);
    return {
      parsed: {
        trajectories: chosen.map((constellation, index) => ({
          key: `vyvoj-${index + 1}`,
          title: `Vývoj ${index + 1}`,
          summary: `Vývojová testovací linie ${index + 1}`,
          constellationIds: [constellation.id],
          stages: constellation.members.slice(0, 2).map((member, stageIndex) => ({
            label: `Fáze ${stageIndex + 1}`,
            summary: `Popis fáze ${stageIndex + 1}`,
            nodeIds: [member.id],
            startDate: null,
            endDate: null
          })),
          currentPositionNodeIds: [constellation.members[0]!.id],
          openTensionNodeIds: [],
          confidence: 0.8,
          uncertainty: "Testovací pořadí"
        }))
      } as T
    };
  }
}

test("constellation size guard preserves the small-graph cap and scales for large graphs", () => {
  assert.equal(maxAllowedConstellationMembers(2_955), 900);
  assert.equal(maxAllowedConstellationMembers(9_927), 2_482);
});

function node(id: string, documentId: string): ConsolidatedThoughtNode {
  return {
    id,
    canonicalKey: id,
    title: id,
    summary: id,
    nodeType: "thesis",
    status: "active",
    firstSeen: null,
    lastSeen: null,
    sourceRefs: [{
      sourceKind: "conversation",
      sourcePath: `/tmp/${documentId}`,
      documentId,
      documentTitle: documentId,
      locator: "test",
      sourceItemId: id
    }],
    relatedNodeIds: [],
    aliases: [],
    signalBySourceKind: { writing: 0, conversation: 1, chat: 0 },
    memberNodeIds: [id],
    memberCanonicalKeys: [id],
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
    sourceRunId: "scaled-test",
    sourceGraphPath: "/tmp/graph.json",
    sourceNodeCount: nodes.length,
    sourceEdgeCount: 0,
    nodeCount: nodes.length,
    edgeCount: 0,
    nodes,
    edges: []
  };
}

function assessment(options: {
  nodeId: string;
  documentId: string;
  authority?: MacroNodeAssessment["sourceAuthority"];
  salience?: number;
}): MacroNodeAssessment {
  const authority = options.authority ?? "conversation";
  return {
    nodeId: options.nodeId,
    title: options.nodeId,
    nodeType: "thesis",
    status: "active",
    sourceAuthority: authority,
    salienceScore: options.salience ?? 50,
    salienceFactors: {
      authority: 50,
      crossDocument: 0,
      recurrence: 20,
      graphCentrality: 0,
      semanticRole: 100
    },
    documentIds: [options.documentId],
    writingDocumentIds: authority === "authored" || authority === "mixed"
      ? [options.documentId]
      : [],
    conversationDocumentIds: authority === "conversation" || authority === "mixed"
      ? [options.documentId]
      : [],
    chatDocumentIds: []
  };
}

test("representative atlas stays bounded and resists one dominant document at 3000 nodes", () => {
  const nodes: ConsolidatedThoughtNode[] = [];
  const assessments: MacroNodeAssessment[] = [];
  for (let index = 0; index < 3_000; index += 1) {
    const documentId = index < 2_700 ? "conversation:dominant" : `conversation:minor-${index % 100}`;
    const nodeId = `node-${String(index).padStart(4, "0")}`;
    nodes.push(node(nodeId, documentId));
    assessments.push(assessment({
      nodeId,
      documentId,
      authority: index < 40 ? "authored" : "conversation",
      salience: index < 80 ? 80 : 50
    }));
  }

  const selected = selectMacroAtlasRepresentatives({
    graph: graph(nodes),
    assessments,
    limit: 360,
    perDocument: 2,
    minimumDocumentNodeCount: 3
  });
  const selectedIds = new Set(selected.map((item) => item.nodeId));
  const selectedDocuments = new Set(selected.flatMap((item) => item.documentIds));

  assert.equal(selected.length, 360);
  for (let index = 0; index < 40; index += 1) {
    assert.ok(selectedIds.has(`node-${String(index).padStart(4, "0")}`));
  }
  assert.ok(selectedDocuments.size >= 90);
  assert.ok(selected.filter((item) => item.documentIds[0] === "conversation:dominant").length < 100);
});

test("representative atlas never exceeds its cap when high-salience supply is larger", () => {
  const nodes = Array.from({ length: 500 }, (_, index) => node(`node-${index}`, "conversation:one"));
  const assessments = nodes.map((item) => assessment({
    nodeId: item.id,
    documentId: "conversation:one",
    salience: 90
  }));

  const selected = selectMacroAtlasRepresentatives({
    graph: graph(nodes),
    assessments,
    limit: 100
  });

  assert.equal(selected.length, 100);
});

test("membership validation requires exact batch coverage and coherent omissions", () => {
  const valid = validateMembershipBatch({
    raw: {
      batchId: "membership-batch-0001",
      items: [{
        nodeId: "a",
        memberships: [{
          constellationKey: "mind",
          role: "supporting",
          currentPosition: false,
          openQuestion: false,
          tension: false
        }],
        omissionReason: "mapped",
        rationale: "Relevant"
      }, {
        nodeId: "b",
        memberships: [],
        omissionReason: "local_detail",
        rationale: "Too local"
      }]
    },
    batchId: "membership-batch-0001",
    expectedNodeIds: ["a", "b"],
    constellationKeys: new Set(["mind"])
  });
  assert.deepEqual(valid.items.map((item) => item.nodeId), ["a", "b"]);

  assert.throws(() => validateMembershipBatch({
    raw: {
      batchId: "membership-batch-0001",
      items: [{
        nodeId: "a",
        memberships: [],
        omissionReason: "mapped",
        rationale: "Invalid"
      }]
    },
    batchId: "membership-batch-0001",
    expectedNodeIds: ["a"],
    constellationKeys: new Set(["mind"])
  }), /unmapped but has omissionReason=mapped/);
});

test("membership validation repairs a rewritten suffix when the stable id prefix is unique", () => {
  const validated = validateMembershipBatch({
    raw: {
      batchId: "membership-batch-0028",
      items: [{
        nodeId: "consolidated:1281:soil-moisture-shifts-after-watering",
        memberships: [{
          constellationKey: "seasonal-garden-rhythm",
          role: "supporting",
          currentPosition: false,
          openQuestion: false,
          tension: false
        }],
        omissionReason: "mapped",
        rationale: "Stejná stabilní rodina s přeformulovaným suffixem."
      }]
    },
    batchId: "membership-batch-0028",
    expectedNodeIds: ["consolidated:1281:soil-moisture-changes-after-watering"],
    constellationKeys: new Set(["seasonal-garden-rhythm"])
  });

  assert.equal(
    validated.items[0]?.nodeId,
    "consolidated:1281:soil-moisture-changes-after-watering"
  );
});

test("coverage replay keeps authored repairs but accepts semantic omission of conversation-only details", () => {
  const assessments = [
    assessment({ nodeId: "authored", documentId: "writing:a", authority: "authored", salience: 55 }),
    assessment({ nodeId: "meta", documentId: "conversation:a", authority: "conversation", salience: 75 })
  ];
  const omitted = acceptedHighSalienceOmissions({
    assessments,
    memberships: [{
      nodeId: "authored",
      memberships: [],
      omissionReason: "weak_evidence",
      rationale: "Needs authored coverage"
    }, {
      nodeId: "meta",
      memberships: [],
      omissionReason: "weak_evidence",
      rationale: "Interaction preference"
    }]
  });
  assert.deepEqual(omitted, ["meta"]);

  const replayed = validateSavedCoverageSubset({
    raw: {
      batchId: "coverage-batch-0001",
      items: [{
        nodeId: "authored",
        memberships: [{
          constellationKey: "mind",
          role: "supporting",
          currentPosition: false,
          openQuestion: false,
          tension: false
        }],
        omissionReason: "mapped",
        rationale: "Authored repair"
      }, {
        nodeId: "meta",
        memberships: [{
          constellationKey: "mind",
          role: "context",
          currentPosition: false,
          openQuestion: false,
          tension: false
        }],
        omissionReason: "mapped",
        rationale: "Legacy repair"
      }]
    },
    batchId: "coverage-batch-0001",
    expectedNodeIds: ["authored"],
    constellationKeys: new Set(["mind"])
  });
  assert.deepEqual(replayed.items.map((item) => item.nodeId), ["authored"]);
});

test("atlas display overrides cannot change semantic atlas fields", () => {
  const atlas = {
    atlasTitle: "Sensor atlas",
    atlasSummary: "Synthetic summary",
    constellations: [{
      key: "soil-moisture",
      title: "Soil moisture",
      summary: "Synthetic description",
      rationale: "Synthetic rationale",
      trajectoryHint: "Measurement changes",
      atlasRole: "core_direction" as const,
      confidence: 1,
      uncertainty: "Synthetic uncertainty",
      seedNodeIds: ["a", "b", "c"]
    }]
  };
  const curated = applyAtlasDisplayOverrides(atlas, {
    atlasTitle: "Greenhouse sensor atlas",
    constellations: {
      "soil-moisture": { title: "Půdní vlhkost", summary: "Přesný syntetický popis" }
    }
  });
  assert.equal(curated.atlasTitle, "Greenhouse sensor atlas");
  assert.equal(curated.constellations[0]?.title, "Půdní vlhkost");
  assert.equal(curated.constellations[0]?.summary, "Přesný syntetický popis");
  assert.deepEqual(curated.constellations[0]?.seedNodeIds, ["a", "b", "c"]);
});

test("scaled macro map reuses the atlas and old memberships across small and large additions", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "second-brain-macro-incremental-"));
  writeFileSync(path.join(root, "package.json"), "{}\n", "utf8");
  mkdirSync(path.join(root, "input"), { recursive: true });
  const paths = getProjectPaths(root);
  mkdirSync(paths.compiledDir, { recursive: true });

  const initialNodes = Array.from({ length: 24 }, (_, index) => {
    const number = index + 1;
    return node(
      `consolidated:${String(number).padStart(4, "0")}:node-${number}`,
      `writing:document-${number}`
    );
  });
  const graphPath = path.join(paths.compiledDir, "consolidated_thought_graph.json");
  writeFileSync(graphPath, `${JSON.stringify(graph(initialNodes), null, 2)}\n`, "utf8");

  const firstClient = new IncrementalMacroClient(initialNodes.map((item) => item.id));
  const first = buildScaledThoughtMacroMap({
    paths,
    client: firstClient as unknown as Pick<CodexCliClient, "execSemanticBatch">,
    model: "gpt-5.5",
    reasoningEffort: "high",
    iterationLabel: "initial",
    membershipBatchSize: 8,
    maxMembershipBatches: 1
  });
  assert.equal(first.status, "paused_manual");
  assert.deepEqual(firstClient.calls, [
    "atlas",
    "membership"
  ]);

  const resumeClient = new IncrementalMacroClient(initialNodes.map((item) => item.id));
  const resumed = buildScaledThoughtMacroMap({
    paths,
    client: resumeClient as unknown as Pick<CodexCliClient, "execSemanticBatch">,
    model: "gpt-5.5",
    reasoningEffort: "high",
    iterationLabel: "initial-resume",
    membershipBatchSize: 8
  });
  assert.equal(resumed.status, "completed");
  assert.deepEqual(resumeClient.calls, ["membership", "membership", "trajectory"]);
  assert.equal(resumed.atlasReused, true);
  assert.equal(resumed.reusedMembershipItemCount, 8);
  assert.equal(resumed.generatedMembershipItemCount, 24);

  const exact = buildScaledThoughtMacroMap({
    paths,
    model: "gpt-5.5",
    reasoningEffort: "high",
    iterationLabel: "exact-noop",
    membershipBatchSize: 8
  });
  assert.equal(exact.status, "completed");
  assert.equal(exact.reusedMembershipItemCount, 24);
  assert.equal(exact.generatedMembershipItemCount, 0);
  assert.equal(exact.atlasReused, true);
  assert.equal(exact.trajectoryReused, true);

  // Simulate the first upgrade from a schema-v1 run: master must promote the
  // exact accepted graph's legacy batches before consolidation can replace it.
  const membershipCachePath = path.join(paths.stateDir, "macro_map", "membership_cache.json");
  rmSync(membershipCachePath);
  const completedRunStatePath = path.join(exact.runDir, "run.json");
  const legacyRunState = JSON.parse(readFileSync(completedRunStatePath, "utf8")) as Record<
    string,
    unknown
  >;
  legacyRunState.schemaVersion = 1;
  delete legacyRunState.sourceGraphSemanticHash;
  delete legacyRunState.sourceAlignmentSemanticHash;
  writeFileSync(completedRunStatePath, `${JSON.stringify(legacyRunState, null, 2)}\n`, "utf8");
  assert.equal(prepareScaledMacroMapIncrementalReuse({
    paths,
    model: "gpt-5.5",
    reasoningEffort: "high"
  }), 24);
  assert.equal(prepareScaledMacroMapIncrementalReuse({
    paths,
    model: "gpt-5.5",
    reasoningEffort: "high"
  }), 0);

  const addedNode = node("consolidated:0025:node-25", "writing:document-25");
  const changedGraph = graph([...initialNodes, addedNode]);
  changedGraph.sourceNodeCount = 25;
  changedGraph.sourceRunId = "scaled-test-additive";
  changedGraph.generatedAt = "2026-01-02T00:00:00.000Z";
  const changedGraphText = `${JSON.stringify(changedGraph, null, 2)}\n`;
  writeFileSync(graphPath, changedGraphText, "utf8");

  // A prior attempt may already have created a compatible current run and
  // stopped before writing its atlas. It must not hide the accepted reusable
  // atlas recovered above.
  const interruptedRunId = "macro-map-2099-01-01T00-00-00-000Z-interrupted";
  const interruptedRunDir = path.join(paths.stateDir, "macro_map", "runs", interruptedRunId);
  mkdirSync(interruptedRunDir, { recursive: true });
  writeFileSync(path.join(interruptedRunDir, "run.json"), `${JSON.stringify({
    schemaVersion: 2,
    contractVersion: "thought-macro-map-v5-curated",
    runId: interruptedRunId,
    createdAt: "2099-01-01T00:00:00.000Z",
    updatedAt: "2099-01-01T00:00:00.000Z",
    status: "in_progress",
    iterationLabel: "interrupted",
    model: "gpt-5.5",
    reasoningEffort: "high",
    sourceOutputDir: paths.outputDir,
    targetOutputDir: paths.outputDir,
    sourceGraphHash: createHash("sha256").update(changedGraphText).digest("hex"),
    sourceAlignmentHash: null,
    sourceGraphSemanticHash: computeConsolidatedGraphSemanticHash(changedGraph),
    sourceAlignmentSemanticHash: null,
    atlasHash: null,
    trajectoryInputHash: null,
    reusedMembershipItemCount: 0,
    generatedMembershipItemCount: 0,
    atlasReused: false,
    trajectoryReused: false,
    membershipBatchSize: 8,
    atlasCompleted: false,
    membershipBatchCount: 0,
    completedMembershipBatchIds: [],
    coverageBatchCount: 0,
    completedCoverageBatchIds: [],
    trajectoryCompleted: false,
    failureMessage: null
  }, null, 2)}\n`, "utf8");

  const incrementalClient = new IncrementalMacroClient(initialNodes.map((item) => item.id));
  const incremental = buildScaledThoughtMacroMap({
    paths,
    client: incrementalClient as unknown as Pick<CodexCliClient, "execSemanticBatch">,
    model: "gpt-5.5",
    reasoningEffort: "high",
    iterationLabel: "one-added-node",
    membershipBatchSize: 8
  });

  assert.equal(incremental.status, "completed");
  assert.equal(incremental.atlasReused, true);
  assert.equal(incremental.reusedMembershipItemCount, 24);
  assert.equal(incremental.generatedMembershipItemCount, 1);
  assert.deepEqual(incrementalClient.calls, ["membership", "trajectory"]);

  const cache = JSON.parse(readFileSync(membershipCachePath, "utf8")) as {
    entries: Record<string, { nodeId: string }>;
  };
  assert.equal(
    Object.values(cache.entries).filter((entry) => entry.nodeId === addedNode.id).length,
    1
  );

  const largeAdditions = Array.from({ length: 23 }, (_, index) => {
    const number = index + 26;
    return node(
      `consolidated:${String(number).padStart(4, "0")}:node-${number}`,
      `writing:document-${number}`
    );
  });
  const largeChangedGraph = graph([...initialNodes, addedNode, ...largeAdditions]);
  largeChangedGraph.sourceNodeCount = 48;
  largeChangedGraph.sourceRunId = "scaled-test-large-additive";
  writeFileSync(graphPath, `${JSON.stringify(largeChangedGraph, null, 2)}\n`, "utf8");
  const largeIncrementClient = new IncrementalMacroClient(initialNodes.map((item) => item.id));
  const largeIncrement = buildScaledThoughtMacroMap({
    paths,
    client: largeIncrementClient as unknown as Pick<CodexCliClient, "execSemanticBatch">,
    model: "gpt-5.5",
    reasoningEffort: "high",
    iterationLabel: "large-addition",
    membershipBatchSize: 8
  });
  assert.equal(largeIncrement.atlasReused, true);
  assert.equal(largeIncrement.reusedMembershipItemCount, 25);
  assert.equal(largeIncrement.generatedMembershipItemCount, 23);
  assert.equal(largeIncrementClient.calls.includes("atlas"), false);
  assert.equal(largeIncrementClient.calls.filter((call) => call === "membership").length, 3);
});
