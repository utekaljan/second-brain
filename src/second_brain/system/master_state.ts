import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import { buildThoughtCompilerContract } from "../compiler/semantic_cache.js";
import {
  loadThoughtCompilerCheckpoint,
  loadThoughtConsolidationCheckpoint
} from "../compiler/state.js";
import type {
  ConsolidatedThoughtGraph,
  ThoughtFrameAlignmentArtifact,
  ThoughtGraph
} from "../compiler/types.js";
import type { ProjectPaths } from "./paths.js";
import {
  computeConsolidatedGraphSemanticHash,
  computeFrameAlignmentSemanticHash,
  computeThoughtGraphSemanticHash
} from "../structure/artifact_identity.js";
import { hashStableSet } from "../utils/stable_hash.js";

export type MasterPhase =
  | "normalized"
  | "preflight"
  | "compiled"
  | "consolidated"
  | "aligned"
  | "macro_mapped"
  | "rendered"
  | "audited";

export type MasterRunState = {
  version: 1;
  generationId: string;
  corpusHash: string;
  executionContractHash: string;
  model: string | null;
  reasoningEffort: string | null;
  useLlmReview: boolean;
  phase: MasterPhase;
  status: "in_progress" | "completed";
  thoughtGraphSemanticHash: string | null;
  consolidatedGraphSemanticHash: string | null;
  frameAlignmentSemanticHash: string | null;
  createdAt: string;
  updatedAt: string;
};

type MasterExecutionOptions = {
  model?: string;
  reasoningEffort?: string | null;
  useLlmReview: boolean;
  forceNewRun?: boolean;
};

const PHASES: MasterPhase[] = [
  "normalized",
  "preflight",
  "compiled",
  "consolidated",
  "aligned",
  "macro_mapped",
  "rendered",
  "audited"
];

function statePath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "master", "run.json");
}

function executionContractHash(options: MasterExecutionOptions): string {
  const compilerContract = buildThoughtCompilerContract({
    model: options.model ?? SECOND_BRAIN_DEFAULTS.codex.defaultModel ?? null,
    reasoningEffort:
      options.reasoningEffort ?? SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort ?? null
  });
  return hashStableSet({
    compilerContract,
    useLlmReview: options.useLlmReview,
    consolidationFixedPointPasses:
      SECOND_BRAIN_DEFAULTS.thoughtConsolidation.maxReviewFixedPointPasses,
    macroMapContractVersion: SECOND_BRAIN_DEFAULTS.thoughtMacroMap.contractVersion
  });
}

function readJson<T>(target: string): T {
  return JSON.parse(readFileSync(target, "utf8")) as T;
}

function loadState(paths: ProjectPaths): MasterRunState | null {
  const target = statePath(paths);
  return existsSync(target) ? readJson<MasterRunState>(target) : null;
}

function writeState(paths: ProjectPaths, state: MasterRunState): void {
  const target = statePath(paths);
  mkdirSync(path.dirname(target), { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function masterPhaseReached(state: MasterRunState, phase: MasterPhase): boolean {
  return PHASES.indexOf(state.phase) >= PHASES.indexOf(phase);
}

function inspectCompiledGraph(options: {
  paths: ProjectPaths;
  corpusHash: string;
  model: string | null;
  reasoningEffort: string | null;
}): { graph: ThoughtGraph; semanticHash: string } | null {
  const checkpoint = loadThoughtCompilerCheckpoint(options.paths);
  const graphPath = path.join(
    options.paths.compiledDir,
    SECOND_BRAIN_DEFAULTS.thoughtCompiler.compiledGraphFilename
  );
  const contract = buildThoughtCompilerContract({
    model: options.model,
    reasoningEffort: options.reasoningEffort
  });
  if (!checkpoint || !existsSync(graphPath)) return null;
  const graph = readJson<ThoughtGraph>(graphPath);
  if (
    checkpoint.status !== "completed" ||
    checkpoint.corpusHash !== options.corpusHash ||
    checkpoint.model !== options.model ||
    checkpoint.reasoningEffort !== options.reasoningEffort ||
    checkpoint.compilerContractVersion !== contract.version ||
    graph.corpusHash !== options.corpusHash ||
    graph.runId !== checkpoint.runId ||
    graph.completedBatchCount !== graph.totalBatchCount
  ) {
    return null;
  }
  return { graph, semanticHash: computeThoughtGraphSemanticHash(graph) };
}

function inspectConsolidatedGraph(options: {
  paths: ProjectPaths;
  sourceGraph: ThoughtGraph;
  requireFixedPoint?: boolean;
  model?: string | null;
  reasoningEffort?: string | null;
}): { graph: ConsolidatedThoughtGraph; semanticHash: string } | null {
  const target = path.join(
    options.paths.compiledDir,
    SECOND_BRAIN_DEFAULTS.thoughtConsolidation.compiledGraphFilename
  );
  if (!existsSync(target)) return null;
  const graph = readJson<ConsolidatedThoughtGraph>(target);
  const checkpoint = options.requireFixedPoint
    ? loadThoughtConsolidationCheckpoint(options.paths)
    : null;
  if (
    graph.sourceRunId !== options.sourceGraph.runId ||
    graph.sourceNodeCount !== options.sourceGraph.nodeCount ||
    graph.sourceEdgeCount !== options.sourceGraph.edgeCount ||
    (options.requireFixedPoint && (
      !checkpoint ||
      checkpoint.status !== "completed" ||
      checkpoint.fixedPointReached !== true ||
      checkpoint.sourceRunId !== options.sourceGraph.runId ||
      checkpoint.model !== options.model ||
      checkpoint.reasoningEffort !== options.reasoningEffort
    ))
  ) {
    return null;
  }
  return { graph, semanticHash: computeConsolidatedGraphSemanticHash(graph) };
}

function inspectAlignment(options: {
  paths: ProjectPaths;
  consolidatedGraph: ConsolidatedThoughtGraph;
  consolidatedSemanticHash: string;
  allowLegacyBootstrap: boolean;
}): { artifact: ThoughtFrameAlignmentArtifact; semanticHash: string } | null {
  const target = path.join(
    options.paths.compiledDir,
    SECOND_BRAIN_DEFAULTS.thoughtFrameAlignment.compiledArtifactFilename
  );
  if (!existsSync(target)) return null;
  const artifact = readJson<ThoughtFrameAlignmentArtifact>(target);
  const sourceHashMatches = artifact.sourceConsolidatedGraphSemanticHash
    ? artifact.sourceConsolidatedGraphSemanticHash === options.consolidatedSemanticHash
    : options.allowLegacyBootstrap;
  if (
    !sourceHashMatches ||
    artifact.sourceConsolidatedNodeCount !== options.consolidatedGraph.nodeCount
  ) {
    return null;
  }
  return { artifact, semanticHash: computeFrameAlignmentSemanticHash(artifact)! };
}

/**
 * Open the resumable master generation. A missing state can adopt the current
 * coherent artifact chain once, which makes upgrades safe for an already
 * completed corpus. A changed corpus always starts a new generation.
 */
export function openMasterRun(
  paths: ProjectPaths,
  corpusHash: string,
  options: MasterExecutionOptions
): MasterRunState {
  const model = options.model ?? SECOND_BRAIN_DEFAULTS.codex.defaultModel ?? null;
  const reasoningEffort =
    options.reasoningEffort ?? SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort ?? null;
  const contractHash = executionContractHash(options);
  const existing = loadState(paths);
  if (
    !options.forceNewRun &&
    existing?.version === 1 &&
    existing.corpusHash === corpusHash &&
    existing.executionContractHash === contractHash
  ) {
    return existing;
  }

  const now = new Date().toISOString();
  const state: MasterRunState = {
    version: 1,
    generationId: `master-${now.replace(/[:.]/g, "-")}`,
    corpusHash,
    executionContractHash: contractHash,
    model,
    reasoningEffort,
    useLlmReview: options.useLlmReview,
    phase: "normalized",
    status: "in_progress",
    thoughtGraphSemanticHash: null,
    consolidatedGraphSemanticHash: null,
    frameAlignmentSemanticHash: null,
    createdAt: now,
    updatedAt: now
  };

  // Only the first state introduced into an old output may trust an alignment
  // artifact without its new source semantic hash. Later generations require
  // that explicit identity and therefore cannot accidentally inherit stale data.
  const allowLegacyBootstrap = existing === null && !options.forceNewRun;
  const mayBootstrapDownstream = existing === null && !options.forceNewRun;
  const compiled = options.forceNewRun ? null : inspectCompiledGraph({
    paths,
    corpusHash,
    model,
    reasoningEffort
  });
  if (compiled) {
    state.phase = "compiled";
    state.thoughtGraphSemanticHash = compiled.semanticHash;
    const consolidated = mayBootstrapDownstream
      ? inspectConsolidatedGraph({
          paths,
          sourceGraph: compiled.graph,
          requireFixedPoint: options.useLlmReview,
          model,
          reasoningEffort
        })
      : null;
    if (consolidated) {
      state.phase = "consolidated";
      state.consolidatedGraphSemanticHash = consolidated.semanticHash;
      const alignment = inspectAlignment({
        paths,
        consolidatedGraph: consolidated.graph,
        consolidatedSemanticHash: consolidated.semanticHash,
        allowLegacyBootstrap
      });
      if (alignment) {
        state.phase = "aligned";
        state.frameAlignmentSemanticHash = alignment.semanticHash;
      }
    }
  }
  writeState(paths, state);
  return state;
}

export function refreshMasterReuseState(paths: ProjectPaths, state: MasterRunState): MasterRunState {
  // Validation may move a checkpoint backwards when an artifact was changed or
  // removed. A completed compile is safe to adopt after a crash because its
  // checkpoint contains the same corpus and compiler contract. Downstream
  // phases are only validated once this generation already reached them.
  const hadCompiledPhase = masterPhaseReached(state, "compiled");
  const compiled = inspectCompiledGraph({
    paths,
    corpusHash: state.corpusHash,
    model: state.model,
    reasoningEffort: state.reasoningEffort
  });
  if (!compiled || (
    state.thoughtGraphSemanticHash &&
    state.thoughtGraphSemanticHash !== compiled.semanticHash
  )) {
    state.phase = "preflight";
    state.thoughtGraphSemanticHash = null;
    state.consolidatedGraphSemanticHash = null;
    state.frameAlignmentSemanticHash = null;
    writeState(paths, state);
    return state;
  }
  state.thoughtGraphSemanticHash = compiled.semanticHash;
  if (!hadCompiledPhase) {
    state.phase = "compiled";
    writeState(paths, state);
    return state;
  }
  if (!masterPhaseReached(state, "consolidated")) {
    writeState(paths, state);
    return state;
  }

  const consolidated = inspectConsolidatedGraph({
    paths,
    sourceGraph: compiled.graph,
    requireFixedPoint: state.useLlmReview,
    model: state.model,
    reasoningEffort: state.reasoningEffort
  });
  if (!consolidated || (
    state.consolidatedGraphSemanticHash &&
    state.consolidatedGraphSemanticHash !== consolidated.semanticHash
  )) {
    if (masterPhaseReached(state, "consolidated")) state.phase = "compiled";
    state.consolidatedGraphSemanticHash = null;
    state.frameAlignmentSemanticHash = null;
    writeState(paths, state);
    return state;
  }
  state.consolidatedGraphSemanticHash = consolidated.semanticHash;
  if (!masterPhaseReached(state, "aligned")) {
    writeState(paths, state);
    return state;
  }

  const alignment = inspectAlignment({
    paths,
    consolidatedGraph: consolidated.graph,
    consolidatedSemanticHash: consolidated.semanticHash,
    // A state created by the one-time bootstrap already pinned the exact
    // semantic identity of a legacy alignment artifact. New generations have
    // no such pin and therefore still require the explicit source hash.
    allowLegacyBootstrap: Boolean(state.frameAlignmentSemanticHash)
  });
  if (!alignment || (
    state.frameAlignmentSemanticHash &&
    state.frameAlignmentSemanticHash !== alignment.semanticHash
  )) {
    if (masterPhaseReached(state, "aligned")) state.phase = "consolidated";
    state.frameAlignmentSemanticHash = null;
    writeState(paths, state);
    return state;
  }
  state.frameAlignmentSemanticHash = alignment.semanticHash;
  writeState(paths, state);
  return state;
}

export function markMasterPhase(
  paths: ProjectPaths,
  state: MasterRunState,
  phase: MasterPhase,
  hashes: Partial<Pick<MasterRunState,
    "thoughtGraphSemanticHash" | "consolidatedGraphSemanticHash" | "frameAlignmentSemanticHash">> = {}
): void {
  if (!masterPhaseReached(state, phase)) state.phase = phase;
  Object.assign(state, hashes);
  state.status = state.phase === "audited" ? "completed" : "in_progress";
  writeState(paths, state);
}
