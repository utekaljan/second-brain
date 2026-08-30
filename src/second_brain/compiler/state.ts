import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import type { ProjectPaths } from "../system/paths.js";
import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import type { UnifiedCorpus } from "../types/domain.js";
import type {
  ThoughtBatchOutput,
  ThoughtCompilationArtifacts,
  ThoughtConsolidationRunState,
  ThoughtDocumentFrameArtifact,
  ThoughtCompilerRunState,
  ThoughtGraph
} from "./types.js";

const THOUGHT_COMPILER_DEFAULTS = SECOND_BRAIN_DEFAULTS.thoughtCompiler;
const THOUGHT_CONSOLIDATION_DEFAULTS = SECOND_BRAIN_DEFAULTS.thoughtConsolidation;

/**
 * File layout for one persisted compiler run.
 *
 * We keep the paths explicit because the compiler is intentionally inspectable:
 * a future session should be able to find checkpoint state, raw batch outputs,
 * and final compiled artifacts without reverse-engineering hidden conventions.
 */
export type ThoughtCompilerRunPaths = {
  checkpointPath: string;
  documentFramesPath: string;
  claimsPath: string;
  nodesPath: string;
  nodeStatesPath: string;
  identityBlocksPath: string;
  worldlinesPath: string;
  edgesPath: string;
  graphPath: string;
  runDir: string;
  runStatePath: string;
  batchDir: string;
  schemaPath: string;
};

/**
 * File layout for one persisted consolidation run.
 */
export type ThoughtConsolidationRunPaths = {
  checkpointPath: string;
  runDir: string;
  runStatePath: string;
  stateDir: string;
  reviewCandidatesPath: string;
  reviewDecisionsPath: string;
  synthesisPath: string;
};

/**
 * Resolve all filesystem paths used by the thought-node compiler.
 */
export function getThoughtCompilerRunPaths(
  paths: ProjectPaths,
  runId: string
): ThoughtCompilerRunPaths {
  const runDir = path.join(paths.stateRunsDir, runId);

  return {
    checkpointPath: path.join(
      paths.stateCheckpointsDir,
      THOUGHT_COMPILER_DEFAULTS.checkpointFilename
    ),
    documentFramesPath: path.join(
      paths.compiledDir,
      THOUGHT_COMPILER_DEFAULTS.compiledDocumentFramesFilename
    ),
    claimsPath: path.join(paths.compiledDir, THOUGHT_COMPILER_DEFAULTS.compiledClaimsFilename),
    nodesPath: path.join(paths.compiledDir, THOUGHT_COMPILER_DEFAULTS.compiledNodesFilename),
    nodeStatesPath: path.join(
      paths.compiledDir,
      THOUGHT_COMPILER_DEFAULTS.compiledNodeStatesFilename
    ),
    identityBlocksPath: path.join(
      paths.compiledDir,
      THOUGHT_COMPILER_DEFAULTS.compiledIdentityBlocksFilename
    ),
    worldlinesPath: path.join(
      paths.compiledDir,
      THOUGHT_COMPILER_DEFAULTS.compiledWorldlinesFilename
    ),
    edgesPath: path.join(paths.compiledDir, THOUGHT_COMPILER_DEFAULTS.compiledEdgesFilename),
    graphPath: path.join(paths.compiledDir, THOUGHT_COMPILER_DEFAULTS.compiledGraphFilename),
    runDir,
    runStatePath: path.join(runDir, THOUGHT_COMPILER_DEFAULTS.runStateFilename),
    batchDir: path.join(runDir, "batches"),
    schemaPath: path.join(runDir, THOUGHT_COMPILER_DEFAULTS.batchSchemaFilename)
  };
}

/**
 * Resolve all filesystem paths used by the resumable consolidation stage.
 */
export function getThoughtConsolidationRunPaths(
  paths: ProjectPaths,
  runId: string
): ThoughtConsolidationRunPaths {
  const runDir = path.join(paths.stateRunsDir, runId);
  const stateDir = path.join(runDir, "consolidation");

  return {
    checkpointPath: path.join(
      paths.stateCheckpointsDir,
      THOUGHT_CONSOLIDATION_DEFAULTS.checkpointFilename
    ),
    runDir,
    runStatePath: path.join(runDir, THOUGHT_CONSOLIDATION_DEFAULTS.runStateFilename),
    stateDir,
    reviewCandidatesPath: path.join(stateDir, "consolidation_review_candidates.partial.json"),
    reviewDecisionsPath: path.join(stateDir, "consolidation_review_decisions.partial.json"),
    synthesisPath: path.join(stateDir, "consolidation_synthesis.partial.json")
  };
}

/**
 * Ensure the directory scaffold for one compiler run exists.
 */
export function ensureThoughtCompilerRunLayout(runPaths: ThoughtCompilerRunPaths): void {
  // Creating the compiled artifact directory here keeps compile and resume
  // symmetrical: later code can assume the filesystem scaffold exists.
  mkdirSync(path.dirname(runPaths.checkpointPath), { recursive: true });
  mkdirSync(path.dirname(runPaths.nodesPath), { recursive: true });
  mkdirSync(runPaths.runDir, { recursive: true });
  mkdirSync(runPaths.batchDir, { recursive: true });
}

/**
 * Ensure the directory scaffold for one consolidation run exists.
 */
export function ensureThoughtConsolidationRunLayout(
  runPaths: ThoughtConsolidationRunPaths
): void {
  mkdirSync(path.dirname(runPaths.checkpointPath), { recursive: true });
  mkdirSync(runPaths.runDir, { recursive: true });
  mkdirSync(runPaths.stateDir, { recursive: true });
}

/**
 * Compute a stable corpus hash from the serialized unified corpus file.
 */
export function computeFileSha256(target: string): string {
  const contents = readFileSync(target, "utf8");
  return createHash("sha256").update(contents).digest("hex");
}

function serializeStableUnifiedCorpus(corpus: UnifiedCorpus): string {
  // Resume should follow the semantic content of the normalized corpus, not the
  // wall-clock time when normalization happened. `generatedAt` is therefore
  // intentionally excluded, while the actual compiler-relevant payload stays in.
  return JSON.stringify({
    options: corpus.options,
    stats: corpus.stats,
    documents: corpus.documents,
    segments: corpus.segments,
    timeline: corpus.timeline,
    primaryTimeline: corpus.primaryTimeline
  });
}

/**
 * Compute the resume hash for the unified corpus while ignoring volatile
 * normalization metadata such as `generatedAt`.
 */
export function computeStableUnifiedCorpusHash(target: string): string {
  const corpus = JSON.parse(readFileSync(target, "utf8")) as UnifiedCorpus;
  return createHash("sha256").update(serializeStableUnifiedCorpus(corpus)).digest("hex");
}

/**
 * Load the latest compiler checkpoint if it exists.
 */
export function loadThoughtCompilerCheckpoint(
  paths: ProjectPaths
): ThoughtCompilerRunState | null {
  const checkpointPath = path.join(
    paths.stateCheckpointsDir,
    THOUGHT_COMPILER_DEFAULTS.checkpointFilename
  );

  if (!existsSync(checkpointPath)) {
    return null;
  }

  return JSON.parse(readFileSync(checkpointPath, "utf8")) as ThoughtCompilerRunState;
}

/**
 * Load the latest consolidation checkpoint if it exists.
 */
export function loadThoughtConsolidationCheckpoint(
  paths: ProjectPaths
): ThoughtConsolidationRunState | null {
  const checkpointPath = path.join(
    paths.stateCheckpointsDir,
    THOUGHT_CONSOLIDATION_DEFAULTS.checkpointFilename
  );

  if (!existsSync(checkpointPath)) {
    return null;
  }

  return JSON.parse(readFileSync(checkpointPath, "utf8")) as ThoughtConsolidationRunState;
}

/**
 * Persist the run state both in the run directory and as the latest checkpoint.
 *
 * The duplicated write is deliberate:
 * - the run-local file preserves history for one specific invocation
 * - the checkpoint file is the fast "resume from here" pointer
 */
export function writeThoughtCompilerRunState(
  runPaths: ThoughtCompilerRunPaths,
  state: ThoughtCompilerRunState
): void {
  const contents = `${JSON.stringify(state, null, 2)}\n`;
  writeFileSync(runPaths.runStatePath, contents, "utf8");
  writeFileSync(runPaths.checkpointPath, contents, "utf8");
}

/**
 * Persist the consolidation run state both in the run directory and as the latest checkpoint.
 */
export function writeThoughtConsolidationRunState(
  runPaths: ThoughtConsolidationRunPaths,
  state: ThoughtConsolidationRunState
): void {
  const contents = `${JSON.stringify(state, null, 2)}\n`;
  writeFileSync(runPaths.runStatePath, contents, "utf8");
  writeFileSync(runPaths.checkpointPath, contents, "utf8");
}

/**
 * Persist the structured result of one successful semantic batch.
 *
 * Batch outputs are append-only. They are the durable evidence that lets us
 * reconstruct the current graph after interruption without replaying Codex.
 */
export function writeThoughtBatchOutput(
  runPaths: ThoughtCompilerRunPaths,
  batchOutput: ThoughtBatchOutput
): string {
  const target = path.join(
    runPaths.batchDir,
    `${THOUGHT_COMPILER_DEFAULTS.batchOutputFilenamePrefix}${batchOutput.batchId}${THOUGHT_COMPILER_DEFAULTS.batchOutputFilenameSuffix}`
  );
  writeFileSync(target, `${JSON.stringify(batchOutput, null, 2)}\n`, "utf8");
  return target;
}

/**
 * Load every completed batch artifact already written for one run.
 *
 * Sorting by filename is sufficient because batch ids are zero-padded.
 */
export function loadThoughtBatchOutputs(runPaths: ThoughtCompilerRunPaths): ThoughtBatchOutput[] {
  if (!existsSync(runPaths.batchDir)) {
    return [];
  }

  return readdirSync(runPaths.batchDir)
    .filter((name) => name.endsWith(THOUGHT_COMPILER_DEFAULTS.batchOutputFilenameSuffix))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const target = path.join(runPaths.batchDir, name);
      return JSON.parse(readFileSync(target, "utf8")) as ThoughtBatchOutput;
    });
}

/**
 * Persist the merged thought graph artifacts after a compile or resume step.
 *
 * This older narrower writer is kept because some tests and call sites only
 * need the top-level graph view.
 */
export function writeThoughtGraphArtifacts(
  runPaths: ThoughtCompilerRunPaths,
  graph: ThoughtGraph
): void {
  writeFileSync(runPaths.nodesPath, `${JSON.stringify(graph.nodes, null, 2)}\n`, "utf8");
  writeFileSync(runPaths.edgesPath, `${JSON.stringify(graph.edges, null, 2)}\n`, "utf8");
  writeFileSync(runPaths.graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
}

/**
 * Persist the full richer compiler artifact bundle.
 *
 * The split files are intentional. They let us inspect:
 * - identity resolution
 * - claim layer
 * - temporal states/worldlines
 * - final graph
 * independently during debugging and future consolidation work.
 */
export function writeThoughtCompilationArtifacts(
  runPaths: ThoughtCompilerRunPaths,
  artifacts: ThoughtCompilationArtifacts
): void {
  if (artifacts.documentFrames) {
    writeFileSync(
      runPaths.documentFramesPath,
      `${JSON.stringify(artifacts.documentFrames, null, 2)}\n`,
      "utf8"
    );
  }
  writeFileSync(runPaths.claimsPath, `${JSON.stringify(artifacts.claims, null, 2)}\n`, "utf8");
  writeFileSync(runPaths.nodesPath, `${JSON.stringify(artifacts.graph.nodes, null, 2)}\n`, "utf8");
  writeFileSync(
    runPaths.nodeStatesPath,
    `${JSON.stringify(artifacts.nodeStates, null, 2)}\n`,
    "utf8"
  );
  writeFileSync(
    runPaths.identityBlocksPath,
    `${JSON.stringify(artifacts.identityBlocks, null, 2)}\n`,
    "utf8"
  );
  writeFileSync(
    runPaths.worldlinesPath,
    `${JSON.stringify(artifacts.worldlines, null, 2)}\n`,
    "utf8"
  );
  writeFileSync(runPaths.edgesPath, `${JSON.stringify(artifacts.graph.edges, null, 2)}\n`, "utf8");
  writeFileSync(runPaths.graphPath, `${JSON.stringify(artifacts.graph, null, 2)}\n`, "utf8");
}

/**
 * Reuse the current frame artifact only when it matches the active corpus.
 *
 * The compiled frame layer is an expensive semantic prepass, but it must never
 * bleed across corpus changes.
 */
export function loadThoughtDocumentFrameArtifact(
  paths: ProjectPaths,
  corpusHash: string
): ThoughtDocumentFrameArtifact | null {
  const artifact = loadLatestThoughtDocumentFrameArtifact(paths);
  return artifact?.corpusHash === corpusHash ? artifact : null;
}

/**
 * Load the latest compiled frame artifact regardless of corpus hash.
 *
 * Mixed-contract incremental frame reuse needs the previous active per-document
 * bindings even when the corpus has grown since the last run.
 */
export function loadLatestThoughtDocumentFrameArtifact(
  paths: ProjectPaths
): ThoughtDocumentFrameArtifact | null {
  const target = path.join(
    paths.compiledDir,
    THOUGHT_COMPILER_DEFAULTS.compiledDocumentFramesFilename
  );
  if (!existsSync(target)) {
    return null;
  }

  return JSON.parse(readFileSync(target, "utf8")) as ThoughtDocumentFrameArtifact;
}
