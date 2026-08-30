import test from "node:test";
import assert from "node:assert/strict";

import type { UnifiedCorpus } from "../types/domain.js";
import { buildThoughtCompilationArtifacts } from "./merge.js";
import type {
  ThoughtBatchOutput,
  ThoughtCompilerRunState,
  ThoughtDocumentFrameArtifact
} from "./types.js";

// This test corpus is intentionally tiny but semantically shaped:
// repeated watering rule, later revision, and explicit sensor-feedback tension.
// It gives us a cheap way to verify the post-LLM graph mechanics without
// burning live Codex calls.
function createSyntheticCorpus(): UnifiedCorpus {
  const dates = [
    "2024-01-10T00:00:00.000Z",
    "2024-02-18T00:00:00.000Z",
    "2024-03-24T00:00:00.000Z",
    "2024-04-30T00:00:00.000Z"
  ];
  const texts = [
    "Pevný denní plán podle této syntetické poznámky obvykle dodá záhonu dost vody.",
    "Druhá syntetická poznámka opakuje, že pevný denní plán bývá pro tento záhon dostačující.",
    "Pozdější syntetická poznámka plán podmiňuje průběžnou kontrolou vlhkosti půdy.",
    "Bez zpětné vazby ze senzoru může pevný plán půdu přelévat nebo vysušovat."
  ];

  const segments = texts.map((text, index) => {
    const itemNumber = index + 1;
    const id = `writing:synthetic-watering-${itemNumber}:paragraph:1`;
    const time = dates[index] ?? dates[0]!;

    return {
      id,
      documentId: `writing:synthetic-watering-${itemNumber}`,
      sourceKind: "writing" as const,
      segmentKind: "writing_paragraph" as const,
      signalKind: "primary" as const,
      authorKind: "self" as const,
      authorLabel: "self",
      sequenceIndex: 1,
      time,
      timeUnix: Date.parse(time),
      timePrecision: "day" as const,
      sourcePriority: 100,
      segmentLabel: "Paragraph 1",
      text,
      textPreview: text,
      sourceRef: {
        sourceKind: "writing" as const,
        sourcePath: `/input/writings/synthetic-watering-${itemNumber}.txt`,
        documentId: `writing:synthetic-watering-${itemNumber}`,
        documentTitle: `Synthetic watering ${itemNumber}`,
        locator: "paragraph:1",
        sourceItemId: "paragraph:1"
      }
    };
  });

  return {
    generatedAt: "2026-04-20T00:00:00.000Z",
    options: {
      ownerNames: ["Alex"],
      includeOtherContext: true,
      includeAssistantContext: true,
      includeToolContext: false,
      contextWindow: 1,
      includedSourceKinds: ["writing"]
    },
    documents: segments.map((segment, index) => ({
      id: segment.documentId,
      sourceKind: "writing" as const,
      sourcePath: `/input/writings/synthetic-watering-${index + 1}.txt`,
      slug: `synthetic-watering-${index + 1}`,
      title: `Synthetic watering ${index + 1}`,
      time: segment.time,
      timeUnix: segment.timeUnix,
      timePrecision: "day" as const,
      sourcePriority: 100,
      primaryText: segment.text,
      contextText: null,
      primarySegmentCount: 1,
      contextSegmentCount: 0,
      metadata: {
        fileLabel: `synthetic-watering-${index + 1}`,
        wordCount: segment.text.split(/\s+/).length
      }
    })),
    segments,
    timeline: segments.map((segment, index) => ({
      chronologyIndex: index,
      segmentId: segment.id,
      documentId: segment.documentId,
      sourceKind: segment.sourceKind,
      segmentKind: segment.segmentKind,
      signalKind: segment.signalKind,
      authorKind: segment.authorKind,
      documentTitle: `Synthetic watering ${index + 1}`,
      segmentLabel: segment.segmentLabel,
      time: segment.time,
      timeUnix: segment.timeUnix,
      timePrecision: segment.timePrecision,
      textPreview: segment.textPreview
    })),
    primaryTimeline: segments.map((segment, index) => ({
      chronologyIndex: index,
      segmentId: segment.id,
      documentId: segment.documentId,
      sourceKind: segment.sourceKind,
      segmentKind: segment.segmentKind,
      signalKind: segment.signalKind,
      authorKind: segment.authorKind,
      documentTitle: `Synthetic watering ${index + 1}`,
      segmentLabel: segment.segmentLabel,
      time: segment.time,
      timeUnix: segment.timeUnix,
      timePrecision: segment.timePrecision,
      textPreview: segment.textPreview
    })),
    stats: {
      documentCount: segments.length,
      segmentCount: segments.length,
      primarySegmentCount: segments.length,
      contextSegmentCount: 0,
      documentsBySourceKind: {
        writing: segments.length,
        conversation: 0,
        chat: 0
      },
      segmentsBySourceKind: {
        writing: segments.length,
        conversation: 0,
        chat: 0
      }
    }
  };
}

function createRunState(): ThoughtCompilerRunState {
  return {
    runId: "thought-compiler-synthetic",
    sourceCorpusPath: "/output/normalized/unified/corpus.json",
    corpusHash: "synthetic-corpus-hash",
    batchSize: 16,
    softInputTokenBudget: 8_000,
    totalBatchCount: 2,
    completedBatchIds: ["batch-0001", "batch-0002"],
    lastSuccessfulBatchId: "batch-0002",
    lastSuccessfulInputId: "writing:synthetic-watering-4:paragraph:1",
    status: "completed",
    failureKind: null,
    failureMessage: null,
    compilerContractVersion: 6,
    model: "gpt-5.4-mini",
    reasoningEffort: "low",
    startedAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:05.000Z",
    completedAt: "2026-04-20T00:00:05.000Z"
  };
}

// These batch outputs model the exact failure mode we care about:
// one later candidate looks mergeable by title, but should stay separate
// because it explicitly revises the earlier thesis instead of merely
// paraphrasing it.
function createBatchOutputs(): ThoughtBatchOutput[] {
  return [
    {
      batchId: "batch-0001",
      items: [
        {
          inputId: "writing:synthetic-watering-1:paragraph:1",
          nodeCandidates: [
            {
              canonicalKey: "fixed-watering-seems-sufficient",
              title: "Pevný plán zálivky obvykle stačí",
              nodeType: "thesis",
              status: "active",
              summary: "Pevný plán je jednoduchý způsob pravidelné zálivky.",
              claim: "Pevný plán dodá záhonu vodu v pravidelném rytmu.",
              rationale: "Segment explicitně tvrdí, že pevný plán obvykle stačí.",
              identityAliases: ["pevný plán zálivky"],
              relatedCanonicalKeys: ["watering-needs-sensor-feedback"],
              relationProposals: []
            }
          ]
        },
        {
          inputId: "writing:synthetic-watering-2:paragraph:1",
          nodeCandidates: [
            {
              canonicalKey: "fixed-watering-is-usually-enough",
              title: "Pevný plán zálivky obvykle stačí",
              nodeType: "thesis",
              status: "active",
              summary: "Pevný plán zůstává jednoduchým výchozím režimem zálivky.",
              claim: "Pevný plán obvykle dodá záhonu dostatek vody.",
              rationale: "Je to druhá formulace stejné teze o pevném plánu.",
              identityAliases: ["pravidelná zálivka"],
              relatedCanonicalKeys: ["watering-needs-sensor-feedback"],
              relationProposals: []
            }
          ]
        }
      ]
    },
    {
      batchId: "batch-0002",
      items: [
        {
          inputId: "writing:synthetic-watering-3:paragraph:1",
          nodeCandidates: [
            {
              canonicalKey: "fixed-watering-seems-sufficient",
              title: "Pevný plán zálivky obvykle stačí",
              nodeType: "thesis",
              status: "revised",
              summary: "Pevný plán funguje jen při kontrole aktuální vlhkosti.",
              claim: "Pevný plán je vhodný jen tehdy, když jej koriguje měření půdy.",
              rationale: "Pozdější formulace přidává měřenou podmínku a tím reviduje starší plán.",
              identityAliases: ["plán podmíněný měřením"],
              relatedCanonicalKeys: ["watering-needs-sensor-feedback"],
              relationProposals: [
                {
                  targetCanonicalKey: "watering-needs-sensor-feedback",
                  type: "supports",
                  rationale: "Tato revize přímo podpírá potřebu senzorové zpětné vazby."
                }
              ]
            }
          ]
        },
        {
          inputId: "writing:synthetic-watering-4:paragraph:1",
          nodeCandidates: [
            {
              canonicalKey: "watering-needs-sensor-feedback",
              title: "Zálivka potřebuje senzorovou zpětnou vazbu",
              nodeType: "thesis",
              status: "active",
              summary: "Bez měření může pevný plán půdu přelévat nebo vysušovat.",
              claim: "Zálivka potřebuje senzorovou zpětnou vazbu, jinak může kumulovat přebytek nebo nedostatek vody.",
              rationale: "Segment výslovně obhajuje zpětnou vazbu senzoru.",
              identityAliases: ["senzorové řízení zálivky"],
              relatedCanonicalKeys: ["fixed-watering-seems-sufficient"],
              relationProposals: [
                {
                  targetCanonicalKey: "fixed-watering-seems-sufficient",
                  type: "tensions_with",
                  rationale: "Nekorigovaný pevný plán podceňuje změny vlhkosti."
                }
              ]
            },
            {
              canonicalKey: "fixed-watering-needs-moisture-check",
              title: "Pevný plán zálivky obvykle stačí",
              nodeType: "thesis",
              status: "revised",
              summary: "Pevný plán je přínosný jen s průběžnou kontrolou vlhkosti.",
              claim: "Výhody pevného plánu zůstávají jen při pravidelné senzorové kontrole.",
              rationale: "Tato formulace má stejný titul jako původní teze, ale už ji opravuje.",
              identityAliases: ["plán podmíněný kontrolou vlhkosti"],
              relatedCanonicalKeys: ["watering-needs-sensor-feedback"],
              relationProposals: [
                {
                  targetCanonicalKey: "fixed-watering-seems-sufficient",
                  type: "revises",
                  rationale: "Nejde o totéž tvrzení, ale o pozdější opravu původního plánu."
                }
              ]
            }
          ]
        }
      ]
    }
  ];
}

test("buildThoughtCompilationArtifacts canonicalizes nodes, preserves revision states, and keeps explicit conflicts separate", () => {
  const artifacts = buildThoughtCompilationArtifacts(
    createSyntheticCorpus(),
    createRunState(),
    createBatchOutputs()
  );

  assert.equal(artifacts.graph.nodeCount, 3);
  assert.equal(artifacts.graph.claimCount, 5);
  assert.equal(artifacts.identityBlocks.length, 3);

  const wateringPlanBlock = artifacts.identityBlocks.find(
    (block) => block.canonicalKey === "fixed-watering-seems-sufficient"
  );
  assert.ok(wateringPlanBlock);
  assert.deepEqual(wateringPlanBlock.candidateKeys, [
    "fixed-watering-is-usually-enough",
    "fixed-watering-seems-sufficient"
  ]);

  const wateringPlanNode = artifacts.graph.nodes.find(
    (node) => node.id === "thought:fixed-watering-seems-sufficient"
  );
  assert.ok(wateringPlanNode);
  assert.equal(wateringPlanNode.currentStateId !== null, true);
  assert.equal(wateringPlanNode.status, "revised");

  const wateringPlanStates = artifacts.nodeStates.filter(
    (state) => state.nodeId === "thought:fixed-watering-seems-sufficient"
  );
  assert.equal(wateringPlanStates.length >= 2, true);
  assert.equal(wateringPlanStates[0]?.transitionType, "introduced");
  assert.equal(wateringPlanStates[wateringPlanStates.length - 1]?.transitionType, "revised");
  assert.equal(wateringPlanStates[0]?.revisedByStateId !== null, true);

  const wateringPlanWorldline = artifacts.worldlines.find(
    (worldline) => worldline.nodeId === "thought:fixed-watering-seems-sufficient"
  );
  assert.ok(wateringPlanWorldline);
  assert.equal(
    wateringPlanWorldline.invalidatedStateIds.length,
    wateringPlanStates.length - 1
  );
  assert.equal(
    wateringPlanWorldline.currentStateId,
    wateringPlanStates[wateringPlanStates.length - 1]?.id ?? null
  );

  // This candidate intentionally shares the original title, but an explicit
  // `revises` relation should keep it as a separate node instead of collapsing it.
  const guardedNode = artifacts.graph.nodes.find(
    (node) => node.id === "thought:fixed-watering-needs-moisture-check"
  );
  assert.ok(guardedNode);

  const edgeTypes = new Map(
    artifacts.graph.edges.map((edge) => [
      `${edge.type}:${edge.from}:${edge.to}`,
      edge
    ])
  );

  assert.ok(
    Array.from(edgeTypes.values()).some(
      (edge) =>
        edge.type === "semantic_related" &&
        edge.supportingClaimIds.length >= 1 &&
        edge.from === "thought:fixed-watering-seems-sufficient" &&
        edge.to === "thought:watering-needs-sensor-feedback"
    )
  );
  assert.ok(
    Array.from(edgeTypes.values()).some(
      (edge) =>
        edge.type === "tensions_with" &&
        edge.from === "thought:fixed-watering-seems-sufficient" &&
        edge.to === "thought:watering-needs-sensor-feedback"
    )
  );
  assert.ok(
    Array.from(edgeTypes.values()).some(
      (edge) =>
        edge.type === "revises" &&
        edge.from === "thought:fixed-watering-needs-moisture-check" &&
        edge.to === "thought:fixed-watering-seems-sufficient"
    )
  );
});

test("buildThoughtCompilationArtifacts preserves source-local frame memberships on nodes", () => {
  const corpus = createSyntheticCorpus();
  const frameArtifact: ThoughtDocumentFrameArtifact = {
    generatedAt: "2026-04-28T00:00:00.000Z",
    sourceCorpusPath: "/output/normalized/unified/corpus.json",
    corpusHash: "synthetic-corpus-hash",
    documentCount: 4,
    frameCount: 4,
    subframeCount: 1,
    frames: [
      {
        id: "frame:writing:synthetic-watering-1:01:pevny-plan",
        documentId: "writing:synthetic-watering-1",
        sourceKind: "writing",
        label: "Pevný plán zálivky",
        summary: "Rámec tvrzení o dostačujícím pevném plánu.",
        scope: "document",
        segmentIds: ["writing:synthetic-watering-1:paragraph:1"],
        startSequenceIndex: 1,
        endSequenceIndex: 1,
        subframeIds: []
      },
      {
        id: "frame:writing:synthetic-watering-2:01:pevny-plan",
        documentId: "writing:synthetic-watering-2",
        sourceKind: "writing",
        label: "Pevný plán zálivky",
        summary: "Rámec tvrzení o dostačujícím pevném plánu.",
        scope: "document",
        segmentIds: ["writing:synthetic-watering-2:paragraph:1"],
        startSequenceIndex: 1,
        endSequenceIndex: 1,
        subframeIds: []
      },
      {
        id: "frame:writing:synthetic-watering-3:01:plan-s-kontrolou",
        documentId: "writing:synthetic-watering-3",
        sourceKind: "writing",
        label: "Plán s kontrolou vlhkosti",
        summary: "Pevný plán podmíněný měřením vlhkosti.",
        scope: "document",
        segmentIds: ["writing:synthetic-watering-3:paragraph:1"],
        startSequenceIndex: 1,
        endSequenceIndex: 1,
        subframeIds: []
      },
      {
        id: "frame:writing:synthetic-watering-4:01:rizeni-zalivky",
        documentId: "writing:synthetic-watering-4",
        sourceKind: "writing",
        label: "Řízení zálivky",
        summary: "Rámec senzorové zpětné vazby pro zálivku.",
        scope: "document",
        segmentIds: ["writing:synthetic-watering-4:paragraph:1"],
        startSequenceIndex: 1,
        endSequenceIndex: 1,
        subframeIds: [
          "frame:writing:synthetic-watering-4:01:rizeni-zalivky:subframe:01:kontrola-vlhkosti"
        ]
      }
    ],
    subframes: [
      {
        id: "frame:writing:synthetic-watering-4:01:rizeni-zalivky:subframe:01:kontrola-vlhkosti",
        frameId: "frame:writing:synthetic-watering-4:01:rizeni-zalivky",
        documentId: "writing:synthetic-watering-4",
        sourceKind: "writing",
        label: "Podmínky kontroly vlhkosti",
        summary: "Větev o tom, že pevný plán závisí na měření vlhkosti.",
        segmentIds: ["writing:synthetic-watering-4:paragraph:1"],
        startSequenceIndex: 1,
        endSequenceIndex: 1
      }
    ]
  };

  const batchOutputs = createBatchOutputs().map((batchOutput) => ({
    ...batchOutput,
    items: batchOutput.items.map((item) => ({
      ...item,
      nodeCandidates: item.nodeCandidates.map((candidate) => {
        if (item.inputId === "writing:synthetic-watering-4:paragraph:1") {
          if (candidate.canonicalKey === "watering-needs-sensor-feedback") {
            return {
              ...candidate,
              documentFrameId: "frame:writing:synthetic-watering-4:01:rizeni-zalivky",
              documentSubframeId: null,
              frameRole: "main_claim" as const
            };
          }

          return {
            ...candidate,
            documentFrameId: "frame:writing:synthetic-watering-4:01:rizeni-zalivky",
            documentSubframeId:
              "frame:writing:synthetic-watering-4:01:rizeni-zalivky:subframe:01:kontrola-vlhkosti",
            frameRole: "revision_branch" as const
          };
        }

        if (
          candidate.canonicalKey === "fixed-watering-seems-sufficient" ||
          candidate.canonicalKey === "fixed-watering-is-usually-enough"
        ) {
          return {
            ...candidate,
            documentFrameId:
              item.inputId === "writing:synthetic-watering-3:paragraph:1"
                ? "frame:writing:synthetic-watering-3:01:plan-s-kontrolou"
                : item.inputId === "writing:synthetic-watering-2:paragraph:1"
                  ? "frame:writing:synthetic-watering-2:01:pevny-plan"
                  : "frame:writing:synthetic-watering-1:01:pevny-plan",
            documentSubframeId: null,
            frameRole: "main_claim" as const
          };
        }

        return candidate;
      })
    }))
  }));

  const artifacts = buildThoughtCompilationArtifacts(
    corpus,
    createRunState(),
    batchOutputs,
    frameArtifact
  );

  assert.equal(artifacts.documentFrames?.frameCount, 4);

  const wateringPlanNode = artifacts.graph.nodes.find(
    (node) => node.id === "thought:fixed-watering-seems-sufficient"
  );
  assert.ok(wateringPlanNode);
  assert.equal((wateringPlanNode.frameMemberships?.length ?? 0) >= 2, true);
  assert.equal(
    wateringPlanNode.frameMemberships?.some(
      (membership) => membership.frameLabel === "Pevný plán zálivky"
    ) ?? false,
    true
  );
  assert.equal(
    wateringPlanNode.frameMemberships?.some(
      (membership) => membership.frameLabel === "Plán s kontrolou vlhkosti"
    ) ?? false,
    true
  );

  const moistureCheckRevisionNode = artifacts.graph.nodes.find(
    (node) => node.id === "thought:fixed-watering-needs-moisture-check"
  );
  assert.ok(moistureCheckRevisionNode);
  assert.equal(
    moistureCheckRevisionNode.frameMemberships?.[0]?.subframeLabel,
    "Podmínky kontroly vlhkosti"
  );
  assert.equal(moistureCheckRevisionNode.frameMemberships?.[0]?.frameRole, "revision_branch");
});
