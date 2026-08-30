import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ProjectPaths } from "../../system/paths.js";
import type { ConversationRecord } from "../../types/domain.js";
import { ThrottledProgressReporter, type ProgressWriter } from "../../utils/progress.js";
import {
  classifyWorkConversation,
  decideConversationInclusion,
  parseOpenAIConversation,
  readOpenAIConversationBundle,
  type NormalizeConversationsOptions
} from "./openai.js";

type ExcludedWorkConversation = {
  id: string;
  conversationId: string;
  title: string;
  sourcePath: string;
  bundleName: string;
  userTurnCount: number;
  turnCount: number;
  score: number;
  matchedBucketCount: number;
  totalKeywordHits: number;
  titleKeywordHits: number;
  matchedBuckets: Array<{
    bucket: "system" | "implementation" | "intent";
    hitCount: number;
    matches: Array<{
      keyword: string;
      count: number;
    }>;
  }>;
  preview: string;
};

export type ConversationNormalizationReport = {
  generatedAt: string;
  sourceBundleCount: number;
  keptConversationCount: number;
  exclusionCounts: Record<string, number>;
  excludedWorkConversations: ExcludedWorkConversation[];
};

export type NormalizeConversationsResult = {
  records: ConversationRecord[];
  report: ConversationNormalizationReport;
};

function collectConversationBundlePaths(baseDir: string): string[] {
  try {
    // The export now arrives in multiple ~15 MB bundles, so the collector reads
    // all JSON files in the conversations input directory.
    const entries = readdirSync(baseDir, { withFileTypes: true });
    const paths: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);

      if (entry.isDirectory()) {
        paths.push(...collectConversationBundlePaths(fullPath));
        continue;
      }

      if (!entry.isFile() || entry.name === ".gitkeep") {
        continue;
      }

      if (path.extname(entry.name).toLowerCase() === ".json") {
        paths.push(fullPath);
      }
    }

    paths.sort((left, right) => left.localeCompare(right));
    return paths;
  } catch {
    return [];
  }
}

/**
 * Normalize all OpenAI bundle files currently present in input/conversations/.
 */
export function normalizeConversationsWithReport(
  paths: ProjectPaths,
  options: NormalizeConversationsOptions,
  progress?: ProgressWriter
): NormalizeConversationsResult {
  const sourcePaths = collectConversationBundlePaths(paths.conversationsDir);
  const reporter = new ThrottledProgressReporter(progress, 10);
  reporter.phase("ingest:conversations", `reading ${sourcePaths.length} conversation bundle files`);
  const exclusionCounts: Record<string, number> = {
    excluded_gizmo: 0,
    excluded_null_gizmo_short: 0,
    excluded_null_gizmo_code: 0,
    excluded_work_conversation: 0
  };
  const excludedWorkConversations: ExcludedWorkConversation[] = [];

  const records = sourcePaths.flatMap((sourcePath, index) => {
    const parsed = readOpenAIConversationBundle(sourcePath).flatMap((conversation) => {
      const record = parseOpenAIConversation(sourcePath, conversation, options);
      if (options.enablePrefilter !== false) {
        const inclusion = decideConversationInclusion(conversation, record.turns, record.activeNodeIds);
        if (!inclusion.include) {
          exclusionCounts[inclusion.reason] = (exclusionCounts[inclusion.reason] ?? 0) + 1;
          return [];
        }
      }

      if (options.enableWorkFilter !== false) {
        const classification = classifyWorkConversation(record);
        if (classification.exclude) {
          exclusionCounts.excluded_work_conversation += 1;
          excludedWorkConversations.push({
            id: record.id,
            conversationId: record.conversationId,
            title: record.title,
            sourcePath: record.sourcePath,
            bundleName: record.bundleName,
            userTurnCount: record.userTurnCount,
            turnCount: record.turnCount,
            score: classification.score,
            matchedBucketCount: classification.matchedBucketCount,
            totalKeywordHits: classification.totalKeywordHits,
            titleKeywordHits: classification.titleKeywordHits,
            matchedBuckets: classification.matchedBuckets,
            preview: record.userTurns
              .map((turn) => turn.text)
              .join("\n\n")
              .replace(/\s+/g, " ")
              .slice(0, 400)
              .trim()
          });
          return [];
        }
      }

      return [record];
    });
    reporter.item(
      "ingest:conversations",
      "conversation-bundles",
      index + 1,
      sourcePaths.length,
      `${path.basename(sourcePath)} -> ${parsed.length} conversations`
    );
    return parsed;
  });

  // Chronological ordering is important because later compiler stages should
  // observe how the user's thought develops over time.
  records.sort((left, right) => {
    const leftTime = left.createTimeUnix ?? 0;
    const rightTime = right.createTimeUnix ?? 0;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return left.conversationId.localeCompare(right.conversationId);
  });

  reporter.phase(
    "ingest:conversations",
    options.enablePrefilter === false
      ? `done: ${records.length} normalized conversations from ${sourcePaths.length} bundles; prefilter disabled; filtered ${exclusionCounts.excluded_work_conversation} work conversations`
      : `done: ${records.length} normalized conversations from ${sourcePaths.length} bundles; filtered ${exclusionCounts.excluded_gizmo} gizmo, ${exclusionCounts.excluded_null_gizmo_short} short null-gizmo, ${exclusionCounts.excluded_null_gizmo_code} code null-gizmo threads, ${exclusionCounts.excluded_work_conversation} work conversations`
  );

  return {
    records,
    report: {
      generatedAt: new Date().toISOString(),
      sourceBundleCount: sourcePaths.length,
      keptConversationCount: records.length,
      exclusionCounts,
      excludedWorkConversations
    }
  };
}

export function normalizeConversations(
  paths: ProjectPaths,
  options: NormalizeConversationsOptions,
  progress?: ProgressWriter
): ConversationRecord[] {
  return normalizeConversationsWithReport(paths, options, progress).records;
}

/**
 * Write the normalized conversation bundle into output/normalized/conversations/.
 */
export function writeNormalizedConversations(
  paths: ProjectPaths,
  conversations: ConversationRecord[]
): string {
  const target = path.join(paths.normalizedConversationsDir, "conversations.json");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(conversations, null, 2)}\n`, "utf8");
  return target;
}

/**
 * Build a shallow manifest of raw OpenAI conversation bundle files.
 */
export function buildConversationsManifest(paths: ProjectPaths): Record<string, unknown> {
  const sourceFiles = collectConversationBundlePaths(paths.conversationsDir);
  return {
    sourceDir: paths.conversationsDir,
    fileCount: sourceFiles.length,
    files: sourceFiles.map((sourcePath) => {
      const stats = statSync(sourcePath);
      return {
        path: sourcePath,
        sizeBytes: stats.size
      };
    })
  };
}
