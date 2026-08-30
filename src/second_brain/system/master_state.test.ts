import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import type {
  ConsolidatedThoughtGraph,
  ThoughtFrameAlignmentArtifact,
  ThoughtGraph
} from "../compiler/types.js";
import { getProjectPaths } from "./paths.js";
import { openMasterRun, refreshMasterReuseState } from "./master_state.js";

function writeJson(target: string, value: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeCompletedChain(options: {
  root: string;
  corpusHash: string;
  runId: string;
  alignmentSourceHash?: string;
}): ReturnType<typeof getProjectPaths> {
  const paths = getProjectPaths(options.root);
  const graph: ThoughtGraph = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    runId: options.runId,
    corpusHash: options.corpusHash,
    sourceCorpusPath: path.join(paths.normalizedUnifiedDir, "corpus.json"),
    batchSize: 32,
    totalBatchCount: 1,
    completedBatchCount: 1,
    nodeCount: 0,
    edgeCount: 0,
    claimCount: 0,
    nodeStateCount: 0,
    worldlineCount: 0,
    identityBlockCount: 0,
    nodes: [],
    edges: []
  };
  const consolidated: ConsolidatedThoughtGraph = {
    generatedAt: "2026-01-01T00:01:00.000Z",
    sourceRunId: options.runId,
    sourceGraphPath: path.join(paths.compiledDir, "thought_graph.json"),
    sourceNodeCount: 0,
    sourceEdgeCount: 0,
    nodeCount: 0,
    edgeCount: 0,
    nodes: [],
    edges: []
  };
  const alignment: ThoughtFrameAlignmentArtifact = {
    generatedAt: "2026-01-01T00:02:00.000Z",
    sourceDocumentFramesPath: path.join(paths.compiledDir, "thought_document_frames.json"),
    sourceConsolidatedGraphPath: path.join(paths.compiledDir, "consolidated_thought_graph.json"),
    sourceConsolidatedGraphSemanticHash: options.alignmentSourceHash,
    sourceFrameCount: 0,
    sourceSubframeCount: 0,
    sourceConsolidatedNodeCount: 0,
    familyCount: 0,
    patternCount: 0,
    families: [],
    patterns: []
  };
  writeJson(path.join(paths.compiledDir, "thought_graph.json"), graph);
  writeJson(path.join(paths.compiledDir, "consolidated_thought_graph.json"), consolidated);
  writeJson(path.join(paths.compiledDir, "thought_frame_alignment.json"), alignment);
  writeJson(
    path.join(paths.stateCheckpointsDir, SECOND_BRAIN_DEFAULTS.thoughtCompiler.checkpointFilename),
    {
      runId: options.runId,
      sourceCorpusPath: graph.sourceCorpusPath,
      corpusHash: options.corpusHash,
      batchSize: 32,
      softInputTokenBudget: 1,
      totalBatchCount: 1,
      completedBatchIds: ["batch-0001"],
      lastSuccessfulBatchId: "batch-0001",
      lastSuccessfulInputId: null,
      status: "completed",
      failureKind: null,
      failureMessage: null,
      compilerContractVersion: 7,
      model: "gpt-5.5",
      reasoningEffort: "high",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.000Z"
    }
  );
  writeJson(
    path.join(
      paths.stateCheckpointsDir,
      SECOND_BRAIN_DEFAULTS.thoughtConsolidation.checkpointFilename
    ),
    {
      runId: `consolidation-${options.runId}`,
      sourceRunId: options.runId,
      graphHash: "test-graph-hash",
      reviewCandidateCount: 0,
      reviewBatchSize: SECOND_BRAIN_DEFAULTS.thoughtConsolidation.reviewBatchSize,
      synthesisBatchSize: SECOND_BRAIN_DEFAULTS.thoughtConsolidation.synthesisBatchSize,
      completedReviewBatchIds: [],
      completedSynthesisBatchIds: [],
      status: "completed",
      failureKind: null,
      failureMessage: null,
      model: "gpt-5.5",
      reasoningEffort: "high",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.000Z",
      reviewPassCount: 1,
      fixedPointReached: true
    }
  );
  return paths;
}

test("master adopts one coherent legacy output but never carries downstream phases into a new corpus", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "second-brain-master-state-"));
  writeFileSync(path.join(root, "package.json"), "{}\n", "utf8");
  mkdirSync(path.join(root, "input"), { recursive: true });
  const paths = writeCompletedChain({ root, corpusHash: "corpus-a", runId: "run-a" });

  let state = openMasterRun(paths, "corpus-a", {
    model: "gpt-5.5",
    reasoningEffort: "high",
    useLlmReview: true
  });
  assert.equal(state.phase, "aligned");
  assert.ok(state.frameAlignmentSemanticHash);

  state = refreshMasterReuseState(paths, state);
  assert.equal(state.phase, "aligned");

  writeCompletedChain({ root, corpusHash: "corpus-b", runId: "run-b" });
  const changed = openMasterRun(paths, "corpus-b", {
    model: "gpt-5.5",
    reasoningEffort: "high",
    useLlmReview: true
  });
  assert.equal(changed.phase, "compiled");
  assert.equal(changed.consolidatedGraphSemanticHash, null);
  assert.equal(changed.frameAlignmentSemanticHash, null);
  assert.notEqual(changed.generationId, state.generationId);
});
