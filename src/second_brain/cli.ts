import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import {
  normalizeConversations,
  normalizeConversationsWithReport,
  writeNormalizedConversations
} from "./ingest/conversations/normalize.js";
import { normalizeChats, writeNormalizedChats } from "./ingest/chats/normalize.js";
import { buildManifest, writeManifest } from "./system/discovery.js";
import { runDocumentFrameAudit } from "./debug/document_frame_audit.js";
import { runConversationTurnAudit } from "./debug/conversation_turn_audit.js";
import { runSemanticDensityAudit } from "./debug/semantic_density_audit.js";
import { runRealRunDiagnostics } from "./debug/real_run_diagnostics.js";
import { writeWorkConversationAudit } from "./debug/work_conversation_audit.js";
import { nukeGeneratedArtifacts } from "./system/nuke.js";
import { getProjectPaths } from "./system/paths.js";
import { CodexCliClient, type CodexReasoningEffort } from "./codex/client.js";
import { SECOND_BRAIN_DEFAULTS } from "./config.js";
import { compileThoughtNodes } from "./compiler/compile.js";
import { consolidateThoughtGraph } from "./compiler/consolidate.js";
import type {
  ConsolidatedThoughtGraph,
  ThoughtFrameAlignmentArtifact,
  ThoughtGraph,
  ThoughtSemanticReusePolicy
} from "./compiler/types.js";
import { computeStableUnifiedCorpusHash } from "./compiler/state.js";
import { ThrottledProgressReporter } from "./utils/progress.js";
import {
  buildUnifiedCorpus,
  buildUnifiedManifest,
  writeUnifiedCorpus
} from "./ingest/unified/normalize.js";
import { normalizeWritings, writeNormalizedWritings } from "./ingest/writings/normalize.js";
import { renderValidationWiki } from "./wiki/render.js";
import { renderValidationSite } from "./wiki/site.js";
import { alignWritingFrames } from "./structure/frame_alignment.js";
import { buildThoughtMacroMap } from "./structure/macro_map.js";
import {
  buildScaledThoughtMacroMap,
  prepareScaledMacroMapIncrementalReuse
} from "./structure/macro_map_scaled.js";
import { renderGptMarkdownExport } from "./exports/gpt.js";
import { renderSourceArchive } from "./exports/source_archive.js";
import {
  markMasterPhase,
  masterPhaseReached,
  openMasterRun,
  refreshMasterReuseState
} from "./system/master_state.js";
import {
  computeConsolidatedGraphSemanticHash,
  computeFrameAlignmentSemanticHash,
  computeThoughtGraphSemanticHash
} from "./structure/artifact_identity.js";

// Chat identity stays configurable, but the usual owner name now comes from the
// central repo config so day-to-day runs do not need repetitive CLI flags.
/**
 * Shared CLI options for normalization commands.
 */
type NormalizeCliOptions = {
  ownerNames: string[];
  includeOtherContext: boolean;
  includeAssistantContext: boolean;
  includeToolContext: boolean;
  contextWindow: number;
  enableConversationPrefilter: boolean;
  enableWorkConversationFilter: boolean;
};

/**
 * CLI options for the semantic thought-node compiler.
 */
type CompileCliOptions = {
  batchSize: number;
  maxBatches: number | null;
  model: string | undefined;
  reasoningEffort: CodexReasoningEffort;
  semanticReusePolicy: ThoughtSemanticReusePolicy;
  forceNewRun: boolean;
  ignoreCheckpoint: boolean;
  forceSingletonRepairBatchId: string | null;
};

/**
 * CLI options for the consolidation stage above the granular graph.
 */
type ConsolidateCliOptions = {
  useLlmReview: boolean;
  model: string | undefined;
  reasoningEffort: CodexReasoningEffort;
  forceNewRun: boolean;
};

type MacroMapCliOptions = {
  model: string | undefined;
  reasoningEffort: CodexReasoningEffort;
  iterationLabel: string;
  proposalPath: string | undefined;
  trajectoryPath: string | undefined;
  sourceOutputDir: string | undefined;
  targetOutputDir: string | undefined;
  membershipBatchSize: number | undefined;
  maxMembershipBatches: number | null | undefined;
  forceNewRun: boolean;
  replayCompleted: boolean;
  refreshTrajectories: boolean;
  atlasDisplayOverridesPath: string | undefined;
  refinedTrajectoryPath: string | undefined;
};

/**
 * End-to-end master run options combine normalization, semantic compilation,
 * consolidation, and the final human/GPT-facing artifact renders behind one
 * explicit batch command.
 */
type MasterCliOptions = NormalizeCliOptions & CompileCliOptions & ConsolidateCliOptions;

type RenderCliOptions = {
  sourceOutputDir: string | undefined;
  targetOutputDir: string | undefined;
  macroMapPath: string | undefined;
};

type SiteCliOptions = RenderCliOptions & {
  refreshWiki: boolean;
};

type SemanticDensityAuditCliOptions = {
  label: string;
  corpusPath: string | undefined;
  claimsPath: string | undefined;
};

function parseCliOptions(argv: string[]): NormalizeCliOptions {
  const ownerNames: string[] = [...SECOND_BRAIN_DEFAULTS.ownerNames];
  let ownerNamesWereExplicitlySet = false;
  let includeOtherContext = true;
  let includeAssistantContext = true;
  let includeToolContext = false;
  let contextWindow = 1;
  let enableConversationPrefilter = true;
  let enableWorkConversationFilter = true;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--owner") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --owner");
      }

      // Explicit CLI owners override the repo default so ad-hoc runs can test
      // alternate identities without accidentally mixing them with the default one.
      if (!ownerNamesWereExplicitlySet) {
        ownerNames.length = 0;
        ownerNamesWereExplicitlySet = true;
      }

      if (!ownerNames.includes(value)) {
        ownerNames.push(value);
      }

      index += 1;
      continue;
    }

    if (arg === "--omit-other-context") {
      includeOtherContext = false;
      continue;
    }

    if (arg === "--omit-assistant-context") {
      includeAssistantContext = false;
      continue;
    }

    if (arg === "--include-tool-context") {
      includeToolContext = true;
      continue;
    }

    if (arg === "--context-window") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --context-window");
      }
      contextWindow = Number.parseInt(value, 10);
      index += 1;
      continue;
    }

    if (arg === "--disable-conversation-prefilter") {
      enableConversationPrefilter = false;
      continue;
    }

    if (arg === "--disable-work-conversation-filter") {
      enableWorkConversationFilter = false;
      continue;
    }
  }

  return {
    ownerNames,
    includeOtherContext,
    includeAssistantContext,
    includeToolContext,
    contextWindow,
    enableConversationPrefilter,
    enableWorkConversationFilter
  };
}

function parseCompileCliOptions(argv: string[]): CompileCliOptions {
  let batchSize: number = SECOND_BRAIN_DEFAULTS.thoughtCompiler.batchSize;
  let maxBatches: number | null = null;
  let model: string | undefined = SECOND_BRAIN_DEFAULTS.codex.defaultModel ?? undefined;
  let reasoningEffort: CodexReasoningEffort =
    SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort;
  let semanticReusePolicy: ThoughtSemanticReusePolicy =
    SECOND_BRAIN_DEFAULTS.thoughtCompiler.semanticReusePolicy;
  let forceNewRun = false;
  let ignoreCheckpoint = false;
  let forceSingletonRepairBatchId: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--batch-size") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --batch-size");
      }
      batchSize = Number.parseInt(value, 10);
      index += 1;
      continue;
    }

    if (arg === "--max-batches") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --max-batches");
      }
      maxBatches = Number.parseInt(value, 10);
      index += 1;
      continue;
    }

    if (arg === "--model") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --model");
      }
      model = value;
      index += 1;
      continue;
    }

    if (arg === "--reasoning-effort") {
      const value = argv[index + 1] as CodexReasoningEffort | undefined;
      if (!value) {
        throw new Error("Missing value for --reasoning-effort");
      }
      reasoningEffort = value;
      index += 1;
      continue;
    }

    if (arg === "--semantic-reuse-policy") {
      const value = argv[index + 1] as ThoughtSemanticReusePolicy | undefined;
      if (value !== "strict" && value !== "mixed") {
        throw new Error("Expected --semantic-reuse-policy to be 'strict' or 'mixed'");
      }
      semanticReusePolicy = value;
      index += 1;
      continue;
    }

    if (arg === "--force-new-run") {
      forceNewRun = true;
      continue;
    }

    if (arg === "--ignore-checkpoint") {
      ignoreCheckpoint = true;
      continue;
    }

    if (arg === "--force-singleton-repair-batch") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --force-singleton-repair-batch");
      }
      forceSingletonRepairBatchId = value;
      index += 1;
    }
  }

  return {
    batchSize,
    maxBatches,
    model,
    reasoningEffort,
    semanticReusePolicy,
    forceNewRun,
    ignoreCheckpoint,
    forceSingletonRepairBatchId
  };
}

function parseConsolidateCliOptions(argv: string[]): ConsolidateCliOptions {
  let useLlmReview = false;
  let model: string | undefined = SECOND_BRAIN_DEFAULTS.codex.defaultModel ?? undefined;
  let reasoningEffort: CodexReasoningEffort =
    SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort;
  let forceNewRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--llm-review") {
      useLlmReview = true;
      continue;
    }

    if (arg === "--force-new-run") {
      forceNewRun = true;
      continue;
    }

    if (arg === "--model") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --model");
      }
      model = value;
      index += 1;
      continue;
    }

    if (arg === "--reasoning-effort") {
      const value = argv[index + 1] as CodexReasoningEffort | undefined;
      if (!value) {
        throw new Error("Missing value for --reasoning-effort");
      }
      reasoningEffort = value;
      index += 1;
      continue;
    }
  }

  return {
    useLlmReview,
    model,
    reasoningEffort,
    forceNewRun
  };
}

function parseMacroMapCliOptions(argv: string[]): MacroMapCliOptions {
  let model: string | undefined = SECOND_BRAIN_DEFAULTS.codex.defaultModel ?? undefined;
  let reasoningEffort: CodexReasoningEffort = SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort;
  let iterationLabel = "manual";
  let proposalPath: string | undefined;
  let trajectoryPath: string | undefined;
  let sourceOutputDir: string | undefined;
  let targetOutputDir: string | undefined;
  let membershipBatchSize: number | undefined;
  let maxMembershipBatches: number | null | undefined;
  let forceNewRun = false;
  let replayCompleted = false;
  let refreshTrajectories = false;
  let atlasDisplayOverridesPath: string | undefined;
  let refinedTrajectoryPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--model") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --model");
      model = value;
      index += 1;
      continue;
    }
    if (arg === "--reasoning-effort") {
      const value = argv[index + 1] as CodexReasoningEffort | undefined;
      if (!value) throw new Error("Missing value for --reasoning-effort");
      reasoningEffort = value;
      index += 1;
      continue;
    }
    if (arg === "--iteration-label") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --iteration-label");
      iterationLabel = value;
      index += 1;
      continue;
    }
    if (arg === "--proposal-path") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --proposal-path");
      proposalPath = value;
      index += 1;
      continue;
    }
    if (arg === "--trajectory-path") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --trajectory-path");
      trajectoryPath = value;
      index += 1;
      continue;
    }
    if (arg === "--source-output-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --source-output-dir");
      sourceOutputDir = value;
      index += 1;
      continue;
    }
    if (arg === "--target-output-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --target-output-dir");
      targetOutputDir = value;
      index += 1;
      continue;
    }
    if (arg === "--membership-batch-size") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--membership-batch-size must be a positive integer");
      }
      membershipBatchSize = value;
      index += 1;
      continue;
    }
    if (arg === "--max-membership-batches") {
      const raw = argv[index + 1];
      if (!raw) throw new Error("Missing value for --max-membership-batches");
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error("--max-membership-batches must be a non-negative integer");
      }
      maxMembershipBatches = value;
      index += 1;
      continue;
    }
    if (arg === "--force-new-run") {
      forceNewRun = true;
      continue;
    }
    if (arg === "--replay-completed") {
      replayCompleted = true;
      continue;
    }
    if (arg === "--refresh-trajectories") {
      refreshTrajectories = true;
      continue;
    }
    if (arg === "--atlas-display-overrides") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --atlas-display-overrides");
      atlasDisplayOverridesPath = value;
      index += 1;
      continue;
    }
    if (arg === "--refined-trajectory-path") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --refined-trajectory-path");
      refinedTrajectoryPath = value;
      index += 1;
    }
  }

  if (Boolean(proposalPath) !== Boolean(trajectoryPath)) {
    throw new Error("--proposal-path and --trajectory-path must be supplied together");
  }
  if (refreshTrajectories && !replayCompleted) {
    throw new Error("--refresh-trajectories requires --replay-completed");
  }
  return {
    model,
    reasoningEffort,
    iterationLabel,
    proposalPath,
    trajectoryPath,
    sourceOutputDir,
    targetOutputDir,
    membershipBatchSize,
    maxMembershipBatches,
    forceNewRun,
    replayCompleted,
    refreshTrajectories,
    atlasDisplayOverridesPath,
    refinedTrajectoryPath
  };
}

function parseMasterCliOptions(argv: string[]): MasterCliOptions {
  const normalizeOptions = parseCliOptions(argv);
  const compileOptions = parseCompileCliOptions(argv);
  const consolidateOptions = parseConsolidateCliOptions(argv);

  return {
    ...normalizeOptions,
    ...compileOptions,
    ...consolidateOptions,
    // The master pipeline should produce the fully consolidated artifact bundle
    // unless the user explicitly disables the narrow review pass for debugging.
    useLlmReview: !argv.includes("--no-llm-review")
  };
}

function parseRenderCliOptions(argv: string[]): RenderCliOptions {
  let sourceOutputDir: string | undefined;
  let targetOutputDir: string | undefined;
  let macroMapPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === "--source-output-dir" ||
      arg === "--target-output-dir" ||
      arg === "--macro-map-path"
    ) {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      if (arg === "--source-output-dir") sourceOutputDir = value;
      if (arg === "--target-output-dir") targetOutputDir = value;
      if (arg === "--macro-map-path") macroMapPath = value;
      index += 1;
    }
  }

  return { sourceOutputDir, targetOutputDir, macroMapPath };
}

function parseSiteCliOptions(argv: string[]): SiteCliOptions {
  return {
    ...parseRenderCliOptions(argv),
    refreshWiki: argv.includes("--refresh-wiki")
  };
}

function parseSemanticDensityAuditCliOptions(argv: string[]): SemanticDensityAuditCliOptions {
  let label = "current";
  let corpusPath: string | undefined;
  let claimsPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--label") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --label");
      }
      label = value;
      index += 1;
      continue;
    }

    if (arg === "--corpus-path") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --corpus-path");
      }
      corpusPath = value;
      index += 1;
      continue;
    }

    if (arg === "--claims-path") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --claims-path");
      }
      claimsPath = value;
      index += 1;
    }
  }

  return { label, corpusPath, claimsPath };
}

function writeJsonArtifact(target: string, payload: unknown): string {
  // All generated side artifacts live in output/ so raw inputs stay untouched.
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return target;
}

function createCliProgressReporter(): ThrottledProgressReporter {
  return new ThrottledProgressReporter((message) => console.error(message));
}

function writeWritingsArtifacts(
  paths: ReturnType<typeof getProjectPaths>,
  writings: ReturnType<typeof normalizeWritings>
): { outputPath: string; manifestPath: string } {
  const outputPath = writeNormalizedWritings(paths, writings);
  const manifestPath = writeJsonArtifact(path.join(paths.manifestsDir, "writings_manifest.json"), {
    sourceDir: paths.writingsDir,
    recordCount: writings.length,
    items: writings.map((item) => ({
      id: item.id,
      title: item.title,
      sourceDate: item.sourceDate,
      sourcePath: item.sourcePath,
      wordCount: item.wordCount
    }))
  });

  return { outputPath, manifestPath };
}

function writeChatsArtifacts(
  paths: ReturnType<typeof getProjectPaths>,
  chats: ReturnType<typeof normalizeChats>,
  options: NormalizeCliOptions
): { outputPath: string; manifestPath: string } {
  const outputPath = writeNormalizedChats(paths, chats);
  const manifestPath = writeJsonArtifact(path.join(paths.manifestsDir, "chats_manifest.json"), {
    sourceDir: paths.chatsDir,
    ownerNames: options.ownerNames,
    includeOtherContext: options.includeOtherContext,
    contextWindow: options.contextWindow,
    recordCount: chats.length,
    items: chats.map((item) => ({
      id: item.id,
      title: item.title,
      sourcePath: item.sourcePath,
      ownerMessageCount: item.ownerMessageCount,
      otherMessageCount: item.otherMessageCount
    }))
  });

  return { outputPath, manifestPath };
}

function writeConversationsArtifacts(
  paths: ReturnType<typeof getProjectPaths>,
  conversations: ReturnType<typeof normalizeConversations>,
  options: NormalizeCliOptions,
  auditOutputs?: {
    jsonPath: string;
    markdownPath: string;
  }
): { outputPath: string; manifestPath: string } {
  const outputPath = writeNormalizedConversations(paths, conversations);
  const manifestPath = writeJsonArtifact(path.join(paths.manifestsDir, "conversations_manifest.json"), {
    sourceDir: paths.conversationsDir,
    includeAssistantContext: options.includeAssistantContext,
    includeToolContext: options.includeToolContext,
    contextWindow: options.contextWindow,
    prefilterEnabled: options.enableConversationPrefilter,
    workConversationFilterEnabled: options.enableWorkConversationFilter,
    recordCount: conversations.length,
    items: conversations.map((item) => ({
      id: item.id,
      title: item.title,
      sourcePath: item.sourcePath,
      gizmoId: item.gizmoId,
      userTurnCount: item.userTurnCount,
      assistantTurnCount: item.assistantTurnCount,
      toolTurnCount: item.toolTurnCount
    })),
    selectionPolicy: {
      excludesNonEmptyGizmoIds: true,
      nullGizmoRules: {
        excludesCodeFenceThreads: true,
        minimumTurnCountExclusive: 10
      },
      workConversationFilter: {
        enabled: options.enableWorkConversationFilter,
        auditJsonPath: auditOutputs?.jsonPath ?? null,
        auditMarkdownPath: auditOutputs?.markdownPath ?? null
      },
      enabled: options.enableConversationPrefilter
    }
  });

  return { outputPath, manifestPath };
}

function writeUnifiedArtifacts(
  paths: ReturnType<typeof getProjectPaths>,
  normalized: {
    writings: ReturnType<typeof normalizeWritings>;
    conversations: ReturnType<typeof normalizeConversations>;
    chats: ReturnType<typeof normalizeChats>;
  },
  options: NormalizeCliOptions,
  progress?: (message: string) => void
): { outputPath: string; manifestPath: string } {
  const corpus = buildUnifiedCorpus(normalized, options, progress);
  const outputPath = writeUnifiedCorpus(paths, corpus);
  const manifestPath = writeJsonArtifact(
    path.join(paths.manifestsDir, "unified_manifest.json"),
    buildUnifiedManifest(corpus)
  );

  return { outputPath, manifestPath };
}

/**
 * CLI entrypoint for discovery, normalization, and reset commands.
 */
function main(): number {
  const command = process.argv[2];

  if (!command) {
    console.error(
      "Usage: cli <discover|discover-write|normalize-writings|normalize-chats|normalize-conversations|normalize-unified|normalize-all|master|compile-thought-nodes|consolidate-thought-graph|align-writing-frames|build-thought-macro-map|render-wiki|render-site|export-gpt|export-source-archive|audit-document-frames|audit-conversation-turns|audit-semantic-density|audit-real-run|nuke>"
    );
    return 1;
  }

  const paths = getProjectPaths();

  if (command === "nuke") {
    // This is a debug/reset utility for generated artifacts only. It is not the
    // normal operational path for incremental compilation.
    console.log(JSON.stringify(nukeGeneratedArtifacts(paths), null, 2));
    return 0;
  }

  if (command === "discover") {
    // This is a read-only inspection command meant for quick debugging.
    const manifest = buildManifest(paths);
    console.log(JSON.stringify(manifest, null, 2));
    return 0;
  }

  if (command === "discover-write") {
    // Persist the same source view so later steps can diff against it.
    const manifest = buildManifest(paths);
    const target = writeManifest(paths, manifest);
    console.log(target);
    return 0;
  }

  if (command === "normalize-writings") {
    const progressSink = (message: string) => console.error(message);
    // Writings are treated as authored high-signal material, so we normalize
    // them into a direct JSON form without additional interpretation yet.
    const writings = normalizeWritings(paths, progressSink);
    const { outputPath, manifestPath } = writeWritingsArtifacts(paths, writings);
    console.log(JSON.stringify({ outputPath, manifestPath }, null, 2));
    return 0;
  }

  if (command === "normalize-chats") {
    const options = parseCliOptions(process.argv.slice(3));
    const progressSink = (message: string) => console.error(message);
    if (options.ownerNames.length === 0) {
      console.error("normalize-chats requires at least one configured owner name.");
      return 1;
    }

    // Chats are normalized into a user-centered representation where owner
    // messages are primary and the rest is optional context.
    const chats = normalizeChats(paths, options, progressSink);
    const { outputPath, manifestPath } = writeChatsArtifacts(paths, chats, options);
    console.log(JSON.stringify({ outputPath, manifestPath }, null, 2));
    return 0;
  }

  if (command === "normalize-conversations") {
    const options = parseCliOptions(process.argv.slice(3));
    const progressSink = (message: string) => console.error(message);
    const conversationResult = normalizeConversationsWithReport(paths, {
      includeAssistantContext: options.includeAssistantContext,
      includeToolContext: options.includeToolContext,
      contextWindow: options.contextWindow,
      enablePrefilter: options.enableConversationPrefilter,
      enableWorkFilter: options.enableWorkConversationFilter
    }, progressSink);
    const auditOutputs = writeWorkConversationAudit(paths, conversationResult.report);
    const { outputPath, manifestPath } = writeConversationsArtifacts(
      paths,
      conversationResult.records,
      options,
      auditOutputs
    );
    console.log(JSON.stringify({ outputPath, manifestPath, workConversationAudit: auditOutputs }, null, 2));
    return 0;
  }

  if (command === "normalize-unified") {
    // This is the final normalization layer consumed by the future compiler.
    // It keeps raw-source distinctions but emits one shared document/segment model.
    const options = parseCliOptions(process.argv.slice(3));
    const progress = createCliProgressReporter();
    const progressSink = (message: string) => console.error(message);
    progress.phase("normalize", "starting unified normalization");
    const writings = normalizeWritings(paths, progressSink);
    const conversationResult = normalizeConversationsWithReport(paths, {
      includeAssistantContext: options.includeAssistantContext,
      includeToolContext: options.includeToolContext,
      contextWindow: options.contextWindow,
      enablePrefilter: options.enableConversationPrefilter,
      enableWorkFilter: options.enableWorkConversationFilter
    }, progressSink);
    const conversations = conversationResult.records;
    const workConversationAudit = writeWorkConversationAudit(paths, conversationResult.report);
    const chats = normalizeChats(paths, options, progressSink);
    const { outputPath, manifestPath } = writeUnifiedArtifacts(
      paths,
      {
        writings,
        conversations,
        chats
      },
      options,
      progressSink
    );
    progress.phase("normalize", "unified corpus written");
    console.log(JSON.stringify({ outputPath, manifestPath, workConversationAudit }, null, 2));
    return 0;
  }

  if (command === "normalize-all") {
    // The combined path is convenient for batch runs, but still keeps chats
    // opt-in because owner identity must be supplied deliberately.
    const options = parseCliOptions(process.argv.slice(3));
    const progress = createCliProgressReporter();
    const progressSink = (message: string) => console.error(message);
    progress.phase("normalize", "starting full normalization");
    const writings = normalizeWritings(paths, progressSink);
    const writingsArtifacts = writeWritingsArtifacts(paths, writings);
    const conversationResult = normalizeConversationsWithReport(paths, {
      includeAssistantContext: options.includeAssistantContext,
      includeToolContext: options.includeToolContext,
      contextWindow: options.contextWindow,
      enablePrefilter: options.enableConversationPrefilter,
      enableWorkFilter: options.enableWorkConversationFilter
    }, progressSink);
    const workConversationAudit = writeWorkConversationAudit(paths, conversationResult.report);
    const conversations = conversationResult.records;
    const conversationsArtifacts = writeConversationsArtifacts(
      paths,
      conversations,
      options,
      workConversationAudit
    );
    const chats = normalizeChats(paths, options, progressSink);
    const unifiedArtifacts = writeUnifiedArtifacts(
      paths,
      {
        writings,
        conversations,
        chats
      },
      options,
      progressSink
    );

    const result: Record<string, unknown> = {
      writingsPath: writingsArtifacts.outputPath,
      writingsManifestPath: writingsArtifacts.manifestPath,
      conversationsPath: conversationsArtifacts.outputPath,
      conversationsManifestPath: conversationsArtifacts.manifestPath,
      workConversationAuditJsonPath: workConversationAudit.jsonPath,
      workConversationAuditMarkdownPath: workConversationAudit.markdownPath,
      unifiedPath: unifiedArtifacts.outputPath,
      unifiedManifestPath: unifiedArtifacts.manifestPath
    };

    if (chats.length > 0) {
      const chatsArtifacts = writeChatsArtifacts(paths, chats, options);
      result.chatsPath = chatsArtifacts.outputPath;
      result.chatsManifestPath = chatsArtifacts.manifestPath;
    }

    const manifest = buildManifest(paths);
    result.sourceManifestPath = writeManifest(paths, manifest);
    progress.phase("normalize", "full normalization complete");
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (command === "master") {
    // This is the main rebuild path after nuke: normalize everything, compile
    // and consolidate the graph, build its vertical and macro structure, and
    // only then materialize the wiki/site/GPT artifacts.
    const options = parseMasterCliOptions(process.argv.slice(3));
    const progress = createCliProgressReporter();
    const progressSink = (message: string) => console.error(message);
    progress.phase("master", "phase 1/11: normalization");
    const writings = normalizeWritings(paths, progressSink);
    const writingsArtifacts = writeWritingsArtifacts(paths, writings);
    const conversationResult = normalizeConversationsWithReport(paths, {
      includeAssistantContext: options.includeAssistantContext,
      includeToolContext: options.includeToolContext,
      contextWindow: options.contextWindow,
      enablePrefilter: options.enableConversationPrefilter,
      enableWorkFilter: options.enableWorkConversationFilter
    }, progressSink);
    const workConversationAudit = writeWorkConversationAudit(paths, conversationResult.report);
    const conversations = conversationResult.records;
    const conversationsArtifacts = writeConversationsArtifacts(
      paths,
      conversations,
      options,
      workConversationAudit
    );
    const chats = normalizeChats(paths, options, progressSink);
    const unifiedArtifacts = writeUnifiedArtifacts(
      paths,
      {
        writings,
        conversations,
        chats
      },
      options,
      progressSink
    );

    const sourceManifestPath = writeManifest(paths, buildManifest(paths));
    const result: Record<string, unknown> = {
      sourceManifestPath,
      writingsPath: writingsArtifacts.outputPath,
      writingsManifestPath: writingsArtifacts.manifestPath,
      conversationsPath: conversationsArtifacts.outputPath,
      conversationsManifestPath: conversationsArtifacts.manifestPath,
      workConversationAuditJsonPath: workConversationAudit.jsonPath,
      workConversationAuditMarkdownPath: workConversationAudit.markdownPath,
      unifiedPath: unifiedArtifacts.outputPath,
      unifiedManifestPath: unifiedArtifacts.manifestPath
    };

    if (chats.length > 0) {
      const chatsArtifacts = writeChatsArtifacts(paths, chats, options);
      result.chatsPath = chatsArtifacts.outputPath;
      result.chatsManifestPath = chatsArtifacts.manifestPath;
    }

    const corpusHash = computeStableUnifiedCorpusHash(unifiedArtifacts.outputPath);
    let masterState = openMasterRun(paths, corpusHash, {
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      useLlmReview: options.useLlmReview,
      forceNewRun: options.forceNewRun
    });
    result.masterGenerationId = masterState.generationId;
    result.corpusHash = corpusHash;

    progress.phase("master", "phase 2/11: deterministic input preflight");
    const conversationTurnAudit = runConversationTurnAudit(paths);
    result.conversationTurnAuditSummary = conversationTurnAudit.summary;
    if (!conversationTurnAudit.summary.passing) {
      console.log(JSON.stringify(result, null, 2));
      return 1;
    }
    if (!masterPhaseReached(masterState, "compiled")) {
      markMasterPhase(paths, masterState, "preflight");
    }
    masterState = refreshMasterReuseState(paths, masterState);

    // Legacy macro batches know the exact graph they classified. Promote them
    // into the item cache while that accepted graph is still on disk; compile
    // or consolidation may publish a semantically updated graph afterwards.
    result.preparedMacroMembershipItemCount = options.forceNewRun
      ? 0
      : prepareScaledMacroMapIncrementalReuse({
          paths,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          progress: progressSink
        });

    progress.phase("master", "phase 3/11: semantic compile");
    const client = new CodexCliClient({
      projectRoot: paths.root,
      defaultModel: options.model,
      defaultReasoningEffort: options.reasoningEffort
    });

    const thoughtGraphPath = path.join(
      paths.compiledDir,
      SECOND_BRAIN_DEFAULTS.thoughtCompiler.compiledGraphFilename
    );
    const compileSummary = masterPhaseReached(masterState, "compiled")
      ? {
          status: "completed",
          skipped: true,
          reason: "master phase checkpoint and semantic artifact identity match",
          graphPath: thoughtGraphPath,
          corpusHash
        }
      : compileThoughtNodes(paths, client, {
          batchSize: options.batchSize,
          maxBatches: options.maxBatches,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          semanticReusePolicy: options.semanticReusePolicy,
          forceNewRun: options.forceNewRun,
          progress: progressSink
        });
    result.compileSummary = compileSummary;

    if (compileSummary.status !== "completed") {
      console.log(JSON.stringify(result, null, 2));
      return 1;
    }
    if (!masterPhaseReached(masterState, "compiled")) {
      const graph = JSON.parse(readFileSync(thoughtGraphPath, "utf8")) as ThoughtGraph;
      markMasterPhase(paths, masterState, "compiled", {
        thoughtGraphSemanticHash: computeThoughtGraphSemanticHash(graph)
      });
    }

    progress.phase("master", "phase 4/11: consolidation");
    const consolidationClient = options.useLlmReview ? client : undefined;
    const consolidatedGraphPath = path.join(
      paths.compiledDir,
      SECOND_BRAIN_DEFAULTS.thoughtConsolidation.compiledGraphFilename
    );
    const consolidateSummary = masterPhaseReached(masterState, "consolidated")
      ? {
          status: "completed",
          skipped: true,
          reason: "master phase checkpoint and semantic artifact identity match",
          graphPath: consolidatedGraphPath
        }
      : consolidateThoughtGraph(paths, {
          client: consolidationClient,
          useLlmReview: options.useLlmReview,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          forceNewRun: options.forceNewRun,
          progress: progressSink
        });
    result.consolidateSummary = consolidateSummary;
    if (!masterPhaseReached(masterState, "consolidated")) {
      const graph = JSON.parse(
        readFileSync(consolidatedGraphPath, "utf8")
      ) as ConsolidatedThoughtGraph;
      markMasterPhase(paths, masterState, "consolidated", {
        consolidatedGraphSemanticHash: computeConsolidatedGraphSemanticHash(graph)
      });
    }

    progress.phase("master", "phase 5/11: vertical alignment");
    const frameAlignmentPath = path.join(
      paths.compiledDir,
      SECOND_BRAIN_DEFAULTS.thoughtFrameAlignment.compiledArtifactFilename
    );
    result.frameAlignmentSummary = masterPhaseReached(masterState, "aligned")
      ? {
          skipped: true,
          reason: "master phase checkpoint and semantic artifact identity match",
          artifactPath: frameAlignmentPath
        }
      : alignWritingFrames(paths);
    if (!masterPhaseReached(masterState, "aligned")) {
      const artifact = JSON.parse(
        readFileSync(frameAlignmentPath, "utf8")
      ) as ThoughtFrameAlignmentArtifact;
      markMasterPhase(paths, masterState, "aligned", {
        frameAlignmentSemanticHash: computeFrameAlignmentSemanticHash(artifact)
      });
    }

    progress.phase("master", "phase 6/11: macro map");
    const macroMapSummary = buildScaledThoughtMacroMap({
      paths,
      client,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      iterationLabel: "master",
      forceNewRun: options.forceNewRun,
      progress: progressSink
    });
    result.macroMapSummary = macroMapSummary;
    if (macroMapSummary.status !== "completed") {
      console.log(JSON.stringify(result, null, 2));
      return 1;
    }
    markMasterPhase(paths, masterState, "macro_mapped");

    progress.phase("master", "phase 7/11: markdown wiki render");
    // These deterministic materializations are cheap and reconstructible. Run
    // them on every successful semantic generation so a manually removed or
    // partially written presentation artifact cannot be mistaken for complete.
    result.wikiSummary = renderValidationWiki(paths, {
      macroMapPath: macroMapSummary.artifactPath,
      progress: progressSink
    });

    progress.phase("master", "phase 8/11: html site render");
    result.siteSummary = renderValidationSite(paths, {
      progress: progressSink
    });

    progress.phase("master", "phase 9/11: custom gpt export");
    result.gptExportSummary = renderGptMarkdownExport(paths, {
      macroMapPath: macroMapSummary.artifactPath,
      progress: progressSink
    });

    progress.phase("master", "phase 10/11: linked source archive export");
    result.sourceArchiveSummary = renderSourceArchive(paths);
    markMasterPhase(paths, masterState, "rendered");

    progress.phase("master", "phase 11/11: deterministic quality audits");
    const semanticDensityAudit = runSemanticDensityAudit(paths, {
      label: "master"
    });
    const realRunDiagnostics = runRealRunDiagnostics(paths);
    result.semanticDensityAuditSummary = semanticDensityAudit.summary;
    result.realRunDiagnosticsSummary = {
      attention: realRunDiagnostics.attention,
      outputs: realRunDiagnostics.outputs
    };

    if (
      semanticDensityAudit.summary.passing &&
      realRunDiagnostics.attention.level !== "error"
    ) {
      markMasterPhase(paths, masterState, "audited");
    }

    progress.phase("master", "done");
    console.log(JSON.stringify(result, null, 2));
    return semanticDensityAudit.summary.passing && realRunDiagnostics.attention.level !== "error"
      ? 0
      : 1;
  }

  if (command === "compile-thought-nodes") {
    // The semantic compiler is batch-oriented and checkpointed so it can
    // survive auth/quota interruptions without starting from scratch.
    const options = parseCompileCliOptions(process.argv.slice(3));
    const progressSink = (message: string) => console.error(message);
    const client = new CodexCliClient({
      projectRoot: paths.root,
      defaultModel: options.model,
      defaultReasoningEffort: options.reasoningEffort
    });
    const summary = compileThoughtNodes(paths, client, {
      ...options,
      progress: progressSink
    });
    console.log(JSON.stringify(summary, null, 2));

    if (
      summary.status === "paused_auth" ||
      summary.status === "paused_quota" ||
      summary.status === "failed"
    ) {
      return 1;
    }

    return 0;
  }

  if (command === "audit-document-frames") {
    // This is a deterministic quality gate over source-local writing and conversation frames.
    // layer. It inspects the compiled frame artifact and writes a reusable
    // markdown + JSON report without spending more LLM tokens.
    const report = runDocumentFrameAudit(paths);
    console.log(
      JSON.stringify(
        {
          jsonPath: report.outputs.jsonPath,
          markdownPath: report.outputs.markdownPath,
          summary: report.summary
        },
        null,
        2
      )
    );
    return 0;
  }

  if (command === "audit-conversation-turns") {
    // Deterministic quality gate over normalized conversation user turns. This
    // verifies that pasted external documents were removed or trimmed before
    // they can become primary semantic-compile inputs.
    const report = runConversationTurnAudit(paths);
    console.log(
      JSON.stringify(
        {
          jsonPath: report.outputs.jsonPath,
          markdownPath: report.outputs.markdownPath,
          summary: report.summary
        },
        null,
        2
      )
    );
    return report.summary.passing ? 0 : 1;
  }

  if (command === "audit-semantic-density") {
    const options = parseSemanticDensityAuditCliOptions(process.argv.slice(3));
    const report = runSemanticDensityAudit(paths, options);
    console.log(
      JSON.stringify(
        {
          jsonPath: report.outputs.jsonPath,
          markdownPath: report.outputs.markdownPath,
          summary: report.summary
        },
        null,
        2
      )
    );
    return report.summary.passing ? 0 : 1;
  }

  if (command === "audit-real-run") {
    const report = runRealRunDiagnostics(paths);
    console.log(
      JSON.stringify(
        {
          jsonPath: report.outputs.jsonPath,
          markdownPath: report.outputs.markdownPath,
          summary: {
            attention: report.attention,
            corpus: report.corpus,
            batching: report.batching,
            compile: report.compile,
            consolidation: report.consolidation,
            graph: report.graph,
            provenance: report.provenance
          }
        },
        null,
        2
      )
    );
    return report.attention.level === "error" ? 1 : 0;
  }

  if (command === "align-writing-frames") {
    // This deterministic stage builds the first cross-writing parent layer
    // above source-local document frames, without reviving the old graph-first
    // vertical renderer path.
    const summary = alignWritingFrames(paths);
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  if (command === "build-thought-macro-map") {
    const options = parseMacroMapCliOptions(process.argv.slice(3));
    const proposalReplayMode = Boolean(options.proposalPath && options.trajectoryPath);
    const client = proposalReplayMode || (options.replayCompleted && !options.refreshTrajectories)
      ? undefined
      : new CodexCliClient({
      projectRoot: paths.root,
      defaultModel: options.model,
      defaultReasoningEffort: options.reasoningEffort
    });
    const summary = proposalReplayMode
      ? buildThoughtMacroMap({
          paths,
          client,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          iterationLabel: options.iterationLabel,
          proposalPath: options.proposalPath,
          trajectoryPath: options.trajectoryPath
        })
      : buildScaledThoughtMacroMap({
          paths,
          client: client!,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          iterationLabel: options.iterationLabel,
          sourceOutputDir: options.sourceOutputDir,
          targetOutputDir: options.targetOutputDir,
          membershipBatchSize: options.membershipBatchSize,
          maxMembershipBatches: options.maxMembershipBatches,
          forceNewRun: options.forceNewRun,
          replayCompleted: options.replayCompleted,
          refreshTrajectories: options.refreshTrajectories,
          atlasDisplayOverridesPath: options.atlasDisplayOverridesPath,
          refinedTrajectoryPath: options.refinedTrajectoryPath,
          progress: (message) => console.error(message)
        });
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  if (command === "consolidate-thought-graph") {
    // This second pass intentionally sits above the granular graph artifacts so
    // we can build larger browseable thought units without weakening the first
    // semantic extraction layer.
    const options = parseConsolidateCliOptions(process.argv.slice(3));
    const progressSink = (message: string) => console.error(message);
    const client = options.useLlmReview
      ? new CodexCliClient({
          projectRoot: paths.root,
          defaultModel: options.model,
          defaultReasoningEffort: options.reasoningEffort
        })
      : undefined;
    const summary = consolidateThoughtGraph(paths, {
      client,
      useLlmReview: options.useLlmReview,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      forceNewRun: options.forceNewRun,
      progress: progressSink
    });
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  if (command === "render-wiki") {
    // The wiki renderer turns the consolidated graph into a browseable
    // markdown validation surface with links back to source evidence.
    const options = parseRenderCliOptions(process.argv.slice(3));
    const progressSink = (message: string) => console.error(message);
    const summary = renderValidationWiki(paths, {
      sourceOutputDir: options.sourceOutputDir,
      targetOutputDir: options.targetOutputDir,
      macroMapPath: options.macroMapPath,
      progress: progressSink
    });
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  if (command === "render-site") {
    // The site renderer wraps the markdown wiki in static HTML so it can be
    // opened directly in a browser without adding an app server.
    const options = parseSiteCliOptions(process.argv.slice(3));
    const progressSink = (message: string) => console.error(message);
    const summary = renderValidationSite(paths, {
      refreshWiki: options.refreshWiki,
      sourceOutputDir: options.sourceOutputDir,
      targetOutputDir: options.targetOutputDir,
      macroMapPath: options.macroMapPath,
      progress: progressSink
    });
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  if (command === "export-gpt") {
    // The public exporter has one graph-native format and requires the macro
    // map produced by the semantic pipeline (or an explicit artifact path).
    const options = parseRenderCliOptions(process.argv.slice(3));
    const progressSink = (message: string) => console.error(message);
    const summary = renderGptMarkdownExport(paths, {
      sourceOutputDir: options.sourceOutputDir,
      targetOutputDir: options.targetOutputDir,
      macroMapPath: options.macroMapPath,
      progress: progressSink
    });
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  if (command === "export-source-archive") {
    // This is an offline projection of already completed graph, macro-map, and
    // normalized artifacts. It never invokes semantic workers or an LLM.
    const options = parseRenderCliOptions(process.argv.slice(3));
    const summary = renderSourceArchive(paths, {
      sourceOutputDir: options.sourceOutputDir,
      targetOutputDir: options.targetOutputDir
    });
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  console.error(`Unknown command: ${command}`);
  return 1;
}

process.exit(main());
