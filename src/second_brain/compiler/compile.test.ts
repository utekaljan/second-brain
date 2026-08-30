import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexCliError } from "../codex/client.js";
import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import { compileThoughtNodes } from "./compile.js";
import { getProjectPaths } from "../system/paths.js";
import type { UnifiedCorpus } from "../types/domain.js";
import { computeStableUnifiedCorpusHash } from "./state.js";

// The compile tests use a very small unified corpus so resume/auth behavior can
// be tested deterministically without any live Codex dependency.
function createUnifiedCorpus(): UnifiedCorpus {
  const texts = [
    "Senzor meri vlhkost pudy pred prvni zalivkou.",
    "Druhe mereni zachyti zmenu po stejnem objemu vody.",
    "Treti zaznam porovna pevny plan se zpetnou vazbou senzoru."
  ];

  const segments = texts.map((text, index) => {
    const itemNumber = index + 1;
    const id = `writing:test-${itemNumber}:paragraph:1`;

    return {
      id,
      documentId: `writing:test-${itemNumber}`,
      sourceKind: "writing" as const,
      segmentKind: "writing_paragraph" as const,
      signalKind: "primary" as const,
      authorKind: "self" as const,
      authorLabel: "self",
      sequenceIndex: 1,
      time: `2024-01-${String(itemNumber).padStart(2, "0")}T00:00:00.000Z`,
      timeUnix: Date.parse(`2024-01-${String(itemNumber).padStart(2, "0")}T00:00:00.000Z`),
      timePrecision: "day" as const,
      sourcePriority: 100,
      segmentLabel: `Paragraph ${itemNumber}`,
      text,
      textPreview: text,
      sourceRef: {
        sourceKind: "writing" as const,
        sourcePath: `/input/writings/test-${itemNumber}.txt`,
        documentId: `writing:test-${itemNumber}`,
        documentTitle: `Test ${itemNumber}`,
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
      includedSourceKinds: ["writing", "conversation", "chat"]
    },
    documents: segments.map((segment, index) => ({
      id: segment.documentId,
      sourceKind: "writing" as const,
      sourcePath: `/input/writings/test-${index + 1}.txt`,
      slug: `test-${index + 1}`,
      title: `Test ${index + 1}`,
      time: segment.time,
      timeUnix: segment.timeUnix,
      timePrecision: "day" as const,
      sourcePriority: 100,
      primaryText: segment.text,
      contextText: null,
      primarySegmentCount: 1,
      contextSegmentCount: 0,
      metadata: {
        fileLabel: `test-${index + 1}`,
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
      documentTitle: `Test ${index + 1}`,
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
      documentTitle: `Test ${index + 1}`,
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

function createConversationCorpus(texts: string[]): UnifiedCorpus {
  const segments = texts.map((text, index) => {
    const itemNumber = index + 1;
    const id = `conversation:conv-${itemNumber}:turn:user-${itemNumber}`;

    return {
      id,
      documentId: `conversation:conv-${itemNumber}`,
      sourceKind: "conversation" as const,
      segmentKind: "conversation_user_turn" as const,
      signalKind: "primary" as const,
      authorKind: "self" as const,
      authorLabel: "self",
      sequenceIndex: 1,
      time: `2024-02-${String(itemNumber).padStart(2, "0")}T00:00:00.000Z`,
      timeUnix: Date.parse(`2024-02-${String(itemNumber).padStart(2, "0")}T00:00:00.000Z`),
      timePrecision: "second" as const,
      sourcePriority: 50,
      segmentLabel: `User turn ${itemNumber}`,
      text,
      textPreview: text,
      sourceRef: {
        sourceKind: "conversation" as const,
        sourcePath: "/input/conversations/conversations-000.json",
        documentId: `conversation:conv-${itemNumber}`,
        documentTitle: `Conversation ${itemNumber}`,
        locator: `turn:user-${itemNumber}`,
        sourceItemId: `user-${itemNumber}`,
        conversationId: `conv-${itemNumber}`,
        bundleName: "conversations-000.json",
        turnId: `user-${itemNumber}`
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
      includedSourceKinds: ["writing", "conversation", "chat"]
    },
    documents: segments.map((segment, index) => ({
      id: segment.documentId,
      sourceKind: "conversation" as const,
      sourcePath: "/input/conversations/conversations-000.json",
      slug: `conv-${index + 1}`,
      title: `Conversation ${index + 1}`,
      time: segment.time,
      timeUnix: segment.timeUnix,
      timePrecision: "second" as const,
      sourcePriority: 50,
      primaryText: segment.text,
      contextText: null,
      primarySegmentCount: 1,
      contextSegmentCount: 0,
      metadata: {
        conversationId: `conv-${index + 1}`,
        bundleName: "conversations-000.json",
        gizmoId: null,
        turnCount: 1
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
      documentTitle: `Conversation ${index + 1}`,
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
      documentTitle: `Conversation ${index + 1}`,
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
        writing: 0,
        conversation: segments.length,
        chat: 0
      },
      segmentsBySourceKind: {
        writing: 0,
        conversation: segments.length,
        chat: 0
      }
    }
  };
}

function writeCompilerFixture(tempRoot: string): ReturnType<typeof getProjectPaths> {
  // getProjectPaths expects a repo-like root with package.json present. We only
  // create the minimal scaffold needed for compiler tests, nothing more.
  writeFileSync(path.join(tempRoot, "package.json"), "{}\n", "utf8");
  mkdirSync(path.join(tempRoot, "input"), { recursive: true });
  mkdirSync(path.join(tempRoot, "output", "normalized", "unified"), { recursive: true });
  mkdirSync(path.join(tempRoot, "output", "compiled"), { recursive: true });
  writeFileSync(
    path.join(tempRoot, "output", "normalized", "unified", "corpus.json"),
    `${JSON.stringify(createUnifiedCorpus(), null, 2)}\n`,
    "utf8"
  );
  const paths = getProjectPaths(tempRoot);
  const corpusHash = computeStableUnifiedCorpusHash(
    path.join(tempRoot, "output", "normalized", "unified", "corpus.json")
  );
  writeFileSync(
    path.join(
      tempRoot,
      "output",
      "compiled",
      SECOND_BRAIN_DEFAULTS.thoughtCompiler.compiledDocumentFramesFilename
    ),
    `${JSON.stringify(
      {
        generatedAt: "2026-04-28T00:00:00.000Z",
        sourceCorpusPath: path.join(tempRoot, "output", "normalized", "unified", "corpus.json"),
        corpusHash,
        model: SECOND_BRAIN_DEFAULTS.codex.defaultModel,
        reasoningEffort: SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort,
        documentCount: 3,
        frameCount: 3,
        subframeCount: 0,
        frames: [
          {
            id: "frame:writing:test-1:01:test-1",
            documentId: "writing:test-1",
            sourceKind: "writing",
            label: "Test 1",
            summary: "Hlavní rámec textu Test 1.",
            scope: "document",
            segmentIds: ["writing:test-1:paragraph:1"],
            startSequenceIndex: 1,
            endSequenceIndex: 1,
            subframeIds: []
          },
          {
            id: "frame:writing:test-2:01:test-2",
            documentId: "writing:test-2",
            sourceKind: "writing",
            label: "Test 2",
            summary: "Hlavní rámec textu Test 2.",
            scope: "document",
            segmentIds: ["writing:test-2:paragraph:1"],
            startSequenceIndex: 1,
            endSequenceIndex: 1,
            subframeIds: []
          },
          {
            id: "frame:writing:test-3:01:test-3",
            documentId: "writing:test-3",
            sourceKind: "writing",
            label: "Test 3",
            summary: "Hlavní rámec textu Test 3.",
            scope: "document",
            segmentIds: ["writing:test-3:paragraph:1"],
            startSequenceIndex: 1,
            endSequenceIndex: 1,
            subframeIds: []
          }
        ],
        subframes: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return paths;
}

function writeLongWritingCorpus(paths: ReturnType<typeof getProjectPaths>): void {
  const corpus = createUnifiedCorpus();
  const longTexts = [
    "Synteticka poznamka porovnava dva zpusoby kalibrace senzoru. Pevny referencni bod zjednodusuje opakovani mereni, ale muze skryt pomaly posun nuly. Prvni cast tvrzeni podporuje stabilni protokol, druha zachovava samostatne napeti a potrebu prubezne kontroly.",
    "Druha synteticka poznamka porovnava jednoduchy a adaptivni predikcni model. Jednoduchy model se lepe vysvetluje, zatimco adaptivni varianta lepe reaguje na sezonni zmenu dat. Nejde o jedno obecne tvrzeni, ale o tezi, jeji omezeni a podminenou volbu podle ucelu.",
    "Treti synteticka poznamka zachycuje revizi experimentu. Puvodni plan vyhodnocoval jen prumernou chybu, pozdejsi verze pridala odolnost vuci odlehlym hodnotam. Obe etapy musi zustat dohledatelne, aby bylo zrejme, co se zmenilo a proc."
  ];

  corpus.segments = corpus.segments.map((segment, index) => ({
    ...segment,
    text: longTexts[index] ?? segment.text,
    textPreview: longTexts[index] ?? segment.textPreview
  }));
  corpus.documents = corpus.documents.map((document, index) => ({
    ...document,
    primaryText: longTexts[index] ?? document.primaryText
  }));
  corpus.timeline = corpus.timeline.map((entry, index) => ({
    ...entry,
    textPreview: longTexts[index] ?? entry.textPreview
  }));
  corpus.primaryTimeline = corpus.primaryTimeline.map((entry, index) => ({
    ...entry,
    textPreview: longTexts[index] ?? entry.textPreview
  }));

  writeFileSync(
    path.join(paths.normalizedUnifiedDir, "corpus.json"),
    `${JSON.stringify(corpus, null, 2)}\n`,
    "utf8"
  );
  const corpusHash = computeStableUnifiedCorpusHash(path.join(paths.normalizedUnifiedDir, "corpus.json"));
  const frameArtifactPath = path.join(
    paths.compiledDir,
    SECOND_BRAIN_DEFAULTS.thoughtCompiler.compiledDocumentFramesFilename
  );
  const frameArtifact = JSON.parse(readFileSync(frameArtifactPath, "utf8"));
  writeFileSync(
    frameArtifactPath,
    `${JSON.stringify(
      {
        ...frameArtifact,
        corpusHash
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function writeLongConversationCorpus(paths: ReturnType<typeof getProjectPaths>): void {
  const longTexts = Array.from({ length: 4 }, (_, index) =>
    `Synteticky turn ${index + 1} formuluje hlavni tezi o kalibraci senzoru podle referencniho mereni. Soucasne zachovava samostatne omezeni: stejny postup muze prehlednout pomaly posun nuly. Z toho odvozuje otevrenou otazku, jak casto referenci obnovovat bez zbytecneho preruseni experimentu. Tyto vrstvy spolu souviseji, ale nejsou jednim obecnym tvrzenim a maji zustat samostatne dohledatelne.`
  );
  const corpus = createConversationCorpus(longTexts);
  const corpusPath = path.join(paths.normalizedUnifiedDir, "corpus.json");
  writeFileSync(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
  const corpusHash = computeStableUnifiedCorpusHash(corpusPath);
  const frameArtifactPath = path.join(
    paths.compiledDir,
    SECOND_BRAIN_DEFAULTS.thoughtCompiler.compiledDocumentFramesFilename
  );
  const frameArtifact = JSON.parse(readFileSync(frameArtifactPath, "utf8"));
  writeFileSync(
    frameArtifactPath,
    `${JSON.stringify(
      {
        ...frameArtifact,
        sourceCorpusPath: corpusPath,
        corpusHash,
        documentCount: 4,
        frameCount: 4,
        frames: corpus.documents.map((document, index) => ({
          id: `frame:conversation:conv-${index + 1}:01:conv-${index + 1}`,
          documentId: document.id,
          sourceKind: "conversation",
          label: `Conversation ${index + 1}`,
          summary: `Hlavni ramec conversation ${index + 1}.`,
          scope: "document",
          segmentIds: [`conversation:conv-${index + 1}:turn:user-${index + 1}`],
          startSequenceIndex: 1,
          endSequenceIndex: 1,
          subframeIds: []
        })),
        subframeCount: 0,
        subframes: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function rewriteUnifiedCorpusGeneratedAt(paths: ReturnType<typeof getProjectPaths>, generatedAt: string): void {
  const corpusPath = path.join(paths.normalizedUnifiedDir, "corpus.json");
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as UnifiedCorpus;
  corpus.generatedAt = generatedAt;
  writeFileSync(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
}

function writeUnifiedCorpusFixture(
  paths: ReturnType<typeof getProjectPaths>,
  corpus: UnifiedCorpus
): void {
  const corpusPath = path.join(paths.normalizedUnifiedDir, "corpus.json");
  writeFileSync(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
}

test("compileThoughtNodes checkpoints manual pauses and resumes from the last successful batch", () => {
  // This locks the core operational contract: process some batches, stop, then
  // continue later without redoing the already-successful Codex calls.
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-compiler-resume-"));

  try {
    const paths = writeCompilerFixture(tempRoot);
    const recordedBatchIds: string[] = [];

    const firstClient = {
      execSemanticBatch: <T,>() => {
        recordedBatchIds.push("batch-0001");
        return {
          args: [],
          exitCode: 0,
          stdout: "",
          stderr: "",
          finalMessage: "",
          jsonEvents: [],
          parsed: {
            batchId: "batch-0001",
            items: [
              {
                inputId: "writing:test-1:paragraph:1",
                nodeCandidates: [
                  {
                    canonicalKey: "limits-of-knowledge",
                    title: "Limits of Knowledge",
                    nodeType: "question",
                    status: "active",
                    summary: "Recurring question about how knowledge is possible.",
                    rationale: "The segment explicitly asks about the limits of knowing.",
                    relatedCanonicalKeys: ["language-and-knowledge"]
                  }
                ]
              },
              {
                inputId: "writing:test-2:paragraph:1",
                nodeCandidates: [
                  {
                    canonicalKey: "language-and-knowledge",
                    title: "Language and Knowledge",
                    nodeType: "theme",
                    status: "active",
                    summary: "Theme about language shaping what can be known.",
                    rationale: "The segment ties language to distorted understanding.",
                    relatedCanonicalKeys: ["limits-of-knowledge"]
                  }
                ]
              }
            ]
          } as T
        };
      }
    };

    const firstSummary = compileThoughtNodes(paths, firstClient, {
      batchSize: 2,
      maxBatches: 1
    });

    assert.equal(firstSummary.status, "paused_manual");
    assert.equal(firstSummary.completedBatchCount, 1);
    assert.equal(firstSummary.processedBatchCount, 1);
    assert.equal(existsSync(firstSummary.checkpointPath), true);

    const secondClient = {
      execSemanticBatch: <T,>() => {
        recordedBatchIds.push("batch-0002");
        return {
          args: [],
          exitCode: 0,
          stdout: "",
          stderr: "",
          finalMessage: "",
          jsonEvents: [],
          parsed: {
            batchId: "batch-0002",
            items: [
              {
                inputId: "writing:test-3:paragraph:1",
                nodeCandidates: [
                  {
                    canonicalKey: "limits-of-knowledge",
                    title: "Limits of Knowledge",
                    nodeType: "question",
                    status: "active",
                    summary: "Recurring question about truth and the limits of knowledge.",
                    rationale: "The segment returns to knowledge, truth, and language.",
                    relatedCanonicalKeys: ["language-and-knowledge"]
                  }
                ]
              }
            ]
          } as T
        };
      }
    };

    const secondSummary = compileThoughtNodes(paths, secondClient, {
      batchSize: 2
    });

    assert.equal(secondSummary.runId, firstSummary.runId);
    assert.equal(secondSummary.status, "completed");
    assert.equal(secondSummary.completedBatchCount, 2);
    assert.equal(secondSummary.processedBatchCount, 1);
    assert.equal(secondSummary.incremental.mode, "exact_run_resume");
    assert.equal(secondSummary.incremental.semanticItems, null);
    assert.deepEqual(recordedBatchIds, ["batch-0001", "batch-0002"]);

    const claimsPath = path.join(paths.compiledDir, "thought_claims.json");
    const identityBlocksPath = path.join(paths.compiledDir, "thought_identity_blocks.json");
    const nodeStatesPath = path.join(paths.compiledDir, "thought_node_states.json");
    const worldlinesPath = path.join(paths.compiledDir, "thought_worldlines.json");
    const nodes = JSON.parse(readFileSync(secondSummary.nodesPath, "utf8")) as Array<{
      id: string;
      evidence: unknown[];
    }>;
    const graph = JSON.parse(readFileSync(secondSummary.graphPath, "utf8")) as {
      claimCount: number;
      nodeStateCount: number;
      worldlineCount: number;
      identityBlockCount: number;
    };
    assert.equal(nodes.length, 2);
    assert.equal(nodes.find((node) => node.id === "thought:limits-of-knowledge")?.evidence.length, 2);
    assert.equal(existsSync(claimsPath), true);
    assert.equal(existsSync(identityBlocksPath), true);
    assert.equal(existsSync(nodeStatesPath), true);
    assert.equal(existsSync(worldlinesPath), true);
    assert.equal(graph.claimCount, 3);
    assert.equal(graph.nodeStateCount >= 2, true);
    assert.equal(graph.worldlineCount, 2);
    assert.equal(graph.identityBlockCount, 2);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("compileThoughtNodes ignoreCheckpoint reruns pending items instead of resuming a completed run", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-compiler-ignore-checkpoint-"));

  try {
    const paths = writeCompilerFixture(tempRoot);
    let callCount = 0;
    const client = {
      execSemanticBatch: <T,>(request: { prompt: string }) => {
        callCount += 1;
        const batchId = request.prompt.match(/"batchId": "([^"]+)"/)?.[1] ?? "batch-0001";
        const inputIds = Array.from(request.prompt.matchAll(/"inputId": "([^"]+)"/g)).map(
          (match) => match[1] ?? ""
        );
        return {
          args: [],
          exitCode: 0,
          stdout: "",
          stderr: "",
          finalMessage: "",
          jsonEvents: [],
          parsed: {
            batchId,
            items: inputIds.map((inputId, index) => ({
              inputId,
              nodeCandidates: [
                {
                  canonicalKey: `rerun-${callCount}-${index + 1}`,
                  title: `Rerun ${callCount}.${index + 1}`,
                  nodeType: "theme",
                  status: "active",
                  summary: "Deterministic checkpoint bypass test output.",
                  rationale: "The uncached semantic item must execute again.",
                  relatedCanonicalKeys: []
                }
              ]
            }))
          } as T
        };
      }
    };

    const firstSummary = compileThoughtNodes(paths, client, { batchSize: 10 });
    rmSync(firstSummary.semanticCachePath ?? "", { force: true });
    const secondSummary = compileThoughtNodes(paths, client, {
      batchSize: 10,
      ignoreCheckpoint: true
    });

    assert.equal(firstSummary.status, "completed");
    assert.equal(secondSummary.status, "completed");
    assert.notEqual(secondSummary.runId, firstSummary.runId);
    assert.equal(secondSummary.processedBatchCount, 1);
    assert.equal(callCount, 2);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("compileThoughtNodes resumes after unified regeneration when only generatedAt changes", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-compiler-stable-hash-"));

  try {
    const paths = writeCompilerFixture(tempRoot);
    const recordedBatchIds: string[] = [];

    const firstClient = {
      execSemanticBatch: <T,>() => {
        recordedBatchIds.push("batch-0001");
        return {
          args: [],
          exitCode: 0,
          stdout: "",
          stderr: "",
          finalMessage: "",
          jsonEvents: [],
          parsed: {
            batchId: "batch-0001",
            items: [
              {
                inputId: "writing:test-1:paragraph:1",
                nodeCandidates: [
                  {
                    canonicalKey: "limits-of-knowledge",
                    title: "Limits of Knowledge",
                    nodeType: "question",
                    status: "active",
                    summary: "Recurring question about how knowledge is possible.",
                    rationale: "The segment explicitly asks about the limits of knowing.",
                    relatedCanonicalKeys: ["language-and-knowledge"]
                  }
                ]
              },
              {
                inputId: "writing:test-2:paragraph:1",
                nodeCandidates: [
                  {
                    canonicalKey: "language-and-knowledge",
                    title: "Language and Knowledge",
                    nodeType: "theme",
                    status: "active",
                    summary: "Theme about language shaping what can be known.",
                    rationale: "The segment ties language to distorted understanding.",
                    relatedCanonicalKeys: ["limits-of-knowledge"]
                  }
                ]
              }
            ]
          } as T
        };
      }
    };

    const firstSummary = compileThoughtNodes(paths, firstClient, {
      batchSize: 2,
      maxBatches: 1
    });

    rewriteUnifiedCorpusGeneratedAt(paths, "2026-05-01T00:00:00.000Z");

    const secondClient = {
      execSemanticBatch: <T,>() => {
        recordedBatchIds.push("batch-0002");
        return {
          args: [],
          exitCode: 0,
          stdout: "",
          stderr: "",
          finalMessage: "",
          jsonEvents: [],
          parsed: {
            batchId: "batch-0002",
            items: [
              {
                inputId: "writing:test-3:paragraph:1",
                nodeCandidates: [
                  {
                    canonicalKey: "limits-of-knowledge",
                    title: "Limits of Knowledge",
                    nodeType: "question",
                    status: "active",
                    summary: "Recurring question about truth and the limits of knowledge.",
                    rationale: "The segment returns to knowledge, truth, and language.",
                    relatedCanonicalKeys: ["language-and-knowledge"]
                  }
                ]
              }
            ]
          } as T
        };
      }
    };

    const secondSummary = compileThoughtNodes(paths, secondClient, {
      batchSize: 2
    });

    assert.equal(secondSummary.runId, firstSummary.runId);
    assert.equal(secondSummary.status, "completed");
    assert.deepEqual(recordedBatchIds, ["batch-0001", "batch-0002"]);

    rewriteUnifiedCorpusGeneratedAt(paths, "2026-05-02T00:00:00.000Z");

    const thirdSummary = compileThoughtNodes(
      paths,
      {
        execSemanticBatch: () => {
          throw new Error("completed compile should be reused without another LLM call");
        }
      },
      {
        batchSize: 2
      }
    );

    assert.equal(thirdSummary.runId, firstSummary.runId);
    assert.equal(thirdSummary.status, "completed");
    assert.equal(thirdSummary.processedBatchCount, 0);
    assert.deepEqual(recordedBatchIds, ["batch-0001", "batch-0002"]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("compileThoughtNodes strict mode does not reuse cached semantic work when model changes", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-compiler-model-mismatch-"));

  try {
    const paths = writeCompilerFixture(tempRoot);

    let firstCallCount = 0;
    const firstClient = {
      execSemanticBatch: <T,>() => {
        firstCallCount += 1;

        if (firstCallCount === 1) {
          return {
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              batchId: "batch-0001",
              items: [
                {
                  inputId: "writing:test-1:paragraph:1",
                  nodeCandidates: [
                    {
                      canonicalKey: "knowledge-limits",
                      title: "Knowledge Limits",
                      nodeType: "question",
                      status: "active",
                      summary: "Summary 1",
                      rationale: "Rationale 1",
                      relatedCanonicalKeys: []
                    }
                  ]
                },
                {
                  inputId: "writing:test-2:paragraph:1",
                  nodeCandidates: [
                    {
                      canonicalKey: "language-shapes-knowing",
                      title: "Language Shapes Knowing",
                      nodeType: "theme",
                      status: "active",
                      summary: "Summary 2",
                      rationale: "Rationale 2",
                      relatedCanonicalKeys: []
                    }
                  ]
                }
              ]
            } as T
          };
        }

        return {
          args: [],
          exitCode: 0,
          stdout: "",
          stderr: "",
          finalMessage: "",
          jsonEvents: [],
          parsed: {
            batchId: "batch-0002",
            items: [
              {
                inputId: "writing:test-3:paragraph:1",
                nodeCandidates: [
                  {
                    canonicalKey: "truth-and-language",
                    title: "Truth and Language",
                    nodeType: "thesis",
                    status: "active",
                    summary: "Summary 3",
                    rationale: "Rationale 3",
                    relatedCanonicalKeys: []
                  }
                ]
              }
            ]
          } as T
        };
      }
    };

    const firstSummary = compileThoughtNodes(paths, firstClient, {
      batchSize: 2,
      model: "gpt-5.4",
      reasoningEffort: "medium"
    });

    assert.equal(firstSummary.status, "completed");
    assert.equal(firstCallCount, 2);

    let secondCallCount = 0;
    const secondClient = {
      execSemanticBatch: <T,>(request: { prompt: string }) => {
        secondCallCount += 1;

        const documentId = request.prompt.match(/"documentId": "([^"]+)"/)?.[1] ?? null;
        if (documentId) {
          return {
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              documentId,
              documentSummary: `Premium local outline for ${documentId}.`,
              frames: [
                {
                  label: `Premium ${documentId}`,
                  summary: `Fresh strict-mode frame extraction for ${documentId}.`,
                  outlineRole: "opening",
                  outlineRationale: "Changing the compiler contract in strict mode refreshes frame hints too.",
                  returnTargetSegmentId: null,
                  segmentIds: Array.from(
                    request.prompt.matchAll(/"segmentId": "([^"]+)"/g)
                  ).map((match) => match[1] ?? ""),
                  subframes: []
                }
              ]
            } as T
          };
        }

        const batchId = request.prompt.match(/"batchId": "([^"]+)"/)?.[1] ?? "batch-0001";
        if (batchId === "batch-0001") {
          return {
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              batchId,
              items: [
                {
                  inputId: "writing:test-1:paragraph:1",
                  nodeCandidates: [
                    {
                      canonicalKey: "knowledge-limits-premium",
                      title: "Knowledge Limits Premium",
                      nodeType: "question",
                      status: "active",
                      summary: "Premium summary 1",
                      rationale: "Premium rationale 1",
                      relatedCanonicalKeys: []
                    }
                  ]
                },
                {
                  inputId: "writing:test-2:paragraph:1",
                  nodeCandidates: [
                    {
                      canonicalKey: "language-shapes-knowing-premium",
                      title: "Language Shapes Knowing Premium",
                      nodeType: "theme",
                      status: "active",
                      summary: "Premium summary 2",
                      rationale: "Premium rationale 2",
                      relatedCanonicalKeys: []
                    }
                  ]
                }
              ]
            } as T
          };
        }

        return {
          args: [],
          exitCode: 0,
          stdout: "",
          stderr: "",
          finalMessage: "",
          jsonEvents: [],
          parsed: {
            batchId,
            items: [
              {
                inputId: "writing:test-3:paragraph:1",
                nodeCandidates: [
                  {
                    canonicalKey: "truth-and-language-premium",
                    title: "Truth and Language Premium",
                    nodeType: "thesis",
                    status: "active",
                    summary: "Premium summary 3",
                    rationale: "Premium rationale 3",
                    relatedCanonicalKeys: []
                  }
                ]
              }
            ]
          } as T
        };
      }
    };

    const secondSummary = compileThoughtNodes(paths, secondClient, {
      batchSize: 2,
      model: "test-model-b",
      reasoningEffort: "high",
      semanticReusePolicy: "strict"
    });

    assert.notEqual(secondSummary.runId, firstSummary.runId);
    assert.equal(secondSummary.status, "completed");
    // Strict mode refreshes the three source-local frames and both semantic
    // batches because the requested model deliberately differs from the fixture
    // artifact.
    assert.equal(secondCallCount, 5);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("compileThoughtNodes reuses cached semantic contributions after additive corpus changes", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-compiler-incremental-cache-"));

  try {
    writeFileSync(path.join(tempRoot, "package.json"), "{}\n", "utf8");
    mkdirSync(path.join(tempRoot, "input"), { recursive: true });
    mkdirSync(path.join(tempRoot, "output", "normalized", "unified"), { recursive: true });
    mkdirSync(path.join(tempRoot, "output", "compiled"), { recursive: true });
    const paths = getProjectPaths(tempRoot);
    writeUnifiedCorpusFixture(
      paths,
      createConversationCorpus([
        "Prvni synteticky konverzacni zaznam o vlhkosti pudy.",
        "Druha realna konverzacni myslenka o jazyce."
      ])
    );

    const requestedInputIds: string[][] = [];
    const client = {
      execSemanticBatch: <T,>(request: { prompt: string }) => {
        const documentId = request.prompt.match(/"documentId": "([^"]+)"/)?.[1] ?? null;
        if (documentId) {
          return {
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              documentId,
              documentSummary: `Lokální outline pro ${documentId}.`,
              frames: [
                {
                  label: `Rámec ${documentId}`,
                  summary: `Jeden hlavní rámec pro ${documentId}.`,
                  outlineRole: "opening",
                  outlineRationale: "Jednosegmentová conversation drží jednu hlavní linii.",
                  returnTargetSegmentId: null,
                  segmentIds: Array.from(
                    request.prompt.matchAll(/"segmentId": "([^"]+)"/g)
                  ).map((match) => match[1] ?? ""),
                  subframes: []
                }
              ]
            } as T
          };
        }

        const inputIds = Array.from(request.prompt.matchAll(/"inputId": "([^"]+)"/g)).map(
          (match) => match[1] ?? ""
        );
        const batchId = request.prompt.match(/"batchId": "([^"]+)"/)?.[1] ?? "batch-0001";
        requestedInputIds.push(inputIds);

        return {
          args: [],
          exitCode: 0,
          stdout: "",
          stderr: "",
          finalMessage: "",
          jsonEvents: [],
          parsed: {
            batchId,
            items: inputIds.map((inputId, index) => ({
              inputId,
              nodeCandidates: [
                {
                  canonicalKey: `incremental-${inputId.split(":")[1] ?? index}`,
                  title: `Incremental ${index + 1}`,
                  nodeType: "theme",
                  status: "active",
                  summary: `Cached semantic output for ${inputId}.`,
                  rationale: "The test client returns one deterministic candidate per input.",
                  relatedCanonicalKeys: []
                }
              ]
            }))
          } as T
        };
      }
    };

    const firstSummary = compileThoughtNodes(paths, client, {
      batchSize: 10
    });

    assert.equal(firstSummary.status, "completed");
    assert.equal(firstSummary.reusedSemanticItemCount, 0);
    assert.equal(firstSummary.pendingSemanticItemCount, 2);
    assert.deepEqual(requestedInputIds, [
      [
        "conversation:conv-1:turn:user-1",
        "conversation:conv-2:turn:user-2"
      ]
    ]);

    writeUnifiedCorpusFixture(
      paths,
      createConversationCorpus([
        "Prvni synteticky konverzacni zaznam o vlhkosti pudy.",
        "Druha realna konverzacni myslenka o jazyce.",
        "Treti pridana konverzacni myslenka o case."
      ])
    );

    const secondSummary = compileThoughtNodes(paths, client, {
      batchSize: 10
    });

    assert.equal(secondSummary.status, "completed");
    assert.equal(secondSummary.reusedSemanticItemCount, 2);
    assert.equal(secondSummary.pendingSemanticItemCount, 1);
    assert.equal(secondSummary.incremental.mode, "incremental_cache");
    assert.deepEqual(secondSummary.incremental.semanticItems, {
      totalPrimarySegmentCount: 3,
      reusedCount: 2,
      reusedCurrentContractCount: 0,
      reusedPriorContractCount: 2,
      newCount: 1
    });
    assert.equal(secondSummary.incremental.sourceDiff?.documents.addedCount, 1);
    assert.equal(secondSummary.incremental.sourceDiff?.primarySegments.addedCount, 1);
    assert.deepEqual(requestedInputIds, [
      [
        "conversation:conv-1:turn:user-1",
        "conversation:conv-2:turn:user-2"
      ],
      ["conversation:conv-3:turn:user-3"]
    ]);
    assert.equal(existsSync(secondSummary.semanticCachePath ?? ""), true);
    assert.equal(existsSync(secondSummary.segmentIndexPath ?? ""), true);
    assert.equal(existsSync(secondSummary.compileManifestPath ?? ""), true);
    const segmentIndex = JSON.parse(
      readFileSync(secondSummary.segmentIndexPath ?? "", "utf8")
    ) as {
      diff: {
        previousCorpusHash: string | null;
        documents: {
          unchangedCount: number;
          addedCount: number;
          changedCount: number;
          removedCount: number;
          addedDocumentIds: string[];
        };
        primarySegments: {
          unchangedCount: number;
          addedCount: number;
          changedCount: number;
          removedCount: number;
          bySourceKind: {
            conversation: {
              unchangedCount: number;
              addedCount: number;
              changedCount: number;
              removedCount: number;
            };
          };
        };
      };
    };
    assert.equal(typeof segmentIndex.diff.previousCorpusHash, "string");
    assert.equal(segmentIndex.diff.documents.unchangedCount, 2);
    assert.equal(segmentIndex.diff.documents.addedCount, 1);
    assert.deepEqual(segmentIndex.diff.documents.addedDocumentIds, ["conversation:conv-3"]);
    assert.equal(segmentIndex.diff.documents.changedCount, 0);
    assert.equal(segmentIndex.diff.documents.removedCount, 0);
    assert.equal(segmentIndex.diff.primarySegments.unchangedCount, 2);
    assert.equal(segmentIndex.diff.primarySegments.addedCount, 1);
    assert.equal(segmentIndex.diff.primarySegments.changedCount, 0);
    assert.equal(segmentIndex.diff.primarySegments.removedCount, 0);
    assert.equal(segmentIndex.diff.primarySegments.bySourceKind.conversation.addedCount, 1);
    const compileManifest = JSON.parse(
      readFileSync(secondSummary.compileManifestPath ?? "", "utf8")
    ) as {
      incremental: {
        mode: string;
        semanticItems: {
          totalPrimarySegmentCount: number;
          reusedCount: number;
          reusedCurrentContractCount: number;
          reusedPriorContractCount: number;
          newCount: number;
        } | null;
        sourceDiff: {
          documents: {
            addedCount: number;
          };
          primarySegments: {
            addedCount: number;
          };
        } | null;
      };
    };
    assert.equal(compileManifest.incremental.mode, "incremental_cache");
    assert.deepEqual(compileManifest.incremental.semanticItems, {
      totalPrimarySegmentCount: 3,
      reusedCount: 2,
      reusedCurrentContractCount: 0,
      reusedPriorContractCount: 2,
      newCount: 1
    });
    assert.equal(compileManifest.incremental.sourceDiff?.documents.addedCount, 1);
    assert.equal(compileManifest.incremental.sourceDiff?.primarySegments.addedCount, 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("compileThoughtNodes mixed mode reuses prior-contract segments and document frames after additive model changes", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-compiler-mixed-model-incremental-"));

  try {
    writeFileSync(path.join(tempRoot, "package.json"), "{}\n", "utf8");
    mkdirSync(path.join(tempRoot, "input"), { recursive: true });
    mkdirSync(path.join(tempRoot, "output", "normalized", "unified"), { recursive: true });
    mkdirSync(path.join(tempRoot, "output", "compiled"), { recursive: true });
    const paths = getProjectPaths(tempRoot);
    writeUnifiedCorpusFixture(
      paths,
      createConversationCorpus([
        "Prvni synteticky konverzacni zaznam o vlhkosti pudy.",
        "Druha realna konverzacni myslenka o jazyce."
      ])
    );

    const firstFrameDocumentIds: string[] = [];
    const firstSemanticInputIds: string[][] = [];
    const firstClient = {
      execSemanticBatch: <T,>(request: { prompt: string }) => {
        const documentId = request.prompt.match(/"documentId": "([^"]+)"/)?.[1] ?? null;
        if (documentId) {
          firstFrameDocumentIds.push(documentId);
          return {
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              documentId,
              documentSummary: `Lokální outline pro ${documentId}.`,
              frames: [
                {
                  label: `Rámec ${documentId}`,
                  summary: `Jeden hlavní rámec pro ${documentId}.`,
                  outlineRole: "opening",
                  outlineRationale: "Jednosegmentová conversation drží jednu hlavní linii.",
                  returnTargetSegmentId: null,
                  segmentIds: Array.from(
                    request.prompt.matchAll(/"segmentId": "([^"]+)"/g)
                  ).map((match) => match[1] ?? ""),
                  subframes: []
                }
              ]
            } as T
          };
        }

        const inputIds = Array.from(request.prompt.matchAll(/"inputId": "([^"]+)"/g)).map(
          (match) => match[1] ?? ""
        );
        const batchId = request.prompt.match(/"batchId": "([^"]+)"/)?.[1] ?? "batch-0001";
        firstSemanticInputIds.push(inputIds);

        return {
          args: [],
          exitCode: 0,
          stdout: "",
          stderr: "",
          finalMessage: "",
          jsonEvents: [],
          parsed: {
            batchId,
            items: inputIds.map((inputId, index) => ({
              inputId,
              nodeCandidates: [
                {
                  canonicalKey: `low-${inputId.split(":")[1] ?? index}`,
                  title: `Low ${index + 1}`,
                  nodeType: "theme",
                  status: "active",
                  summary: `Low-cost semantic output for ${inputId}.`,
                  rationale: "The baseline run emits one deterministic node per input.",
                  relatedCanonicalKeys: []
                }
              ]
            }))
          } as T
        };
      }
    };

    const firstSummary = compileThoughtNodes(paths, firstClient, {
      batchSize: 10,
      model: "gpt-5.4",
      reasoningEffort: "low"
    });

    assert.equal(firstSummary.status, "completed");
    assert.deepEqual(firstFrameDocumentIds, ["conversation:conv-1", "conversation:conv-2"]);
    assert.deepEqual(firstSemanticInputIds, [[
      "conversation:conv-1:turn:user-1",
      "conversation:conv-2:turn:user-2"
    ]]);

    writeUnifiedCorpusFixture(
      paths,
      createConversationCorpus([
        "Prvni synteticky konverzacni zaznam o vlhkosti pudy.",
        "Druha realna konverzacni myslenka o jazyce.",
        "Treti pridana konverzacni myslenka o case."
      ])
    );

    const secondFrameDocumentIds: string[] = [];
    const secondSemanticInputIds: string[][] = [];
    const secondClient = {
      execSemanticBatch: <T,>(request: { prompt: string }) => {
        const documentId = request.prompt.match(/"documentId": "([^"]+)"/)?.[1] ?? null;
        if (documentId) {
          secondFrameDocumentIds.push(documentId);
          return {
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              documentId,
              documentSummary: `Prémiový outline pro ${documentId}.`,
              frames: [
                {
                  label: `Prémiový rámec ${documentId}`,
                  summary: `Nově přidaný dokument dostává prémiový frame pass.`,
                  outlineRole: "opening",
                  outlineRationale: "Nový dokument se musí zpracovat aktuálním kontraktem.",
                  returnTargetSegmentId: null,
                  segmentIds: Array.from(
                    request.prompt.matchAll(/"segmentId": "([^"]+)"/g)
                  ).map((match) => match[1] ?? ""),
                  subframes: []
                }
              ]
            } as T
          };
        }

        const inputIds = Array.from(request.prompt.matchAll(/"inputId": "([^"]+)"/g)).map(
          (match) => match[1] ?? ""
        );
        const batchId = request.prompt.match(/"batchId": "([^"]+)"/)?.[1] ?? "batch-0001";
        secondSemanticInputIds.push(inputIds);

        return {
          args: [],
          exitCode: 0,
          stdout: "",
          stderr: "",
          finalMessage: "",
          jsonEvents: [],
          parsed: {
            batchId,
            items: inputIds.map((inputId, index) => ({
              inputId,
              nodeCandidates: [
                {
                  canonicalKey: `high-${inputId.split(":")[1] ?? index}`,
                  title: `High ${index + 1}`,
                  nodeType: "theme",
                  status: "active",
                  summary: `Premium semantic output for ${inputId}.`,
                  rationale: "Only newly added semantic inputs should hit the premium model.",
                  relatedCanonicalKeys: []
                }
              ]
            }))
          } as T
        };
      }
    };

    const secondSummary = compileThoughtNodes(paths, secondClient, {
      batchSize: 10,
      model: "gpt-5.5",
      reasoningEffort: "high"
    });

    assert.equal(secondSummary.status, "completed");
    assert.equal(secondSummary.reusedSemanticItemCount, 2);
    assert.equal(secondSummary.pendingSemanticItemCount, 1);
    assert.deepEqual(secondSummary.incremental.semanticItems, {
      totalPrimarySegmentCount: 3,
      reusedCount: 2,
      reusedCurrentContractCount: 0,
      reusedPriorContractCount: 2,
      newCount: 1
    });
    assert.deepEqual(secondFrameDocumentIds, ["conversation:conv-3"]);
    assert.deepEqual(secondSemanticInputIds, [["conversation:conv-3:turn:user-3"]]);

    const segmentIndex = JSON.parse(
      readFileSync(secondSummary.segmentIndexPath ?? "", "utf8")
    ) as {
      segments: Record<
        string,
        {
          semanticCompilerModel?: string | null;
          semanticCompilerReasoningEffort?: string | null;
        }
      >;
    };

    assert.equal(
      segmentIndex.segments["conversation:conv-1:turn:user-1"]?.semanticCompilerModel,
      "gpt-5.4"
    );
    assert.equal(
      segmentIndex.segments["conversation:conv-1:turn:user-1"]?.semanticCompilerReasoningEffort,
      "low"
    );
    assert.equal(
      segmentIndex.segments["conversation:conv-2:turn:user-2"]?.semanticCompilerModel,
      "gpt-5.4"
    );
    assert.equal(
      segmentIndex.segments["conversation:conv-3:turn:user-3"]?.semanticCompilerModel,
      "gpt-5.5"
    );
    assert.equal(
      segmentIndex.segments["conversation:conv-3:turn:user-3"]?.semanticCompilerReasoningEffort,
      "high"
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("compileThoughtNodes force-new-run bypasses cached document frames and regenerates them", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-compiler-force-frames-"));

  try {
    const paths = writeCompilerFixture(tempRoot);
    const documentFramesPath = path.join(
      paths.compiledDir,
      SECOND_BRAIN_DEFAULTS.thoughtCompiler.compiledDocumentFramesFilename
    );
    const cachedFrames = JSON.parse(readFileSync(documentFramesPath, "utf8")) as {
      generatedAt: string;
      frames: Array<{ label: string }>;
    };

    let callCount = 0;
    const client = {
      execSemanticBatch: <T,>() => {
        callCount += 1;

        if (callCount <= 3) {
          const documentIndex = callCount;
          return {
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              documentId: `writing:test-${documentIndex}`,
              documentSummary: `Fresh local outline for test ${documentIndex}.`,
              frames: [
                {
                  label: `Regenerated Test ${documentIndex}`,
                  summary: `Fresh frame for test ${documentIndex}.`,
                  outlineRole: "opening",
                  outlineRationale: `The document keeps one broad opening line for test ${documentIndex}.`,
                  returnTargetSegmentId: null,
                  segmentIds: [`writing:test-${documentIndex}:paragraph:1`],
                  subframes: []
                }
              ]
            } as T
          };
        }

        const batchIndex = callCount - 3;
        const documentIndex = batchIndex;
        return {
          args: [],
          exitCode: 0,
          stdout: "",
          stderr: "",
          finalMessage: "",
          jsonEvents: [],
          parsed: {
            batchId: `batch-${String(batchIndex).padStart(4, "0")}`,
            items: [
              {
                inputId: `writing:test-${documentIndex}:paragraph:1`,
                nodeCandidates: [
                  {
                    canonicalKey: `fresh-test-${documentIndex}`,
                    title: `Fresh Test ${documentIndex}`,
                    nodeType: "theme",
                    status: "active",
                    summary: `Fresh summary ${documentIndex}.`,
                    rationale: `Fresh rationale ${documentIndex}.`,
                    relatedCanonicalKeys: []
                  }
                ]
              }
            ]
          } as T
        };
      }
    };

    const summary = compileThoughtNodes(paths, client, {
      batchSize: 1,
      forceNewRun: true
    });

    assert.equal(summary.status, "completed");
    assert.equal(callCount, 6);

    const refreshedFrames = JSON.parse(readFileSync(documentFramesPath, "utf8")) as {
      generatedAt: string;
      frames: Array<{ label: string }>;
    };

    assert.notEqual(refreshedFrames.generatedAt, cachedFrames.generatedAt);
    assert.deepEqual(
      refreshedFrames.frames.map((frame) => frame.label).sort((left, right) => left.localeCompare(right)),
      ["Regenerated Test 1", "Regenerated Test 2", "Regenerated Test 3"]
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("compileThoughtNodes retries malformed structured batch output before failing the run", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-compiler-retry-"));

  try {
    const paths = writeCompilerFixture(tempRoot);
    let callCount = 0;

    const client = {
      execSemanticBatch: <T,>() => {
        callCount += 1;

        if (callCount === 1) {
          return {
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              batchId: "batch-0001",
              items: [
                {
                  inputId: "writing:test-1:paragraph:1",
                  nodeCandidates: []
                },
                {
                  inputId: "writing:test-2:paragraph:1",
                  nodeCandidates: []
                },
                {
                  inputId: "writing:test-2:paragraph:1",
                  nodeCandidates: []
                }
              ]
            } as T
          };
        }

        if (callCount === 2) {
          return {
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              batchId: "batch-0001",
              items: [
                {
                  inputId: "writing:test-1:paragraph:1",
                  nodeCandidates: []
                },
                {
                  inputId: "writing:test-2:paragraph:1",
                  nodeCandidates: []
                }
              ]
            } as T
          };
        }

        return {
          args: [],
          exitCode: 0,
          stdout: "",
          stderr: "",
          finalMessage: "",
          jsonEvents: [],
          parsed: {
            batchId: "batch-0002",
            items: [
              {
                inputId: "writing:test-3:paragraph:1",
                nodeCandidates: []
              }
            ]
          } as T
        };
      }
    };

    const summary = compileThoughtNodes(paths, client, {
      batchSize: 2
    });

    assert.equal(summary.status, "completed");
    assert.equal(callCount, 3);
    assert.equal(summary.completedBatchCount, 2);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("compileThoughtNodes retries semantically sparse authored-writing batches", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-compiler-sparse-writing-"));

  try {
    const paths = writeCompilerFixture(tempRoot);
    writeLongWritingCorpus(paths);
    let callCount = 0;
    const prompts: string[] = [];

    const client = {
      execSemanticBatch: <T,>(request: { prompt: string }) => {
        callCount += 1;
        prompts.push(request.prompt);

        const sparseItems = [1, 2, 3].map((itemNumber) => ({
          inputId: `writing:test-${itemNumber}:paragraph:1`,
          nodeCandidates: [
            {
              canonicalKey: `generic-thought-${itemNumber}`,
              title: `Generic Thought ${itemNumber}`,
              nodeType: "theme",
              status: "active",
              summary: "A broad umbrella node that collapses multiple durable signals.",
              rationale: "The segment has durable meaning but this output is too sparse.",
              claim: `Generic claim ${itemNumber}`,
              identityAliases: [],
              documentFrameId: `frame:writing:test-${itemNumber}:01:test-${itemNumber}`,
              documentSubframeId: null,
              frameRole: "main_claim",
              relatedCanonicalKeys: [],
              relationProposals: []
            }
          ]
        }));

        const denseItems = [1, 2, 3].map((itemNumber) => ({
          inputId: `writing:test-${itemNumber}:paragraph:1`,
          nodeCandidates: [
            {
              canonicalKey: `main-thought-${itemNumber}`,
              title: `Main Thought ${itemNumber}`,
              nodeType: "thesis",
              status: "active",
              summary: "Main durable claim.",
              rationale: "The paragraph states a main durable claim.",
              claim: `Main claim ${itemNumber}`,
              identityAliases: [],
              documentFrameId: `frame:writing:test-${itemNumber}:01:test-${itemNumber}`,
              documentSubframeId: null,
              frameRole: "main_claim",
              relatedCanonicalKeys: [],
              relationProposals: []
            },
            {
              canonicalKey: `tension-thought-${itemNumber}`,
              title: `Tension Thought ${itemNumber}`,
              nodeType: "tension",
              status: "active",
              summary: "Secondary tension preserved separately from the main claim.",
              rationale: "The paragraph contains a second durable tension or revision signal.",
              claim: `Tension claim ${itemNumber}`,
              identityAliases: [],
              documentFrameId: `frame:writing:test-${itemNumber}:01:test-${itemNumber}`,
              documentSubframeId: null,
              frameRole: "tension",
              relatedCanonicalKeys: [`main-thought-${itemNumber}`],
              relationProposals: [
                {
                  targetCanonicalKey: `main-thought-${itemNumber}`,
                  type: "tensions_with",
                  rationale: "The secondary signal is in tension with the main claim."
                }
              ]
            }
          ]
        }));

        return {
          args: [],
          exitCode: 0,
          stdout: "",
          stderr: "",
          finalMessage: "",
          jsonEvents: [],
          parsed: {
            batchId: "batch-0001",
            items: callCount === 1 ? sparseItems : denseItems
          } as T
        };
      }
    };

    const summary = compileThoughtNodes(paths, client, {
      batchSize: 3
    });
    const claims = JSON.parse(
      readFileSync(
        path.join(paths.compiledDir, SECOND_BRAIN_DEFAULTS.thoughtCompiler.compiledClaimsFilename),
        "utf8"
      )
    ) as unknown[];

    assert.equal(summary.status, "completed");
    assert.equal(callCount, 2);
    assert.equal(claims.length, 6);
    assert.match(prompts[1] ?? "", /Previous validator error:.*authored writing segments/s);
    assert.match(
      prompts[1] ?? "",
      /Across the 3 eligible authored-writing rows, return at least 5 semantically distinct nodeCandidates in total\./
    );
    assert.match(prompts[1] ?? "", /writing:test-1:paragraph:1/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("compileThoughtNodes accepts valid long-conversation output without density retries", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-compiler-sparse-conversation-"));

  try {
    const paths = writeCompilerFixture(tempRoot);
    writeLongConversationCorpus(paths);
    let callCount = 0;
    const prompts: string[] = [];

    const client = {
      execSemanticBatch: <T,>(request: { prompt: string }) => {
        callCount += 1;
        prompts.push(request.prompt);
        const candidateCount = 1;
        return {
          args: [],
          exitCode: 0,
          stdout: "",
          stderr: "",
          finalMessage: "",
          jsonEvents: [],
          parsed: {
            batchId: "batch-0001",
            items: Array.from({ length: 4 }, (_, index) => {
              const itemNumber = index + 1;
              return {
                inputId: `conversation:conv-${itemNumber}:turn:user-${itemNumber}`,
                nodeCandidates: Array.from({ length: candidateCount }, (__, candidateIndex) => ({
                  canonicalKey: `conversation-${itemNumber}-signal-${candidateIndex + 1}`,
                  title: `Conversation ${itemNumber} Signal ${candidateIndex + 1}`,
                  nodeType: candidateIndex === 0 ? "thesis" : "tension",
                  status: "active",
                  summary: "Samostatny trvaly signal z delsiho reflektivniho turnu.",
                  rationale: "Turn obsahuje nekolik semanticky samostatnych vrstev.",
                  claim: `Signal ${candidateIndex + 1}`,
                  identityAliases: [],
                  documentFrameId: `frame:conversation:conv-${itemNumber}:01:conv-${itemNumber}`,
                  documentSubframeId: null,
                  frameRole: candidateIndex === 0 ? "main_claim" : "tension",
                  relatedCanonicalKeys: [],
                  relationProposals: []
                }))
              };
            })
          } as T
        };
      }
    };

    const summary = compileThoughtNodes(paths, client, { batchSize: 4 });
    const claims = JSON.parse(
      readFileSync(
        path.join(paths.compiledDir, SECOND_BRAIN_DEFAULTS.thoughtCompiler.compiledClaimsFilename),
        "utf8"
      )
    ) as unknown[];

    assert.equal(summary.status, "completed");
    assert.equal(callCount, 1);
    assert.equal(claims.length, 4);
    assert.match(prompts[0] ?? "", /delších reflektivních conversation turnů/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("compileThoughtNodes falls back to singleton repair when one batch keeps breaking the structured contract", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-compiler-singleton-repair-"));

  try {
    const paths = writeCompilerFixture(tempRoot);
    let callCount = 0;

    const client = {
      execSemanticBatch: <T,>() => {
        callCount += 1;

        // First batch keeps failing with one duplicated row even after retries.
        if (callCount <= 3) {
          return {
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              batchId: "batch-0001",
              items: [
                {
                  inputId: "writing:test-1:paragraph:1",
                  nodeCandidates: []
                },
                {
                  inputId: "writing:test-2:paragraph:1",
                  nodeCandidates: []
                },
                {
                  inputId: "writing:test-2:paragraph:1",
                  nodeCandidates: []
                }
              ]
            } as T
          };
        }

        if (callCount === 4) {
          return {
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              batchId: "batch-0001-repair-01",
              items: [
                {
                  inputId: "writing:test-1:paragraph:1",
                  nodeCandidates: []
                }
              ]
            } as T
          };
        }

        if (callCount === 5) {
          return {
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              batchId: "batch-0001-repair-02",
              items: [
                {
                  inputId: "writing:test-2:paragraph:1",
                  nodeCandidates: []
                }
              ]
            } as T
          };
        }

        return {
          args: [],
          exitCode: 0,
          stdout: "",
          stderr: "",
          finalMessage: "",
          jsonEvents: [],
          parsed: {
            batchId: "batch-0002",
            items: [
              {
                inputId: "writing:test-3:paragraph:1",
                nodeCandidates: []
              }
            ]
          } as T
        };
      }
    };

    const summary = compileThoughtNodes(paths, client, {
      batchSize: 2
    });

    assert.equal(summary.status, "completed");
    assert.equal(callCount, 6);
    assert.equal(summary.completedBatchCount, 2);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("compileThoughtNodes records auth pauses after the last successful batch", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-compiler-auth-"));

  try {
    const paths = writeCompilerFixture(tempRoot);
    let callCount = 0;

    const client = {
      execSemanticBatch: <T,>() => {
        callCount += 1;

        if (callCount === 1) {
          return {
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              batchId: "batch-0001",
              items: [
                {
                  inputId: "writing:test-1:paragraph:1",
                  nodeCandidates: []
                },
                {
                  inputId: "writing:test-2:paragraph:1",
                  nodeCandidates: []
                }
              ]
            } as T
          };
        }

        throw new CodexCliError({
          kind: "auth",
          message: "Codex execution failed. stderr: please run codex login",
          exitCode: 1,
          stdout: "",
          stderr: "please run codex login"
        });
      }
    };

    const summary = compileThoughtNodes(paths, client, {
      batchSize: 2
    });

    assert.equal(summary.status, "paused_auth");
    assert.equal(summary.completedBatchCount, 1);
    assert.equal(summary.lastSuccessfulBatchId, "batch-0001");
    assert.equal(summary.failureKind, "auth");

    const checkpoint = JSON.parse(readFileSync(summary.checkpointPath, "utf8")) as {
      status: string;
      completedBatchIds: string[];
    };
    assert.equal(checkpoint.status, "paused_auth");
    assert.deepEqual(checkpoint.completedBatchIds, ["batch-0001"]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
