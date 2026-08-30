import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildThoughtCompilerBatches } from "../compiler/batching.js";
import type { ThoughtDocumentFrameArtifact } from "../compiler/types.js";
import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import { sanitizeConversationTurnText } from "../ingest/conversations/openai.js";
import type { ProjectPaths } from "../system/paths.js";
import type { ConversationRecord, ConversationTurn, UnifiedCorpus } from "../types/domain.js";

const LONG_USER_TURN_THRESHOLD = 4000;

type AuditedConversationTurn = {
  conversationId: string;
  conversationTitle: string;
  turnId: string;
  length: number;
  action: "keep" | "trim" | "drop";
  reasons: string[];
  preview: string;
};

export type ConversationTurnAuditReport = {
  generatedAt: string;
  inputArtifacts: {
    normalizedConversationsPath: string;
    normalizedUnifiedCorpusPath: string | null;
    documentFramesPath: string | null;
  };
  summary: {
    conversationCount: number;
    totalUserTurnCount: number;
    longUserTurnThreshold: number;
    longUserTurnCount: number;
    suspiciousRemainingTurnCount: number;
    longestRemainingUserTurnLength: number;
    batchCount: number | null;
    singletonBatchCount: number | null;
    conversationSingletonBatchCount: number | null;
    hardPromptTokenBudget: number;
    oversizedBatchCount: number | null;
    maximumEstimatedBatchTokens: number | null;
    passing: boolean;
  };
  suspiciousRemainingTurns: AuditedConversationTurn[];
  longestKeptTurns: AuditedConversationTurn[];
  outputs: {
    jsonPath: string;
    markdownPath: string;
  };
};

function loadJson<T>(target: string): T {
  return JSON.parse(readFileSync(target, "utf8")) as T;
}

function createPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= 220 ? collapsed : `${collapsed.slice(0, 217)}...`;
}

function auditTurn(conversation: ConversationRecord, turn: ConversationTurn): AuditedConversationTurn {
  const sanitization = sanitizeConversationTurnText(turn);
  return {
    conversationId: conversation.conversationId,
    conversationTitle: conversation.title,
    turnId: turn.id,
    length: turn.text.length,
    action: sanitization.action,
    reasons: sanitization.reasons,
    preview: createPreview(turn.text)
  };
}

function renderMarkdown(report: ConversationTurnAuditReport): string {
  const lines: string[] = [
    "# Audit Conversation Turns",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Normalized conversations: \`${report.inputArtifacts.normalizedConversationsPath}\``,
    `- Unified corpus: \`${report.inputArtifacts.normalizedUnifiedCorpusPath ?? "missing"}\``,
    `- Document frames: \`${report.inputArtifacts.documentFramesPath ?? "missing"}\``,
    "",
    "## Pass Criteria",
    "",
    `- no remaining user turn at or above \`${report.summary.longUserTurnThreshold}\` chars should still be classified by the sanitizer as \`trim\` or \`drop\``,
    `- no compile batch may exceed the declared hard prompt budget of \`${report.summary.hardPromptTokenBudget}\` estimated input tokens`,
    "",
    "## Summary",
    "",
    `- Conversations: ${report.summary.conversationCount}`,
    `- User turns: ${report.summary.totalUserTurnCount}`,
    `- Long user turns: ${report.summary.longUserTurnCount}`,
    `- Suspicious remaining turns: ${report.summary.suspiciousRemainingTurnCount}`,
    `- Longest remaining user turn: ${report.summary.longestRemainingUserTurnLength}`,
    `- Compile batch count: ${report.summary.batchCount ?? "n/a"}`,
    `- Singleton batches: ${report.summary.singletonBatchCount ?? "n/a"}`,
    `- Conversation singleton batches: ${report.summary.conversationSingletonBatchCount ?? "n/a"}`,
    `- Oversized batches: ${report.summary.oversizedBatchCount ?? "n/a"}`,
    `- Maximum estimated batch tokens: ${report.summary.maximumEstimatedBatchTokens ?? "n/a"}`,
    `- Verdict: ${report.summary.passing ? "PASS" : "FAIL"}`,
    ""
  ];

  lines.push("## Suspicious Remaining Turns", "");
  if (report.suspiciousRemainingTurns.length === 0) {
    lines.push("Žádné.");
  } else {
    for (const turn of report.suspiciousRemainingTurns) {
      lines.push(
        `- ${turn.conversationTitle} (\`${turn.conversationId}\`) · ${turn.length} chars · action ${turn.action} · ${turn.reasons.join(", ")}`
      );
      lines.push(`  Preview: ${turn.preview}`);
    }
  }

  lines.push("", "## Longest Kept Turns", "");
  for (const turn of report.longestKeptTurns) {
    lines.push(`- ${turn.conversationTitle} (\`${turn.conversationId}\`) · ${turn.length} chars`);
    lines.push(`  Preview: ${turn.preview}`);
  }

  return `${lines.join("\n")}\n`;
}

export function runConversationTurnAudit(paths: ProjectPaths): ConversationTurnAuditReport {
  const normalizedConversationsPath = path.join(paths.normalizedConversationsDir, "conversations.json");
  if (!existsSync(normalizedConversationsPath)) {
    throw new Error(
      `Missing normalized conversations at ${normalizedConversationsPath}. Run normalize-conversations or normalize-all first.`
    );
  }

  const conversations = loadJson<ConversationRecord[]>(normalizedConversationsPath);
  const longUserTurns = conversations.flatMap((conversation) =>
    conversation.userTurns
      .filter((turn) => turn.text.length >= LONG_USER_TURN_THRESHOLD)
      .map((turn) => auditTurn(conversation, turn))
  );
  const suspiciousRemainingTurns = longUserTurns.filter((turn) => turn.action !== "keep");
  const longestKeptTurns = longUserTurns
    .filter((turn) => turn.action === "keep")
    .sort((left, right) => right.length - left.length)
    .slice(0, 20);

  const normalizedUnifiedCorpusPath = path.join(paths.normalizedUnifiedDir, "corpus.json");
  const documentFramesPath = path.join(paths.compiledDir, "thought_document_frames.json");
  let batchCount: number | null = null;
  let singletonBatchCount: number | null = null;
  let conversationSingletonBatchCount: number | null = null;
  let oversizedBatchCount: number | null = null;
  let maximumEstimatedBatchTokens: number | null = null;

  if (existsSync(normalizedUnifiedCorpusPath)) {
    const corpus = loadJson<UnifiedCorpus>(normalizedUnifiedCorpusPath);
    const documentFrames = existsSync(documentFramesPath)
      ? loadJson<ThoughtDocumentFrameArtifact>(documentFramesPath)
      : null;
    const batches = buildThoughtCompilerBatches(corpus, {
      documentFrames
    });
    batchCount = batches.length;
    singletonBatchCount = batches.filter((batch) => batch.items.length === 1).length;
    conversationSingletonBatchCount = batches.filter(
      (batch) => batch.items.length === 1 && batch.items[0]?.sourceKind === "conversation"
    ).length;
    oversizedBatchCount = batches.filter(
      (batch) => batch.estimatedInputTokens > SECOND_BRAIN_DEFAULTS.thoughtCompiler.hardPromptTokenBudget
    ).length;
    maximumEstimatedBatchTokens = batches.reduce(
      (maximum, batch) => Math.max(maximum, batch.estimatedInputTokens),
      0
    );
  }

  const report: ConversationTurnAuditReport = {
    generatedAt: new Date().toISOString(),
    inputArtifacts: {
      normalizedConversationsPath,
      normalizedUnifiedCorpusPath: existsSync(normalizedUnifiedCorpusPath)
        ? normalizedUnifiedCorpusPath
        : null,
      documentFramesPath: existsSync(documentFramesPath) ? documentFramesPath : null
    },
    summary: {
      conversationCount: conversations.length,
      totalUserTurnCount: conversations.reduce((total, conversation) => total + conversation.userTurnCount, 0),
      longUserTurnThreshold: LONG_USER_TURN_THRESHOLD,
      longUserTurnCount: longUserTurns.length,
      suspiciousRemainingTurnCount: suspiciousRemainingTurns.length,
      longestRemainingUserTurnLength: longUserTurns.reduce(
        (longest, turn) => Math.max(longest, turn.length),
        0
      ),
      batchCount,
      singletonBatchCount,
      conversationSingletonBatchCount,
      hardPromptTokenBudget: SECOND_BRAIN_DEFAULTS.thoughtCompiler.hardPromptTokenBudget,
      oversizedBatchCount,
      maximumEstimatedBatchTokens,
      passing: suspiciousRemainingTurns.length === 0 && oversizedBatchCount === 0
    },
    suspiciousRemainingTurns,
    longestKeptTurns,
    outputs: {
      jsonPath: path.join(paths.stateAuditsDir, "conversation-turn-audit.json"),
      markdownPath: path.join(paths.stateAuditsDir, "conversation-turn-audit.md")
    }
  };

  mkdirSync(paths.stateAuditsDir, { recursive: true });
  writeFileSync(report.outputs.jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(report.outputs.markdownPath, renderMarkdown(report), "utf8");
  return report;
}
