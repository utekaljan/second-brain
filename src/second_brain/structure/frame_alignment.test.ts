import test from "node:test";
import assert from "node:assert/strict";

import type { ConsolidatedThoughtGraph, ThoughtDocumentFrameArtifact } from "../compiler/types.js";
import { buildThoughtFrameAlignmentArtifact } from "./frame_alignment.js";

function createGraph(): ConsolidatedThoughtGraph {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceRunId: "run-1",
    sourceGraphPath: "/tmp/thought_graph.json",
    sourceNodeCount: 4,
    sourceEdgeCount: 3,
    nodeCount: 4,
    edgeCount: 3,
    nodes: [
      {
        id: "consolidated:1",
        canonicalKey: "greenhouse-climate-sensors",
        title: "Senzory klimatu ve zkušebním skleníku",
        summary: "Syntetický rámec sledování teploty a vlhkosti.",
        nodeType: "thesis",
        status: "active",
        firstSeen: "2024-01-01",
        lastSeen: "2024-02-01",
        sourceRefs: [],
        relatedNodeIds: ["consolidated:2", "consolidated:3"],
        aliases: [],
        signalBySourceKind: { writing: 2, conversation: 0, chat: 0 },
        memberNodeIds: [],
        memberCanonicalKeys: [],
        memberClaimIds: [],
        memberStateIds: [],
        currentStateIds: [],
        memberWorldlineIds: [],
        consolidationReasons: [],
        frameMemberships: [
          {
            documentId: "writing:doc-a",
            frameId: "frame:doc-a:01",
            frameLabel: "Senzory klimatu ve zkušebním skleníku",
            subframeId: null,
            subframeLabel: null,
            frameRole: "main_claim",
            occurrenceCount: 2
          },
          {
            documentId: "writing:doc-b",
            frameId: "frame:doc-b:01",
            frameLabel: "Senzory pro sledování skleníkového klimatu",
            subframeId: null,
            subframeLabel: null,
            frameRole: "main_claim",
            occurrenceCount: 1
          }
        ]
      },
      {
        id: "consolidated:2",
        canonicalKey: "greenhouse-watering-inputs",
        title: "Zavlažování podle senzorů půdní vlhkosti",
        summary: "Syntetická zálivka využívá naměřenou vlhkost.",
        nodeType: "thesis",
        status: "active",
        firstSeen: "2024-02-01",
        lastSeen: "2024-03-01",
        sourceRefs: [],
        relatedNodeIds: ["consolidated:1"],
        aliases: [],
        signalBySourceKind: { writing: 2, conversation: 0, chat: 0 },
        memberNodeIds: [],
        memberCanonicalKeys: [],
        memberClaimIds: [],
        memberStateIds: [],
        currentStateIds: [],
        memberWorldlineIds: [],
        consolidationReasons: [],
        frameMemberships: [
          {
            documentId: "writing:doc-a",
            frameId: "frame:doc-a:01",
            frameLabel: "Senzory klimatu ve zkušebním skleníku",
            subframeId: "sub:doc-a:01",
            subframeLabel: "Rizika nepřesného měření půdní vlhkosti",
            frameRole: "subclaim",
            occurrenceCount: 1
          },
          {
            documentId: "writing:doc-c",
            frameId: "frame:doc-c:01",
            frameLabel: "Úprava zavlažování podle senzorů půdní vlhkosti",
            subframeId: null,
            subframeLabel: null,
            frameRole: "main_claim",
            occurrenceCount: 1
          }
        ]
      },
      {
        id: "consolidated:3",
        canonicalKey: "greenhouse-watering-control",
        title: "Řízení zálivky mezi přelitím a vysušením",
        summary: "Syntetický regulátor vyvažuje přísun vody.",
        nodeType: "theme",
        status: "active",
        firstSeen: "2024-03-01",
        lastSeen: "2024-04-01",
        sourceRefs: [],
        relatedNodeIds: ["consolidated:1", "consolidated:2"],
        aliases: [],
        signalBySourceKind: { writing: 2, conversation: 0, chat: 0 },
        memberNodeIds: [],
        memberCanonicalKeys: [],
        memberClaimIds: [],
        memberStateIds: [],
        currentStateIds: [],
        memberWorldlineIds: [],
        consolidationReasons: [],
        frameMemberships: [
          {
            documentId: "writing:doc-c",
            frameId: "frame:doc-c:01",
            frameLabel: "Úprava zavlažování podle senzorů půdní vlhkosti",
            subframeId: "sub:doc-c:01",
            subframeLabel: "Prahy senzorů pro bezpečné zavlažování",
            frameRole: "subclaim",
            occurrenceCount: 1
          },
          {
            documentId: "writing:doc-d",
            frameId: "frame:doc-d:01",
            frameLabel: "Hledání zálivky mezi přelitím a vysušením",
            subframeId: null,
            subframeLabel: null,
            frameRole: "main_claim",
            occurrenceCount: 1
          }
        ]
      },
      {
        id: "consolidated:4",
        canonicalKey: "greenhouse-door-sensor",
        title: "Senzor otevření servisních dveří skleníku",
        summary: "Syntetické čidlo eviduje otevření dveří.",
        nodeType: "theme",
        status: "active",
        firstSeen: "2024-04-01",
        lastSeen: "2024-05-01",
        sourceRefs: [],
        relatedNodeIds: [],
        aliases: [],
        signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
        memberNodeIds: [],
        memberCanonicalKeys: [],
        memberClaimIds: [],
        memberStateIds: [],
        currentStateIds: [],
        memberWorldlineIds: [],
        consolidationReasons: [],
        frameMemberships: [
          {
            documentId: "writing:doc-e",
            frameId: "frame:doc-e:01",
            frameLabel: "Kalibrace čidla servisních dveří",
            subframeId: null,
            subframeLabel: null,
            frameRole: "main_claim",
            occurrenceCount: 1
          }
        ]
      }
    ],
    edges: []
  };
}

function createFrameArtifact(): ThoughtDocumentFrameArtifact {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceCorpusPath: "/tmp/corpus.json",
    corpusHash: "hash-1",
    documentCount: 5,
    frameCount: 5,
    subframeCount: 2,
    frames: [
      {
        id: "frame:doc-a:01",
        documentId: "writing:doc-a",
        sourceKind: "writing",
        label: "Senzory klimatu ve zkušebním skleníku",
        summary: "Syntetické senzory sledují teplotu a vlhkost.",
        scope: "document",
        segmentIds: ["a:1", "a:2"],
        startSequenceIndex: 1,
        endSequenceIndex: 2,
        subframeIds: ["sub:doc-a:01"]
      },
      {
        id: "frame:doc-b:01",
        documentId: "writing:doc-b",
        sourceKind: "writing",
        label: "Senzory pro sledování skleníkového klimatu",
        summary: "Měření popisuje podmínky ve zkušebním skleníku.",
        scope: "document",
        segmentIds: ["b:1", "b:2"],
        startSequenceIndex: 1,
        endSequenceIndex: 2,
        subframeIds: []
      },
      {
        id: "frame:doc-c:01",
        documentId: "writing:doc-c",
        sourceKind: "writing",
        label: "Úprava zavlažování podle senzorů půdní vlhkosti",
        summary: "Naměřená vlhkost určuje dávku vody.",
        scope: "document",
        segmentIds: ["c:1", "c:2"],
        startSequenceIndex: 1,
        endSequenceIndex: 2,
        subframeIds: ["sub:doc-c:01"]
      },
      {
        id: "frame:doc-d:01",
        documentId: "writing:doc-d",
        sourceKind: "writing",
        label: "Hledání zálivky mezi přelitím a vysušením",
        summary: "Řízení vody drží bezpečné rozmezí.",
        scope: "document",
        segmentIds: ["d:1", "d:2"],
        startSequenceIndex: 1,
        endSequenceIndex: 2,
        subframeIds: []
      },
      {
        id: "frame:doc-e:01",
        documentId: "writing:doc-e",
        sourceKind: "writing",
        label: "Kalibrace čidla servisních dveří",
        summary: "Syntetické čidlo sleduje otevření dveří skleníku.",
        scope: "document",
        segmentIds: ["e:1", "e:2"],
        startSequenceIndex: 1,
        endSequenceIndex: 2,
        subframeIds: []
      }
    ],
    subframes: [
      {
        id: "sub:doc-a:01",
        frameId: "frame:doc-a:01",
        documentId: "writing:doc-a",
        sourceKind: "writing",
        label: "Rizika nepřesného měření půdní vlhkosti",
        summary: "Nepřesné čidlo může spustit chybnou zálivku.",
        segmentIds: ["a:2"],
        startSequenceIndex: 2,
        endSequenceIndex: 2
      },
      {
        id: "sub:doc-c:01",
        frameId: "frame:doc-c:01",
        documentId: "writing:doc-c",
        sourceKind: "writing",
        label: "Prahy senzorů pro bezpečné zavlažování",
        summary: "Syntetický regulátor mění prahy podle vlhkosti.",
        segmentIds: ["c:2"],
        startSequenceIndex: 2,
        endSequenceIndex: 2
      }
    ]
  };
}

test("buildThoughtFrameAlignmentArtifact aligns related writing frames across documents", () => {
  const artifact = buildThoughtFrameAlignmentArtifact({
    documentFrames: createFrameArtifact(),
    consolidatedGraph: createGraph(),
    sourceDocumentFramesPath: "/tmp/frames.json",
    sourceConsolidatedGraphPath: "/tmp/consolidated.json"
  });

  assert.equal(artifact.familyCount >= 2, true);

  const greenhouseFamily = artifact.families.find(
    (family) =>
      family.memberFrameIds.includes("frame:doc-a:01") &&
      family.memberFrameIds.includes("frame:doc-b:01") &&
      family.memberFrameIds.includes("frame:doc-c:01") &&
      family.memberFrameIds.includes("frame:doc-d:01")
  );
  assert.ok(greenhouseFamily);
  assert.equal(greenhouseFamily.memberDocumentIds.length, 4);
  assert.equal(greenhouseFamily.memberNodeIds.includes("consolidated:1"), true);
});

test("buildThoughtFrameAlignmentArtifact keeps an unrelated synthetic greenhouse-door sensor frame separate", () => {
  const artifact = buildThoughtFrameAlignmentArtifact({
    documentFrames: createFrameArtifact(),
    consolidatedGraph: createGraph(),
    sourceDocumentFramesPath: "/tmp/frames.json",
    sourceConsolidatedGraphPath: "/tmp/consolidated.json"
  });

  const doorSensorFamily = artifact.families.find((family) =>
    family.memberFrameIds.includes("frame:doc-e:01")
  );
  assert.ok(doorSensorFamily);
  assert.deepEqual(doorSensorFamily.memberFrameIds, ["frame:doc-e:01"]);
});

test("buildThoughtFrameAlignmentArtifact emits a stable higher-order pattern layer shape", () => {
  const patternGraph: ConsolidatedThoughtGraph = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceRunId: "run-2",
    sourceGraphPath: "/tmp/thought_graph.json",
    sourceNodeCount: 5,
    sourceEdgeCount: 0,
    nodeCount: 5,
    edgeCount: 0,
    nodes: [
      {
        id: "n1",
        canonicalKey: "greenhouse-climate-sensors",
        title: "Senzory klimatu ve skleníku",
        summary: "Syntetické čidlo sleduje skleníkové klima.",
        nodeType: "thesis",
        status: "active",
        firstSeen: null,
        lastSeen: null,
        sourceRefs: [],
        relatedNodeIds: ["n3", "bridge:1", "bridge:2"],
        aliases: [],
        signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
        memberNodeIds: [],
        memberCanonicalKeys: [],
        memberClaimIds: [],
        memberStateIds: [],
        currentStateIds: [],
        memberWorldlineIds: [],
        consolidationReasons: [],
        frameMemberships: [
          {
            documentId: "writing:a",
            frameId: "frame:a",
            frameLabel: "Senzory klimatu a zavlažování",
            subframeId: null,
            subframeLabel: null,
            frameRole: "main_claim",
            occurrenceCount: 1
          },
          {
            documentId: "writing:b",
            frameId: "frame:b",
            frameLabel: "Skleníkové klima podle senzorů",
            subframeId: null,
            subframeLabel: null,
            frameRole: "main_claim",
            occurrenceCount: 1
          }
        ]
      },
      {
        id: "n2",
        canonicalKey: "greenhouse-watering-control",
        title: "Řízení zavlažování podle vlhkosti",
        summary: "Syntetický regulátor dávkuje vodu podle vlhkosti.",
        nodeType: "theme",
        status: "active",
        firstSeen: null,
        lastSeen: null,
        sourceRefs: [],
        relatedNodeIds: ["n3", "bridge:1", "bridge:2"],
        aliases: [],
        signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
        memberNodeIds: [],
        memberCanonicalKeys: [],
        memberClaimIds: [],
        memberStateIds: [],
        currentStateIds: [],
        memberWorldlineIds: [],
        consolidationReasons: [],
        frameMemberships: [
          {
            documentId: "writing:c",
            frameId: "frame:c",
            frameLabel: "Řízení zavlažování podle čidel",
            subframeId: null,
            subframeLabel: null,
            frameRole: "main_claim",
            occurrenceCount: 1
          },
          {
            documentId: "writing:d",
            frameId: "frame:d",
            frameLabel: "Kontrola půdní vlhkosti ve skleníku",
            subframeId: null,
            subframeLabel: null,
            frameRole: "main_claim",
            occurrenceCount: 1
          }
        ]
      },
      {
        id: "n3",
        canonicalKey: "sensor-watering-bridge",
        title: "Senzory určují dávku zálivky",
        summary: "Syntetické propojení měření a zálivky.",
        nodeType: "thesis",
        status: "active",
        firstSeen: null,
        lastSeen: null,
        sourceRefs: [],
        relatedNodeIds: ["n1", "n2"],
        aliases: [],
        signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
        memberNodeIds: [],
        memberCanonicalKeys: [],
        memberClaimIds: [],
        memberStateIds: [],
        currentStateIds: [],
        memberWorldlineIds: [],
        consolidationReasons: [],
        frameMemberships: []
      },
      {
        id: "n4",
        canonicalKey: "climate-sensor-bridge",
        title: "Teplota jako vstup pro zavlažování",
        summary: "Syntetická teplota doplňuje pravidla zavlažování.",
        nodeType: "thesis",
        status: "active",
        firstSeen: null,
        lastSeen: null,
        sourceRefs: [],
        relatedNodeIds: ["n2", "bridge:1", "bridge:2"],
        aliases: [],
        signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
        memberNodeIds: [],
        memberCanonicalKeys: [],
        memberClaimIds: [],
        memberStateIds: [],
        currentStateIds: [],
        memberWorldlineIds: [],
        consolidationReasons: [],
        frameMemberships: [
          {
            documentId: "writing:a",
            frameId: "frame:a",
            frameLabel: "Senzory klimatu a zavlažování",
            subframeId: null,
            subframeLabel: null,
            frameRole: "subclaim",
            occurrenceCount: 1
          }
        ]
      },
      {
        id: "n5",
        canonicalKey: "watering-control-bridge",
        title: "Vlhkost a řízení zavlažování",
        summary: "Syntetická vlhkost doplňuje řízení zálivky.",
        nodeType: "theme",
        status: "active",
        firstSeen: null,
        lastSeen: null,
        sourceRefs: [],
        relatedNodeIds: ["n1", "bridge:1", "bridge:2"],
        aliases: [],
        signalBySourceKind: { writing: 1, conversation: 0, chat: 0 },
        memberNodeIds: [],
        memberCanonicalKeys: [],
        memberClaimIds: [],
        memberStateIds: [],
        currentStateIds: [],
        memberWorldlineIds: [],
        consolidationReasons: [],
        frameMemberships: [
          {
            documentId: "writing:c",
            frameId: "frame:c",
            frameLabel: "Řízení zavlažování podle čidel",
            subframeId: null,
            subframeLabel: null,
            frameRole: "subclaim",
            occurrenceCount: 1
          }
        ]
      }
    ],
    edges: []
  };
  const patternFrames: ThoughtDocumentFrameArtifact = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceCorpusPath: "/tmp/corpus.json",
    corpusHash: "hash-2",
    documentCount: 4,
    frameCount: 4,
    subframeCount: 0,
    frames: [
      {
        id: "frame:a",
        documentId: "writing:a",
        sourceKind: "writing",
        label: "Senzory klimatu a zavlažování",
        summary: "Syntetický rámec propojuje klima a zálivku.",
        scope: "document",
        segmentIds: ["a:1"],
        startSequenceIndex: 1,
        endSequenceIndex: 1,
        subframeIds: []
      },
      {
        id: "frame:b",
        documentId: "writing:b",
        sourceKind: "writing",
        label: "Skleníkové klima podle senzorů",
        summary: "Syntetické senzory popisují skleníkové podmínky.",
        scope: "document",
        segmentIds: ["b:1"],
        startSequenceIndex: 1,
        endSequenceIndex: 1,
        subframeIds: []
      },
      {
        id: "frame:c",
        documentId: "writing:c",
        sourceKind: "writing",
        label: "Řízení zavlažování podle čidel",
        summary: "Syntetická čidla řídí dávkování vody.",
        scope: "document",
        segmentIds: ["c:1"],
        startSequenceIndex: 1,
        endSequenceIndex: 1,
        subframeIds: []
      },
      {
        id: "frame:d",
        documentId: "writing:d",
        sourceKind: "writing",
        label: "Kontrola půdní vlhkosti ve skleníku",
        summary: "Syntetické měření ověřuje půdní vlhkost.",
        scope: "document",
        segmentIds: ["d:1"],
        startSequenceIndex: 1,
        endSequenceIndex: 1,
        subframeIds: []
      }
    ],
    subframes: []
  };

  const artifact = buildThoughtFrameAlignmentArtifact({
    documentFrames: patternFrames,
    consolidatedGraph: patternGraph,
    sourceDocumentFramesPath: "/tmp/frames.json",
    sourceConsolidatedGraphPath: "/tmp/consolidated.json"
  });

  assert.equal(Array.isArray(artifact.patterns), true);
  assert.equal(typeof artifact.patternCount, "number");
  assert.equal(
    artifact.patterns.every(
      (pattern) =>
        Array.isArray(pattern.familyIds) &&
        Array.isArray(pattern.familyLabels) &&
        Array.isArray(pattern.documentIds) &&
        Array.isArray(pattern.nodeIds)
    ),
    true
  );
});
