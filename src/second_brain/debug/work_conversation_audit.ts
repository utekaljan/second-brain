import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ConversationNormalizationReport } from "../ingest/conversations/normalize.js";
import type { ProjectPaths } from "../system/paths.js";

export type WorkConversationAuditOutput = {
  jsonPath: string;
  markdownPath: string;
};

function renderMarkdown(report: ConversationNormalizationReport): string {
  const lines: string[] = [
    "# Work Conversation Filter",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Source bundles: ${report.sourceBundleCount}`,
    `- Kept conversations: ${report.keptConversationCount}`,
    `- Excluded work conversations: ${report.excludedWorkConversations.length}`,
    "",
    "## Exclusion Counts",
    "",
    `- gizmo id present: ${report.exclusionCounts.excluded_gizmo ?? 0}`,
    `- null gizmo short: ${report.exclusionCounts.excluded_null_gizmo_short ?? 0}`,
    `- null gizmo code: ${report.exclusionCounts.excluded_null_gizmo_code ?? 0}`,
    `- work conversations: ${report.exclusionCounts.excluded_work_conversation ?? 0}`,
    "",
    "## Excluded Work Conversations",
    ""
  ];

  if (report.excludedWorkConversations.length === 0) {
    lines.push("Žádné.");
  } else {
    for (const item of report.excludedWorkConversations) {
      const bucketSummary = item.matchedBuckets
        .map(
          (bucket) =>
            `${bucket.bucket}=${bucket.hitCount} [${bucket.matches.map((match) => `${match.keyword}:${match.count}`).join(", ")}]`
        )
        .join(" | ");
      lines.push(
        `- ${item.title} (\`${item.conversationId}\`) · score ${item.score} · user turns ${item.userTurnCount} · keyword hits ${item.totalKeywordHits}`
      );
      lines.push(`  Buckets: ${bucketSummary}`);
      lines.push(`  Preview: ${item.preview || "[empty]"}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function writeWorkConversationAudit(
  paths: ProjectPaths,
  report: ConversationNormalizationReport
): WorkConversationAuditOutput {
  const jsonPath = path.join(paths.stateAuditsDir, "work-conversation-filter.json");
  const markdownPath = path.join(paths.stateAuditsDir, "work-conversation-filter.md");
  mkdirSync(paths.stateAuditsDir, { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderMarkdown(report), "utf8");
  return {
    jsonPath,
    markdownPath
  };
}
