import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import { buildThoughtCompilerBatches } from "../compiler/batching.js";
import type {
  ConsolidatedThoughtGraph,
  ConsolidatedThoughtNode,
  ThoughtClaim,
  ThoughtDocumentFrameArtifact,
  ThoughtGraph,
  ThoughtNodeState
} from "../compiler/types.js";
import type { ProjectPaths } from "../system/paths.js";
import type { SourceKind, UnifiedCorpus } from "../types/domain.js";
import { slugify } from "../utils/text.js";
import { runConversationTurnAudit } from "./conversation_turn_audit.js";
import { runDocumentFrameAudit } from "./document_frame_audit.js";

const LONG_SEGMENT_CHARACTER_THRESHOLD = 4_000;
const NEAR_DUPLICATE_TITLE_THRESHOLD = 0.72;
const MAX_DIAGNOSTIC_SAMPLES = 25;
const SOURCE_KINDS: SourceKind[] = ["writing", "conversation", "chat"];
const TITLE_STOPWORDS = new Set([
  "a", "an", "and", "as", "bez", "by", "do", "for", "i", "in", "is", "jako", "je",
  "k", "ke", "na", "nad", "nebo", "o", "od", "of", "po", "pod", "pro", "se", "s",
  "the", "to", "u", "ve", "vs", "v", "with", "z", "za", "ze"
]);
const GENERIC_TITLE_TOKENS = new Set([
  "idea", "ideas", "note", "notes", "overview", "tema", "temata", "otazka", "otazky",
  "problem", "problemy", "myslenka", "myslenky", "vyvoj", "zmena", "zmeny", "vztah",
  "vztahy", "system", "kontext", "proces", "thing", "things", "topic", "topics"
]);

type CompileManifest = {
  status?: string;
  success?: boolean;
  totalBatchCount?: number;
  completedBatchCount?: number;
  reusedSemanticItemCount?: number;
  pendingSemanticItemCount?: number;
  incremental?: {
    mode?: string;
    reusePolicy?: string;
    semanticItems?: {
      totalPrimarySegmentCount?: number;
      reusedCount?: number;
      reusedCurrentContractCount?: number;
      reusedPriorContractCount?: number;
      newCount?: number;
    } | null;
  };
};

type ConsolidationDiagnostics = {
  mode?: string;
  reuse?: {
    reviewCandidateCount?: number;
    reusedReviewDecisionCount?: number;
    generatedReviewDecisionCount?: number;
    synthesisClusterCount?: number;
    reusedSynthesisCount?: number;
    generatedSynthesisCount?: number;
  };
  recommendation?: {
    broaderPathUsed?: boolean;
    broaderConsolidationRerunRecommended?: boolean;
    severity?: string;
    reasons?: string[];
  };
  affectedScope?: Record<string, unknown>;
};

type AffectedScope = {
  mode?: string;
  fallbackMode?: string;
  fallbackReasons?: string[];
  stats?: Record<string, number>;
};

type FrameAuditSummary = {
  documentsWithErrors?: number;
  documentsWithWarningsOnly?: number;
  cleanDocuments?: number;
  documentsWithErrorsBySourceKind?: Record<string, number>;
  documentsWithWarningsOnlyBySourceKind?: Record<string, number>;
};

type ConversationTurnAuditSummary = {
  suspiciousRemainingTurnCount?: number;
  passing?: boolean;
};

type GptExportManifest = {
  markdownFileCount?: number;
  totalBytes?: number;
  uploadBudget?: {
    maxMarkdownFiles?: number;
    targetMaxBytesPerFile?: number;
    hardMaxBytesPerFile?: number;
  };
  files?: Array<{ filename?: string; bytes?: number }>;
};

export type RealRunDiagnosticsInputs = {
  corpus: UnifiedCorpus;
  documentFrames: ThoughtDocumentFrameArtifact | null;
  thoughtGraph: ThoughtGraph;
  consolidatedGraph: ConsolidatedThoughtGraph;
  claims: ThoughtClaim[];
  nodeStates: ThoughtNodeState[];
  compileManifest: CompileManifest | null;
  consolidationDiagnostics: ConsolidationDiagnostics | null;
  affectedScope: AffectedScope | null;
  frameAuditSummary: FrameAuditSummary | null;
  conversationTurnAuditSummary: ConversationTurnAuditSummary | null;
  gptExportManifest: GptExportManifest | null;
};

export type RealRunDiagnosticsReport = {
  generatedAt: string;
  inputs: Record<string, string | null>;
  corpus: {
    documentCount: number;
    segmentCount: number;
    primarySegmentCount: number;
    contextSegmentCount: number;
    documentsBySourceKind: Record<SourceKind, number>;
    segmentsBySourceKind: Record<SourceKind, number>;
    primarySegmentsBySourceKind: Record<SourceKind, number>;
    longPrimarySegmentCount: number;
    longPrimarySegmentsBySourceKind: Record<SourceKind, number>;
    longPrimarySegmentIdsSample: string[];
  };
  batching: {
    estimatedBatchCount: number;
    estimatedInputTokens: number;
    largestEstimatedBatchTokens: number;
    singletonBatchCount: number;
  };
  compile: {
    status: string | null;
    mode: string | null;
    reusePolicy: string | null;
    totalSemanticItems: number | null;
    reusedSemanticItems: number | null;
    newSemanticItems: number | null;
    reusedCurrentContractItems: number | null;
    reusedPriorContractItems: number | null;
  };
  consolidation: {
    mode: string | null;
    reviewCandidateCount: number | null;
    reusedReviewDecisionCount: number | null;
    generatedReviewDecisionCount: number | null;
    synthesisClusterCount: number | null;
    reusedSynthesisCount: number | null;
    generatedSynthesisCount: number | null;
    fallbackMode: string | null;
    fallbackReasons: string[];
    broaderPathUsed: boolean | null;
    broaderRerunRecommended: boolean | null;
    recommendationReasons: string[];
    affectedScopeStats: Record<string, number>;
  };
  graph: {
    granular: { nodeCount: number; edgeCount: number; claimCount: number; stateCount: number };
    consolidated: {
      nodeCount: number;
      edgeCount: number;
      sourceMix: Record<string, number>;
      isolatedNodeCount: number;
      componentCount: number;
      largestComponentSize: number;
      largestComponents: number[];
      largestHubs: Array<{ nodeId: string; title: string; degree: number }>;
    };
  };
  provenance: {
    anchoredPrimarySegmentCount: number;
    primarySegmentCount: number;
    coverageShare: number;
    coverageBySourceKind: Record<
      SourceKind,
      { anchoredCount: number; totalCount: number; coverageShare: number }
    >;
    unanchoredPrimarySegmentIdsSample: string[];
  };
  qualitySignals: {
    counts: {
      nearDuplicateTitlePairs: number;
      conversationOnlyOneOffs: number;
      weakProvenanceMerges: number;
      stateProliferation: number;
      genericHubs: number;
    };
    nearDuplicateTitles: Array<{
      leftNodeId: string;
      leftTitle: string;
      rightNodeId: string;
      rightTitle: string;
      similarity: number;
    }>;
    conversationOnlyOneOffs: Array<{
      nodeId: string;
      title: string;
      sourceDocumentId: string | null;
    }>;
    weakProvenanceMerges: Array<{
      nodeId: string;
      title: string;
      memberNodeCount: number;
      sourceDocumentCount: number;
    }>;
    stateProliferation: Array<{
      nodeId: string;
      title: string;
      claimCount: number;
      stateCount: number;
    }>;
    genericHubs: Array<{ nodeId: string; title: string; degree: number }>;
  };
  auditGates: {
    frameErrors: number | null;
    frameWarnings: number | null;
    suspiciousConversationTurns: number | null;
  };
  gptExport: {
    available: boolean;
    markdownFileCount: number | null;
    totalBytes: number | null;
    largestFileBytes: number | null;
    filesOverTarget: string[];
    maxMarkdownFiles: number | null;
    targetMaxBytesPerFile: number | null;
    hardMaxBytesPerFile: number | null;
  };
  attention: {
    level: "none" | "watch" | "error";
    reasons: string[];
  };
  outputs: { jsonPath: string; markdownPath: string };
};

function readJson<T>(target: string, required = true): T | null {
  if (!existsSync(target)) {
    if (required) {
      throw new Error(`Missing real-run diagnostics input: ${target}`);
    }
    return null;
  }
  return JSON.parse(readFileSync(target, "utf8")) as T;
}

function sourceCountRecord(): Record<SourceKind, number> {
  return { writing: 0, conversation: 0, chat: 0 };
}

function titleTokens(title: string): Set<string> {
  return new Set(
    slugify(title)
      .split("-")
      .filter((token) => token.length >= 2 && !TITLE_STOPWORDS.has(token))
  );
}

function sourceRefIdentity(sourceRef: ConsolidatedThoughtNode["sourceRefs"][number]): string {
  return [
    sourceRef.sourceKind,
    sourceRef.documentId,
    sourceRef.sourcePath,
    sourceRef.locator,
    sourceRef.sourceItemId ?? ""
  ].join("|");
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / (left.size + right.size - overlap);
}

function findNearDuplicateTitles(nodes: ConsolidatedThoughtNode[]) {
  const tokenSets = nodes.map((node) => titleTokens(node.title));
  const matches: RealRunDiagnosticsReport["qualitySignals"]["nearDuplicateTitles"] = [];
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex]!;
    const leftTokens = tokenSets[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex]!;
      const rightTokens = tokenSets[rightIndex]!;
      if (Math.abs(leftTokens.size - rightTokens.size) > 3) continue;
      const similarity = jaccard(leftTokens, rightTokens);
      if (similarity < NEAR_DUPLICATE_TITLE_THRESHOLD) continue;
      matches.push({
        leftNodeId: left.id,
        leftTitle: left.title,
        rightNodeId: right.id,
        rightTitle: right.title,
        similarity: Number(similarity.toFixed(3))
      });
    }
  }
  return matches.sort((left, right) => right.similarity - left.similarity);
}

function graphShape(graph: ConsolidatedThoughtGraph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const adjacency = new Map(graph.nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of graph.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
  }
  const degrees = graph.nodes.map((node) => ({
    nodeId: node.id,
    title: node.title,
    degree: adjacency.get(node.id)?.size ?? 0
  }));
  const visited = new Set<string>();
  const componentSizes: number[] = [];
  for (const node of graph.nodes) {
    if (visited.has(node.id)) continue;
    const queue = [node.id];
    visited.add(node.id);
    let size = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      size += 1;
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    componentSizes.push(size);
  }
  componentSizes.sort((left, right) => right - left);
  return {
    degrees,
    isolatedNodeCount: degrees.filter((item) => item.degree === 0).length,
    componentCount: componentSizes.length,
    largestComponentSize: componentSizes[0] ?? 0,
    largestComponents: componentSizes.slice(0, 10),
    largestHubs: degrees
      .slice()
      .sort((left, right) => right.degree - left.degree || left.nodeId.localeCompare(right.nodeId))
      .slice(0, 15)
  };
}

function sourceMix(nodes: ConsolidatedThoughtNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of nodes) {
    const active = SOURCE_KINDS.filter((kind) => (node.signalBySourceKind[kind] ?? 0) > 0);
    const key = active.length === 0 ? "none" : active.join("+");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function formatNumber(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function renderMarkdown(report: RealRunDiagnosticsReport): string {
  const lines: string[] = [
    "# Real-Run Diagnostics",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Attention: **${report.attention.level}**`,
    `- Documents / primary segments: ${report.corpus.documentCount} / ${report.corpus.primarySegmentCount}`,
    `- Estimated batches / input tokens: ${report.batching.estimatedBatchCount} / ${report.batching.estimatedInputTokens}`,
    `- Granular graph: ${report.graph.granular.nodeCount} nodes / ${report.graph.granular.edgeCount} edges`,
    `- Consolidated graph: ${report.graph.consolidated.nodeCount} nodes / ${report.graph.consolidated.edgeCount} edges`,
    `- Source-anchor coverage: ${(report.provenance.coverageShare * 100).toFixed(1)}%`,
    `- GPT export: ${report.gptExport.markdownFileCount ?? "n/a"} files / ${report.gptExport.totalBytes ?? "n/a"} bytes`,
    "",
    "## Attention",
    ""
  ];
  lines.push(...(report.attention.reasons.length > 0 ? report.attention.reasons.map((reason) => `- ${reason}`) : ["- none"]));
  lines.push(
    "",
    "## Incremental Reuse",
    "",
    `- Compile mode: ${report.compile.mode ?? "n/a"}`,
    `- Semantic reused / new: ${formatNumber(report.compile.reusedSemanticItems)} / ${formatNumber(report.compile.newSemanticItems)}`,
    `- Consolidation mode: ${report.consolidation.mode ?? "n/a"}`,
    `- Review reused / generated: ${formatNumber(report.consolidation.reusedReviewDecisionCount)} / ${formatNumber(report.consolidation.generatedReviewDecisionCount)}`,
    `- Synthesis reused / generated: ${formatNumber(report.consolidation.reusedSynthesisCount)} / ${formatNumber(report.consolidation.generatedSynthesisCount)}`,
    `- Fallback: ${report.consolidation.fallbackMode ?? "n/a"}`,
    `- Broader rerun recommended: ${report.consolidation.broaderRerunRecommended ?? "n/a"}`,
    "",
    "## Graph Shape",
    "",
    `- Components: ${report.graph.consolidated.componentCount}`,
    `- Largest component: ${report.graph.consolidated.largestComponentSize}`,
    `- Isolated nodes: ${report.graph.consolidated.isolatedNodeCount}`,
    "- Largest hubs:"
  );
  for (const hub of report.graph.consolidated.largestHubs.slice(0, 10)) {
    lines.push(`  - ${hub.degree} · ${hub.title} (\`${hub.nodeId}\`)`);
  }
  lines.push("", "## Quality Signals", "");
  const qualityRows: Array<[string, number]> = [
    ["Near-duplicate title pairs", report.qualitySignals.counts.nearDuplicateTitlePairs],
    ["Conversation-only one-offs", report.qualitySignals.counts.conversationOnlyOneOffs],
    ["Weak-provenance merges", report.qualitySignals.counts.weakProvenanceMerges],
    ["State-proliferation candidates", report.qualitySignals.counts.stateProliferation],
    ["Generic hubs", report.qualitySignals.counts.genericHubs]
  ];
  for (const [label, count] of qualityRows) lines.push(`- ${label}: ${count}`);
  lines.push("", "### Near-Duplicate Titles", "");
  lines.push(
    ...(report.qualitySignals.nearDuplicateTitles.length === 0
      ? ["- none"]
      : report.qualitySignals.nearDuplicateTitles.slice(0, 15).map(
          (item) => `- ${item.similarity.toFixed(3)} · ${item.leftTitle} ↔ ${item.rightTitle}`
        ))
  );
  lines.push("", "### Weak-Provenance Merges", "");
  lines.push(
    ...(report.qualitySignals.weakProvenanceMerges.length === 0
      ? ["- none"]
      : report.qualitySignals.weakProvenanceMerges.slice(0, 15).map(
          (item) => `- ${item.memberNodeCount} members / ${item.sourceDocumentCount} documents · ${item.title} (\`${item.nodeId}\`)`
        ))
  );
  return `${lines.join("\n")}\n`;
}

export function buildRealRunDiagnosticsReport(
  paths: ProjectPaths,
  inputs: RealRunDiagnosticsInputs,
  inputPaths: Record<string, string | null> = {}
): RealRunDiagnosticsReport {
  const batches = buildThoughtCompilerBatches(inputs.corpus, {
    documentFrames: inputs.documentFrames
  });
  const primarySegments = inputs.corpus.segments.filter((segment) => segment.signalKind === "primary");
  const primarySegmentsBySourceKind = sourceCountRecord();
  const longPrimarySegmentsBySourceKind = sourceCountRecord();
  const longPrimarySegments = [];
  for (const segment of primarySegments) {
    primarySegmentsBySourceKind[segment.sourceKind] += 1;
    if (segment.text.length < LONG_SEGMENT_CHARACTER_THRESHOLD) continue;
    longPrimarySegments.push(segment);
    longPrimarySegmentsBySourceKind[segment.sourceKind] += 1;
  }

  const graphMetrics = graphShape(inputs.consolidatedGraph);
  const anchoredInputIds = new Set(inputs.claims.map((claim) => claim.inputId));
  const coverageBySourceKind = Object.fromEntries(
    SOURCE_KINDS.map((kind) => {
      const sourceSegments = primarySegments.filter((segment) => segment.sourceKind === kind);
      const anchoredCount = sourceSegments.filter((segment) => anchoredInputIds.has(segment.id)).length;
      return [kind, {
        anchoredCount,
        totalCount: sourceSegments.length,
        coverageShare: sourceSegments.length === 0 ? 1 : anchoredCount / sourceSegments.length
      }];
    })
  ) as RealRunDiagnosticsReport["provenance"]["coverageBySourceKind"];
  const anchoredPrimarySegmentCount = primarySegments.filter((segment) => anchoredInputIds.has(segment.id)).length;
  const claimCountByNodeId = new Map<string, number>();
  const stateCountByNodeId = new Map<string, number>();
  for (const claim of inputs.claims) claimCountByNodeId.set(claim.nodeId, (claimCountByNodeId.get(claim.nodeId) ?? 0) + 1);
  for (const state of inputs.nodeStates) stateCountByNodeId.set(state.nodeId, (stateCountByNodeId.get(state.nodeId) ?? 0) + 1);
  const granularById = new Map(inputs.thoughtGraph.nodes.map((node) => [node.id, node]));
  const allConversationOnlyOneOffs = inputs.consolidatedGraph.nodes
    .filter((node) =>
      (node.signalBySourceKind.conversation ?? 0) > 0 &&
      (node.signalBySourceKind.writing ?? 0) === 0 &&
      (node.signalBySourceKind.chat ?? 0) === 0 &&
      node.memberNodeIds.length === 1 &&
      new Set(node.sourceRefs.map((ref) => ref.documentId)).size === 1
    )
    .map((node) => ({
      nodeId: node.id,
      title: node.title,
      sourceDocumentId: node.sourceRefs[0]?.documentId ?? null
    }));
  const allWeakProvenanceMerges = inputs.consolidatedGraph.nodes
    .filter((node) => node.memberNodeIds.length > 1)
    .map((node) => ({
      nodeId: node.id,
      title: node.title,
      memberNodeCount: node.memberNodeIds.length,
      sourceDocumentCount: new Set(node.sourceRefs.map((ref) => ref.documentId)).size,
      sourceAnchorCount: new Set(node.sourceRefs.map(sourceRefIdentity)).size
    }))
    .filter((item) => item.sourceAnchorCount <= 1)
    .sort((left, right) => right.memberNodeCount - left.memberNodeCount);
  const statesByNodeId = new Map<string, ThoughtNodeState[]>();
  for (const state of inputs.nodeStates) {
    const bucket = statesByNodeId.get(state.nodeId) ?? [];
    bucket.push(state);
    statesByNodeId.set(state.nodeId, bucket);
  }
  const allStateProliferation = inputs.thoughtGraph.nodes
    .map((node) => ({
      nodeId: node.id,
      title: node.title,
      claimCount: claimCountByNodeId.get(node.id) ?? 0,
      stateCount: stateCountByNodeId.get(node.id) ?? 0,
      states: (statesByNodeId.get(node.id) ?? [])
        .slice()
        .sort((left, right) => left.stateIndex - right.stateIndex)
    }))
    .filter((item) => {
      if (item.claimCount < 2 || item.stateCount < 2 || item.stateCount < item.claimCount) {
        return false;
      }
      return item.states.some((state, index) => {
        const next = item.states[index + 1];
        return next ? jaccard(titleTokens(state.summary), titleTokens(next.summary)) >= 0.75 : false;
      });
    })
    .map(({ states: _states, ...item }) => item)
    .sort((left, right) => right.stateCount - left.stateCount);
  const genericHubDegreeThreshold = Math.max(12, Math.ceil(inputs.consolidatedGraph.nodes.length * 0.02));
  const allGenericHubs = graphMetrics.degrees
    .filter((item) => {
      const tokens = titleTokens(item.title);
      return (
        item.degree >= genericHubDegreeThreshold &&
        tokens.size > 0 &&
        tokens.size <= 3 &&
        Array.from(tokens).every((token) => GENERIC_TITLE_TOKENS.has(token))
      );
    })
    .sort((left, right) => right.degree - left.degree);
  const allNearDuplicateTitles = findNearDuplicateTitles(inputs.consolidatedGraph.nodes);
  const frameErrors = inputs.frameAuditSummary?.documentsWithErrors ?? null;
  const frameWarnings = inputs.frameAuditSummary?.documentsWithWarningsOnly ?? null;
  const suspiciousConversationTurns =
    inputs.conversationTurnAuditSummary?.suspiciousRemainingTurnCount ?? null;
  const exportFiles = inputs.gptExportManifest?.files ?? [];
  const exportTarget = inputs.gptExportManifest?.uploadBudget?.targetMaxBytesPerFile ?? null;
  const filesOverTarget =
    exportTarget === null
      ? []
      : exportFiles
          .filter((file) => (file.bytes ?? 0) > exportTarget)
          .map((file) => file.filename ?? "unknown");
  const attentionReasons: string[] = [];
  if ((frameErrors ?? 0) > 0) attentionReasons.push(`${frameErrors} source-local documents have frame audit errors.`);
  if ((suspiciousConversationTurns ?? 0) > 0) attentionReasons.push(`${suspiciousConversationTurns} suspicious conversation turns remain.`);
  if ((inputs.affectedScope?.fallbackMode ?? "none") !== "none") attentionReasons.push(`Consolidation fallback mode is ${inputs.affectedScope?.fallbackMode}.`);
  if (inputs.consolidationDiagnostics?.recommendation?.broaderConsolidationRerunRecommended) attentionReasons.push("A broader consolidation-only rerun is recommended.");
  if (primarySegments.length > 0 && anchoredPrimarySegmentCount / primarySegments.length < 0.9) attentionReasons.push(`Source-anchor coverage is ${((anchoredPrimarySegmentCount / primarySegments.length) * 100).toFixed(1)}%.`);
  if ((frameWarnings ?? 0) > 0) attentionReasons.push(`${frameWarnings} source-local documents have frame audit warnings.`);
  if (filesOverTarget.length > 0) attentionReasons.push(`${filesOverTarget.length} GPT export files exceed the target byte budget.`);
  const attentionLevel: RealRunDiagnosticsReport["attention"]["level"] =
    (frameErrors ?? 0) > 0 || (suspiciousConversationTurns ?? 0) > 0
      ? "error"
      : attentionReasons.length > 0
        ? "watch"
        : "none";

  const compileItems = inputs.compileManifest?.incremental?.semanticItems;
  const report: RealRunDiagnosticsReport = {
    generatedAt: new Date().toISOString(),
    inputs: inputPaths,
    corpus: {
      documentCount: inputs.corpus.stats.documentCount,
      segmentCount: inputs.corpus.stats.segmentCount,
      primarySegmentCount: inputs.corpus.stats.primarySegmentCount,
      contextSegmentCount: inputs.corpus.stats.contextSegmentCount,
      documentsBySourceKind: inputs.corpus.stats.documentsBySourceKind,
      segmentsBySourceKind: inputs.corpus.stats.segmentsBySourceKind,
      primarySegmentsBySourceKind,
      longPrimarySegmentCount: longPrimarySegments.length,
      longPrimarySegmentsBySourceKind,
      longPrimarySegmentIdsSample: longPrimarySegments.slice(0, MAX_DIAGNOSTIC_SAMPLES).map((segment) => segment.id)
    },
    batching: {
      estimatedBatchCount: batches.length,
      estimatedInputTokens: batches.reduce((sum, batch) => sum + batch.estimatedInputTokens, 0),
      largestEstimatedBatchTokens: Math.max(0, ...batches.map((batch) => batch.estimatedInputTokens)),
      singletonBatchCount: batches.filter((batch) => batch.items.length === 1).length
    },
    compile: {
      status: inputs.compileManifest?.status ?? null,
      mode: inputs.compileManifest?.incremental?.mode ?? null,
      reusePolicy: inputs.compileManifest?.incremental?.reusePolicy ?? null,
      totalSemanticItems: compileItems?.totalPrimarySegmentCount ?? null,
      reusedSemanticItems: compileItems?.reusedCount ?? inputs.compileManifest?.reusedSemanticItemCount ?? null,
      newSemanticItems: compileItems?.newCount ?? inputs.compileManifest?.pendingSemanticItemCount ?? null,
      reusedCurrentContractItems: compileItems?.reusedCurrentContractCount ?? null,
      reusedPriorContractItems: compileItems?.reusedPriorContractCount ?? null
    },
    consolidation: {
      mode: inputs.consolidationDiagnostics?.mode ?? inputs.affectedScope?.mode ?? null,
      reviewCandidateCount: inputs.consolidationDiagnostics?.reuse?.reviewCandidateCount ?? null,
      reusedReviewDecisionCount: inputs.consolidationDiagnostics?.reuse?.reusedReviewDecisionCount ?? null,
      generatedReviewDecisionCount: inputs.consolidationDiagnostics?.reuse?.generatedReviewDecisionCount ?? null,
      synthesisClusterCount: inputs.consolidationDiagnostics?.reuse?.synthesisClusterCount ?? null,
      reusedSynthesisCount: inputs.consolidationDiagnostics?.reuse?.reusedSynthesisCount ?? null,
      generatedSynthesisCount: inputs.consolidationDiagnostics?.reuse?.generatedSynthesisCount ?? null,
      fallbackMode: inputs.affectedScope?.fallbackMode ?? null,
      fallbackReasons: inputs.affectedScope?.fallbackReasons ?? [],
      broaderPathUsed: inputs.consolidationDiagnostics?.recommendation?.broaderPathUsed ?? null,
      broaderRerunRecommended: inputs.consolidationDiagnostics?.recommendation?.broaderConsolidationRerunRecommended ?? null,
      recommendationReasons: inputs.consolidationDiagnostics?.recommendation?.reasons ?? [],
      affectedScopeStats: inputs.affectedScope?.stats ?? {}
    },
    graph: {
      granular: {
        nodeCount: inputs.thoughtGraph.nodeCount,
        edgeCount: inputs.thoughtGraph.edgeCount,
        claimCount: inputs.claims.length,
        stateCount: inputs.nodeStates.length
      },
      consolidated: {
        nodeCount: inputs.consolidatedGraph.nodeCount,
        edgeCount: inputs.consolidatedGraph.edgeCount,
        sourceMix: sourceMix(inputs.consolidatedGraph.nodes),
        isolatedNodeCount: graphMetrics.isolatedNodeCount,
        componentCount: graphMetrics.componentCount,
        largestComponentSize: graphMetrics.largestComponentSize,
        largestComponents: graphMetrics.largestComponents,
        largestHubs: graphMetrics.largestHubs
      }
    },
    provenance: {
      anchoredPrimarySegmentCount,
      primarySegmentCount: primarySegments.length,
      coverageShare: primarySegments.length === 0 ? 1 : anchoredPrimarySegmentCount / primarySegments.length,
      coverageBySourceKind,
      unanchoredPrimarySegmentIdsSample: primarySegments
        .filter((segment) => !anchoredInputIds.has(segment.id))
        .slice(0, MAX_DIAGNOSTIC_SAMPLES)
        .map((segment) => segment.id)
    },
    qualitySignals: {
      counts: {
        nearDuplicateTitlePairs: allNearDuplicateTitles.length,
        conversationOnlyOneOffs: allConversationOnlyOneOffs.length,
        weakProvenanceMerges: allWeakProvenanceMerges.length,
        stateProliferation: allStateProliferation.length,
        genericHubs: allGenericHubs.length
      },
      nearDuplicateTitles: allNearDuplicateTitles.slice(0, MAX_DIAGNOSTIC_SAMPLES),
      conversationOnlyOneOffs: allConversationOnlyOneOffs.slice(0, MAX_DIAGNOSTIC_SAMPLES),
      weakProvenanceMerges: allWeakProvenanceMerges.slice(0, MAX_DIAGNOSTIC_SAMPLES),
      stateProliferation: allStateProliferation.slice(0, MAX_DIAGNOSTIC_SAMPLES),
      genericHubs: allGenericHubs.slice(0, MAX_DIAGNOSTIC_SAMPLES)
    },
    auditGates: { frameErrors, frameWarnings, suspiciousConversationTurns },
    gptExport: {
      available: inputs.gptExportManifest !== null,
      markdownFileCount: inputs.gptExportManifest?.markdownFileCount ?? null,
      totalBytes: inputs.gptExportManifest?.totalBytes ?? null,
      largestFileBytes:
        exportFiles.length === 0 ? null : Math.max(...exportFiles.map((file) => file.bytes ?? 0)),
      filesOverTarget,
      maxMarkdownFiles: inputs.gptExportManifest?.uploadBudget?.maxMarkdownFiles ?? null,
      targetMaxBytesPerFile: exportTarget,
      hardMaxBytesPerFile:
        inputs.gptExportManifest?.uploadBudget?.hardMaxBytesPerFile ?? null
    },
    attention: { level: attentionLevel, reasons: attentionReasons },
    outputs: {
      jsonPath: path.join(paths.stateAuditsDir, "real-run-diagnostics.json"),
      markdownPath: path.join(paths.stateAuditsDir, "real-run-diagnostics.md")
    }
  };

  // Keep one lightweight evidence pointer for each consolidated member id so
  // malformed snapshots with missing granular members are visible in JSON.
  const missingMembers = inputs.consolidatedGraph.nodes.flatMap((node) =>
    node.memberNodeIds.filter((memberId) => !granularById.has(memberId))
  );
  if (missingMembers.length > 0) {
    report.attention.level = "error";
    report.attention.reasons.push(`${missingMembers.length} consolidated member ids are missing from the granular graph.`);
  }
  return report;
}

export function runRealRunDiagnostics(paths: ProjectPaths): RealRunDiagnosticsReport {
  // Refresh fixed-name gates first so this aggregate never reports stale audit
  // state from a different corpus or graph.
  const frameAudit = runDocumentFrameAudit(paths);
  const conversationTurnAudit = runConversationTurnAudit(paths);
  const inputPaths = {
    corpus: path.join(paths.normalizedUnifiedDir, "corpus.json"),
    documentFrames: path.join(paths.compiledDir, SECOND_BRAIN_DEFAULTS.thoughtCompiler.compiledDocumentFramesFilename),
    thoughtGraph: path.join(paths.compiledDir, SECOND_BRAIN_DEFAULTS.thoughtCompiler.compiledGraphFilename),
    consolidatedGraph: path.join(paths.compiledDir, SECOND_BRAIN_DEFAULTS.thoughtConsolidation.compiledGraphFilename),
    claims: path.join(paths.compiledDir, SECOND_BRAIN_DEFAULTS.thoughtCompiler.compiledClaimsFilename),
    nodeStates: path.join(paths.compiledDir, SECOND_BRAIN_DEFAULTS.thoughtCompiler.compiledNodeStatesFilename),
    compileManifest: path.join(paths.manifestsDir, "compile_manifest.json"),
    consolidationDiagnostics: path.join(paths.stateAuditsDir, "consolidation_diagnostics.json"),
    affectedScope: path.join(paths.stateDir, "consolidation", "affected_scope.json"),
    frameAudit: path.join(paths.stateAuditsDir, "document-frame-audit.json"),
    conversationTurnAudit: path.join(paths.stateAuditsDir, "conversation-turn-audit.json"),
    gptExportManifest: path.join(paths.exportsGptDir, "export-manifest.json")
  };
  const inputs: RealRunDiagnosticsInputs = {
    corpus: readJson<UnifiedCorpus>(inputPaths.corpus)!,
    documentFrames: readJson<ThoughtDocumentFrameArtifact>(inputPaths.documentFrames, false),
    thoughtGraph: readJson<ThoughtGraph>(inputPaths.thoughtGraph)!,
    consolidatedGraph: readJson<ConsolidatedThoughtGraph>(inputPaths.consolidatedGraph)!,
    claims: readJson<ThoughtClaim[]>(inputPaths.claims)!,
    nodeStates: readJson<ThoughtNodeState[]>(inputPaths.nodeStates)!,
    compileManifest: readJson<CompileManifest>(inputPaths.compileManifest, false),
    consolidationDiagnostics: readJson<ConsolidationDiagnostics>(inputPaths.consolidationDiagnostics, false),
    affectedScope: readJson<AffectedScope>(inputPaths.affectedScope, false),
    frameAuditSummary: frameAudit.summary,
    conversationTurnAuditSummary: conversationTurnAudit.summary,
    gptExportManifest: readJson<GptExportManifest>(inputPaths.gptExportManifest, false)
  };
  const report = buildRealRunDiagnosticsReport(paths, inputs, inputPaths);
  mkdirSync(paths.stateAuditsDir, { recursive: true });
  writeFileSync(report.outputs.jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(report.outputs.markdownPath, renderMarkdown(report), "utf8");
  return report;
}
