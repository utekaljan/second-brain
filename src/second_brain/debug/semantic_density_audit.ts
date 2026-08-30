import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import type { ThoughtClaim } from "../compiler/types.js";
import type { ProjectPaths } from "../system/paths.js";
import type { UnifiedCorpus, UnifiedSegment } from "../types/domain.js";
import { slugify } from "../utils/text.js";

const MIN_WRITING_ITEMS_FOR_DENSITY_CHECK = 3;
const MIN_AUTHORED_WRITING_AVG_CANDIDATES = 1.5;
const MIN_AUTHORED_WRITING_CHARS_FOR_DENSITY_CHECK = 220;
const MIN_LONG_CONVERSATION_ITEMS_FOR_DENSITY_CHECK = 4;
const MIN_LONG_CONVERSATION_AVG_CANDIDATES = 1.5;
const MIN_LONG_CONVERSATION_CHARS_FOR_DENSITY_CHECK = 320;
const MIN_VERY_LONG_CONVERSATION_ITEMS_FOR_DENSITY_CHECK = 4;
const MIN_VERY_LONG_CONVERSATION_AVG_CANDIDATES = 2;
const MIN_VERY_LONG_CONVERSATION_CHARS_FOR_DENSITY_CHECK = 700;

export type SemanticDensityBatchAudit = {
  batchId: string;
  startIndex: number;
  endIndex: number;
  authoredWritingItemCount: number;
  authoredWritingCandidateCount: number;
  authoredWritingAverageCandidates: number | null;
  longConversationItemCount: number;
  longConversationCandidateCount: number;
  longConversationAverageCandidates: number | null;
  veryLongConversationItemCount: number;
  veryLongConversationCandidateCount: number;
  veryLongConversationAverageCandidates: number | null;
  conversationBelowTarget: boolean;
  veryLongConversationBelowTarget: boolean;
  passing: boolean;
  sparseInputIds: string[];
  sparseConversationInputIds: string[];
};

export type SemanticDensityAuditReport = {
  generatedAt: string;
  label: string;
  corpusPath: string;
  claimsPath: string;
  batchSize: number;
  thresholds: {
    minWritingItemsForDensityCheck: number;
    minAuthoredWritingAverageCandidates: number;
    minAuthoredWritingCharsForDensityCheck: number;
    minLongConversationItemsForDensityCheck: number;
    minLongConversationAverageCandidates: number;
    minLongConversationCharsForDensityCheck: number;
    minVeryLongConversationItemsForDensityCheck: number;
    minVeryLongConversationAverageCandidates: number;
    minVeryLongConversationCharsForDensityCheck: number;
  };
  summary: {
    checkedBatchCount: number;
    failingBatchCount: number;
    conversationWatchBatchCount: number;
    veryLongConversationWatchBatchCount: number;
    passing: boolean;
    authoredWritingItemCount: number;
    authoredWritingCandidateCount: number;
    authoredWritingAverageCandidates: number | null;
    longConversationItemCount: number;
    longConversationCandidateCount: number;
    longConversationAverageCandidates: number | null;
    veryLongConversationItemCount: number;
    veryLongConversationCandidateCount: number;
    veryLongConversationAverageCandidates: number | null;
  };
  batches: SemanticDensityBatchAudit[];
  outputs: {
    jsonPath: string;
    markdownPath: string;
  };
};

function readJson<T>(target: string): T {
  if (!existsSync(target)) {
    throw new Error(`Missing semantic density audit input: ${target}`);
  }

  return JSON.parse(readFileSync(target, "utf8")) as T;
}

function writeMarkdown(report: SemanticDensityAuditReport): string {
  const lines = [
    "# Semantic Density Audit",
    "",
    `- label: \`${report.label}\``,
    `- corpus: \`${report.corpusPath}\``,
    `- claims: \`${report.claimsPath}\``,
    `- batch size: ${report.batchSize}`,
    `- passing: ${report.summary.passing}`,
    `- checked batches: ${report.summary.checkedBatchCount}`,
    `- failing batches: ${report.summary.failingBatchCount}`,
    `- long-conversation watch batches: ${report.summary.conversationWatchBatchCount}`,
    `- very-long-conversation watch batches: ${report.summary.veryLongConversationWatchBatchCount}`,
    `- authored writing average candidates: ${report.summary.authoredWritingAverageCandidates?.toFixed(2) ?? "n/a"}`,
    `- long conversation average candidates: ${report.summary.longConversationAverageCandidates?.toFixed(2) ?? "n/a"}`,
    `- very long conversation average candidates: ${report.summary.veryLongConversationAverageCandidates?.toFixed(2) ?? "n/a"}`,
    "",
    "## Failing Batches",
    ""
  ];

  const failing = report.batches.filter((batch) => !batch.passing);
  if (failing.length === 0) {
    lines.push("- none");
  } else {
    for (const batch of failing) {
      lines.push(
        `- ${batch.batchId}: writing avg ${batch.authoredWritingAverageCandidates?.toFixed(2) ?? "n/a"} across ${batch.authoredWritingItemCount}; long-conversation avg ${batch.longConversationAverageCandidates?.toFixed(2) ?? "n/a"} across ${batch.longConversationItemCount}; very-long avg ${batch.veryLongConversationAverageCandidates?.toFixed(2) ?? "n/a"} across ${batch.veryLongConversationItemCount}; sparse inputs: ${[...batch.sparseInputIds, ...batch.sparseConversationInputIds].join(", ")}`
      );
    }
  }

  lines.push("", "## Conversation Density Watch", "");
  const watched = report.batches.filter(
    (batch) => batch.conversationBelowTarget || batch.veryLongConversationBelowTarget
  );
  if (watched.length === 0) {
    lines.push("- none");
  } else {
    for (const batch of watched) {
      lines.push(
        `- ${batch.batchId}: long-conversation avg ${batch.longConversationAverageCandidates?.toFixed(2) ?? "n/a"} across ${batch.longConversationItemCount}; very-long avg ${batch.veryLongConversationAverageCandidates?.toFixed(2) ?? "n/a"} across ${batch.veryLongConversationItemCount}; sparse inputs: ${batch.sparseConversationInputIds.join(", ")}`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function runSemanticDensityAudit(
  paths: ProjectPaths,
  options?: {
    label?: string;
    corpusPath?: string;
    claimsPath?: string;
    batchSize?: number;
  }
): SemanticDensityAuditReport {
  const label = options?.label ?? "current";
  const corpusPath = path.resolve(
    paths.root,
    options?.corpusPath ?? path.join(paths.normalizedUnifiedDir, "corpus.json")
  );
  const claimsPath = path.resolve(
    paths.root,
    options?.claimsPath ??
      path.join(paths.compiledDir, SECOND_BRAIN_DEFAULTS.thoughtCompiler.compiledClaimsFilename)
  );
  const batchSize = options?.batchSize ?? SECOND_BRAIN_DEFAULTS.thoughtCompiler.batchSize;
  const corpus = readJson<UnifiedCorpus>(corpusPath);
  const claims = readJson<ThoughtClaim[]>(claimsPath);
  const segmentById = new Map(corpus.segments.map((segment) => [segment.id, segment]));
  const claimCountByInputId = new Map<string, number>();
  for (const claim of claims) {
    claimCountByInputId.set(claim.inputId, (claimCountByInputId.get(claim.inputId) ?? 0) + 1);
  }

  const batches: SemanticDensityBatchAudit[] = [];
  let totalWritingItems = 0;
  let totalWritingCandidates = 0;
  let totalLongConversationItems = 0;
  let totalLongConversationCandidates = 0;
  let totalVeryLongConversationItems = 0;
  let totalVeryLongConversationCandidates = 0;
  for (let index = 0; index < corpus.primaryTimeline.length; index += batchSize) {
    const entries = corpus.primaryTimeline.slice(index, index + batchSize);
    const writingSegments: UnifiedSegment[] = [];
    const longConversationSegments: UnifiedSegment[] = [];
    for (const entry of entries) {
      const segment = segmentById.get(entry.segmentId);
      if (
        segment &&
        segment.sourceKind === "writing" &&
        segment.text.trim().length >= MIN_AUTHORED_WRITING_CHARS_FOR_DENSITY_CHECK
      ) {
        writingSegments.push(segment);
      }
      if (
        segment &&
        segment.sourceKind === "conversation" &&
        segment.text.trim().length >= MIN_LONG_CONVERSATION_CHARS_FOR_DENSITY_CHECK
      ) {
        longConversationSegments.push(segment);
      }
    }
    const checksWriting = writingSegments.length >= MIN_WRITING_ITEMS_FOR_DENSITY_CHECK;
    const checksConversation =
      longConversationSegments.length >= MIN_LONG_CONVERSATION_ITEMS_FOR_DENSITY_CHECK;
    const veryLongConversationSegments = longConversationSegments.filter(
      (segment) =>
        segment.text.trim().length >= MIN_VERY_LONG_CONVERSATION_CHARS_FOR_DENSITY_CHECK
    );
    const checksVeryLongConversation =
      veryLongConversationSegments.length >=
      MIN_VERY_LONG_CONVERSATION_ITEMS_FOR_DENSITY_CHECK;
    if (!checksWriting && !checksConversation && !checksVeryLongConversation) {
      continue;
    }

    const writingCandidateCount = writingSegments.reduce(
      (total, segment) => total + (claimCountByInputId.get(segment.id) ?? 0),
      0
    );
    const writingAverage = checksWriting
      ? writingCandidateCount / writingSegments.length
      : null;
    const conversationCandidateCount = longConversationSegments.reduce(
      (total, segment) => total + (claimCountByInputId.get(segment.id) ?? 0),
      0
    );
    const conversationAverage = checksConversation
      ? conversationCandidateCount / longConversationSegments.length
      : null;
    const veryLongConversationCandidateCount = veryLongConversationSegments.reduce(
      (total, segment) => total + (claimCountByInputId.get(segment.id) ?? 0),
      0
    );
    const veryLongConversationAverage = checksVeryLongConversation
      ? veryLongConversationCandidateCount / veryLongConversationSegments.length
      : null;
    const conversationBelowTarget =
      checksConversation && conversationAverage! < MIN_LONG_CONVERSATION_AVG_CANDIDATES;
    const veryLongConversationBelowTarget =
      checksVeryLongConversation &&
      veryLongConversationAverage! < MIN_VERY_LONG_CONVERSATION_AVG_CANDIDATES;
    const sparseInputIds = writingSegments
      .filter((segment) => (claimCountByInputId.get(segment.id) ?? 0) <= 1)
      .map((segment) => segment.id)
      .slice(0, 8);
    const sparseConversationInputIds = longConversationSegments
      .filter((segment) => (claimCountByInputId.get(segment.id) ?? 0) <= 1)
      .map((segment) => segment.id)
      .slice(0, 8);

    if (checksWriting) {
      totalWritingItems += writingSegments.length;
      totalWritingCandidates += writingCandidateCount;
    }
    if (checksConversation) {
      totalLongConversationItems += longConversationSegments.length;
      totalLongConversationCandidates += conversationCandidateCount;
    }
    if (checksVeryLongConversation) {
      totalVeryLongConversationItems += veryLongConversationSegments.length;
      totalVeryLongConversationCandidates += veryLongConversationCandidateCount;
    }
    batches.push({
      batchId: `batch-${String(Math.floor(index / batchSize) + 1).padStart(4, "0")}`,
      startIndex: index,
      endIndex: index + entries.length - 1,
      authoredWritingItemCount: writingSegments.length,
      authoredWritingCandidateCount: writingCandidateCount,
      authoredWritingAverageCandidates: writingAverage,
      longConversationItemCount: longConversationSegments.length,
      longConversationCandidateCount: conversationCandidateCount,
      longConversationAverageCandidates: conversationAverage,
      veryLongConversationItemCount: veryLongConversationSegments.length,
      veryLongConversationCandidateCount,
      veryLongConversationAverageCandidates: veryLongConversationAverage,
      conversationBelowTarget,
      veryLongConversationBelowTarget,
      // Conversation length does not prove how many durable thoughts a turn
      // contains. Keep these metrics inspectable, but do not fail a completed
      // master run or trigger another LLM call solely from their averages.
      passing: !checksWriting || writingAverage! >= MIN_AUTHORED_WRITING_AVG_CANDIDATES,
      sparseInputIds,
      sparseConversationInputIds
    });
  }

  const failingBatchCount = batches.filter((batch) => !batch.passing).length;
  const conversationWatchBatchCount = batches.filter(
    (batch) => batch.conversationBelowTarget
  ).length;
  const veryLongConversationWatchBatchCount = batches.filter(
    (batch) => batch.veryLongConversationBelowTarget
  ).length;
  const outputBase = `semantic_density_${slugify(label)}_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const jsonPath = path.join(paths.stateAuditsDir, `${outputBase}.json`);
  const markdownPath = path.join(paths.stateAuditsDir, `${outputBase}.md`);
  const report: SemanticDensityAuditReport = {
    generatedAt: new Date().toISOString(),
    label,
    corpusPath,
    claimsPath,
    batchSize,
    thresholds: {
      minWritingItemsForDensityCheck: MIN_WRITING_ITEMS_FOR_DENSITY_CHECK,
      minAuthoredWritingAverageCandidates: MIN_AUTHORED_WRITING_AVG_CANDIDATES,
      minAuthoredWritingCharsForDensityCheck: MIN_AUTHORED_WRITING_CHARS_FOR_DENSITY_CHECK,
      minLongConversationItemsForDensityCheck: MIN_LONG_CONVERSATION_ITEMS_FOR_DENSITY_CHECK,
      minLongConversationAverageCandidates: MIN_LONG_CONVERSATION_AVG_CANDIDATES,
      minLongConversationCharsForDensityCheck: MIN_LONG_CONVERSATION_CHARS_FOR_DENSITY_CHECK,
      minVeryLongConversationItemsForDensityCheck:
        MIN_VERY_LONG_CONVERSATION_ITEMS_FOR_DENSITY_CHECK,
      minVeryLongConversationAverageCandidates:
        MIN_VERY_LONG_CONVERSATION_AVG_CANDIDATES,
      minVeryLongConversationCharsForDensityCheck:
        MIN_VERY_LONG_CONVERSATION_CHARS_FOR_DENSITY_CHECK
    },
    summary: {
      checkedBatchCount: batches.length,
      failingBatchCount,
      conversationWatchBatchCount,
      veryLongConversationWatchBatchCount,
      passing: failingBatchCount === 0,
      authoredWritingItemCount: totalWritingItems,
      authoredWritingCandidateCount: totalWritingCandidates,
      authoredWritingAverageCandidates:
        totalWritingItems === 0 ? null : totalWritingCandidates / totalWritingItems,
      longConversationItemCount: totalLongConversationItems,
      longConversationCandidateCount: totalLongConversationCandidates,
      longConversationAverageCandidates:
        totalLongConversationItems === 0
          ? null
          : totalLongConversationCandidates / totalLongConversationItems,
      veryLongConversationItemCount: totalVeryLongConversationItems,
      veryLongConversationCandidateCount: totalVeryLongConversationCandidates,
      veryLongConversationAverageCandidates:
        totalVeryLongConversationItems === 0
          ? null
          : totalVeryLongConversationCandidates / totalVeryLongConversationItems
    },
    batches,
    outputs: {
      jsonPath,
      markdownPath
    }
  };

  mkdirSync(paths.stateAuditsDir, { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, writeMarkdown(report), "utf8");

  return report;
}
