import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ProjectPaths } from "../../system/paths.js";
import type {
  ChatRecord,
  ConversationRecord,
  SourceKind,
  UnifiedAuthorKind,
  UnifiedCorpus,
  UnifiedDocument,
  UnifiedSegment,
  UnifiedTimePrecision,
  WritingRecord
} from "../../types/domain.js";
import { ThrottledProgressReporter, type ProgressWriter } from "../../utils/progress.js";

/**
 * Options that shape the final compiler-ready normalization layer.
 *
 * These mirror the source-specific normalization knobs so the unified corpus
 * can record exactly which context policy was active for one run.
 */
export type UnifiedNormalizationOptions = {
  ownerNames: string[];
  includeOtherContext: boolean;
  includeAssistantContext: boolean;
  includeToolContext: boolean;
  contextWindow: number;
};

const SOURCE_PRIORITIES: Record<SourceKind, number> = {
  writing: 100,
  conversation: 80,
  chat: 60
};

function createPreview(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  if (flattened.length <= 180) {
    return flattened;
  }

  return `${flattened.slice(0, 177)}...`;
}

function joinTexts(texts: string[]): string {
  return texts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function normalizeComparableText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function writingTimeFromDate(sourceDate: string | null): string | null {
  if (!sourceDate) {
    return null;
  }

  return `${sourceDate}T00:00:00.000Z`;
}

function resolveTimePrecision(timeUnix: number | null, kind: "writing" | "message"): UnifiedTimePrecision {
  if (timeUnix === null) {
    return "unknown";
  }

  return kind === "writing" ? "day" : "second";
}

function splitWritingParagraphs(writing: WritingRecord): string[] {
  const paragraphs = writing.body
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  if (paragraphs.length <= 1) {
    return paragraphs;
  }

  // Many essays start with a standalone title line that has already been
  // promoted into WritingRecord.title. Dropping that one paragraph avoids
  // duplicate title-only segments while preserving the full body on the document.
  if (normalizeComparableText(paragraphs[0] ?? "") === normalizeComparableText(writing.title)) {
    return paragraphs.slice(1);
  }

  return paragraphs;
}

function buildWritingDocument(writing: WritingRecord): {
  document: UnifiedDocument;
  segments: UnifiedSegment[];
} {
  const time = writingTimeFromDate(writing.sourceDate);
  const timePrecision = resolveTimePrecision(writing.sourceDateUnix, "writing");
  const sourcePriority = SOURCE_PRIORITIES.writing;
  const paragraphs = splitWritingParagraphs(writing);

  const segments: UnifiedSegment[] = paragraphs.map((paragraph, index) => ({
    id: `${writing.id}:paragraph:${index + 1}`,
    documentId: writing.id,
    sourceKind: "writing",
    segmentKind: "writing_paragraph",
    signalKind: "primary",
    authorKind: "self",
    authorLabel: "self",
    sequenceIndex: index + 1,
    time,
    timeUnix: writing.sourceDateUnix,
    timePrecision,
    sourcePriority,
    segmentLabel: `Paragraph ${index + 1}`,
    text: paragraph,
    textPreview: createPreview(paragraph),
    sourceRef: {
      sourceKind: "writing",
      sourcePath: writing.sourcePath,
      documentId: writing.id,
      documentTitle: writing.title,
      locator: `paragraph:${index + 1}`,
      sourceItemId: `paragraph:${index + 1}`
    }
  }));

  return {
    document: {
      id: writing.id,
      sourceKind: "writing",
      sourcePath: writing.sourcePath,
      slug: writing.slug,
      title: writing.title,
      time,
      timeUnix: writing.sourceDateUnix,
      timePrecision,
      sourcePriority,
      primaryText: writing.body.trim(),
      contextText: null,
      primarySegmentCount: segments.length,
      contextSegmentCount: 0,
      metadata: {
        fileLabel: writing.fileLabel,
        lineCount: writing.lineCount,
        wordCount: writing.wordCount
      }
    },
    segments
  };
}

function buildConversationDocument(
  conversation: ConversationRecord,
  options: UnifiedNormalizationOptions
): {
  document: UnifiedDocument;
  segments: UnifiedSegment[];
} {
  const sourcePriority = SOURCE_PRIORITIES.conversation;
  const segments: UnifiedSegment[] = [];
  let sequenceIndex = 1;

  for (const turn of conversation.turns) {
    if (turn.authorRole === "user") {
      segments.push({
        id: `${conversation.id}:turn:${turn.id}`,
        documentId: conversation.id,
        sourceKind: "conversation",
        segmentKind: "conversation_user_turn",
        signalKind: "primary",
        authorKind: "self",
        authorLabel: "self",
        sequenceIndex,
        time: turn.createTime,
        timeUnix: turn.createTimeUnix,
        timePrecision: resolveTimePrecision(turn.createTimeUnix, "message"),
        sourcePriority,
        segmentLabel: `User turn ${sequenceIndex}`,
        text: turn.text,
        textPreview: createPreview(turn.text),
        sourceRef: {
          sourceKind: "conversation",
          sourcePath: conversation.sourcePath,
          documentId: conversation.id,
          documentTitle: conversation.title,
          locator: `turn:${turn.id}`,
          sourceItemId: turn.id,
          conversationId: conversation.conversationId,
          bundleName: conversation.bundleName,
          turnId: turn.id
        }
      });
      sequenceIndex += 1;
      continue;
    }

    if (turn.authorRole === "assistant" && options.includeAssistantContext) {
      segments.push({
        id: `${conversation.id}:turn:${turn.id}`,
        documentId: conversation.id,
        sourceKind: "conversation",
        segmentKind: "conversation_assistant_context",
        signalKind: "context",
        authorKind: "assistant",
        authorLabel: "assistant",
        sequenceIndex,
        time: turn.createTime,
        timeUnix: turn.createTimeUnix,
        timePrecision: resolveTimePrecision(turn.createTimeUnix, "message"),
        sourcePriority,
        segmentLabel: `Assistant context ${sequenceIndex}`,
        text: turn.text,
        textPreview: createPreview(turn.text),
        sourceRef: {
          sourceKind: "conversation",
          sourcePath: conversation.sourcePath,
          documentId: conversation.id,
          documentTitle: conversation.title,
          locator: `turn:${turn.id}`,
          sourceItemId: turn.id,
          conversationId: conversation.conversationId,
          bundleName: conversation.bundleName,
          turnId: turn.id
        }
      });
      sequenceIndex += 1;
      continue;
    }

    if (turn.authorRole === "tool" && options.includeToolContext) {
      segments.push({
        id: `${conversation.id}:turn:${turn.id}`,
        documentId: conversation.id,
        sourceKind: "conversation",
        segmentKind: "conversation_tool_context",
        signalKind: "context",
        authorKind: "tool",
        authorLabel: turn.recipient ?? "tool",
        sequenceIndex,
        time: turn.createTime,
        timeUnix: turn.createTimeUnix,
        timePrecision: resolveTimePrecision(turn.createTimeUnix, "message"),
        sourcePriority,
        segmentLabel: `Tool context ${sequenceIndex}`,
        text: turn.text,
        textPreview: createPreview(turn.text),
        sourceRef: {
          sourceKind: "conversation",
          sourcePath: conversation.sourcePath,
          documentId: conversation.id,
          documentTitle: conversation.title,
          locator: `turn:${turn.id}`,
          sourceItemId: turn.id,
          conversationId: conversation.conversationId,
          bundleName: conversation.bundleName,
          turnId: turn.id
        }
      });
      sequenceIndex += 1;
    }
  }

  const primaryText = joinTexts(
    segments.filter((segment) => segment.signalKind === "primary").map((segment) => segment.text)
  );
  const contextText = joinTexts(
    segments.filter((segment) => segment.signalKind === "context").map((segment) => segment.text)
  );

  return {
    document: {
      id: conversation.id,
      sourceKind: "conversation",
      sourcePath: conversation.sourcePath,
      slug: conversation.id.replace(/^conversation:/, ""),
      title: conversation.title,
      time: conversation.createTime,
      timeUnix: conversation.createTimeUnix,
      timePrecision: resolveTimePrecision(conversation.createTimeUnix, "message"),
      sourcePriority,
      primaryText,
      contextText: contextText || null,
      primarySegmentCount: segments.filter((segment) => segment.signalKind === "primary").length,
      contextSegmentCount: segments.filter((segment) => segment.signalKind === "context").length,
      metadata: {
        conversationId: conversation.conversationId,
        bundleName: conversation.bundleName,
        gizmoId: conversation.gizmoId,
        defaultModelSlug: conversation.defaultModelSlug,
        turnCount: conversation.turnCount
      }
    },
    segments
  };
}

function classifyChatAuthorKind(role: ChatRecord["messages"][number]["role"]): UnifiedAuthorKind {
  if (role === "owner") {
    return "self";
  }
  if (role === "other") {
    return "other_person";
  }
  if (role === "system") {
    return "system";
  }

  return "unknown";
}

function buildChatDocument(chat: ChatRecord, options: UnifiedNormalizationOptions): {
  document: UnifiedDocument;
  segments: UnifiedSegment[];
} {
  const sourcePriority = SOURCE_PRIORITIES.chat;
  const segments: UnifiedSegment[] = [];
  let sequenceIndex = 1;

  for (const message of chat.messages) {
    if (message.role === "owner") {
      segments.push({
        id: `${chat.id}:message:${message.id}`,
        documentId: chat.id,
        sourceKind: "chat",
        segmentKind: "chat_owner_message",
        signalKind: "primary",
        authorKind: "self",
        authorLabel: message.author,
        sequenceIndex,
        time: message.timestamp,
        timeUnix: message.timestampUnix,
        timePrecision: resolveTimePrecision(message.timestampUnix, "message"),
        sourcePriority,
        segmentLabel: `Owner message ${sequenceIndex}`,
        text: message.text,
        textPreview: createPreview(message.text),
        sourceRef: {
          sourceKind: "chat",
          sourcePath: chat.sourcePath,
          documentId: chat.id,
          documentTitle: chat.title,
          locator: `message:${message.id}`,
          sourceItemId: message.id,
          messageId: message.id
        }
      });
      sequenceIndex += 1;
      continue;
    }

    if (message.role === "other" && options.includeOtherContext) {
      segments.push({
        id: `${chat.id}:message:${message.id}`,
        documentId: chat.id,
        sourceKind: "chat",
        segmentKind: "chat_context_message",
        signalKind: "context",
        authorKind: classifyChatAuthorKind(message.role),
        authorLabel: message.author,
        sequenceIndex,
        time: message.timestamp,
        timeUnix: message.timestampUnix,
        timePrecision: resolveTimePrecision(message.timestampUnix, "message"),
        sourcePriority,
        segmentLabel: `Context message ${sequenceIndex}`,
        text: message.text,
        textPreview: createPreview(message.text),
        sourceRef: {
          sourceKind: "chat",
          sourcePath: chat.sourcePath,
          documentId: chat.id,
          documentTitle: chat.title,
          locator: `message:${message.id}`,
          sourceItemId: message.id,
          messageId: message.id
        }
      });
      sequenceIndex += 1;
    }
  }

  const primaryText = joinTexts(
    segments.filter((segment) => segment.signalKind === "primary").map((segment) => segment.text)
  );
  const contextText = joinTexts(
    segments.filter((segment) => segment.signalKind === "context").map((segment) => segment.text)
  );

  return {
    document: {
      id: chat.id,
      sourceKind: "chat",
      sourcePath: chat.sourcePath,
      slug: chat.slug,
      title: chat.title,
      time: chat.startTime,
      timeUnix: chat.startTimeUnix,
      timePrecision: resolveTimePrecision(chat.startTimeUnix, "message"),
      sourcePriority,
      primaryText,
      contextText: contextText || null,
      primarySegmentCount: segments.filter((segment) => segment.signalKind === "primary").length,
      contextSegmentCount: segments.filter((segment) => segment.signalKind === "context").length,
      metadata: {
        ownerNames: chat.ownerNames,
        participantNames: chat.participantNames,
        messageCount: chat.messageCount
      }
    },
    segments
  };
}

function compareDocuments(left: UnifiedDocument, right: UnifiedDocument): number {
  const leftTime = left.timeUnix ?? Number.MAX_SAFE_INTEGER;
  const rightTime = right.timeUnix ?? Number.MAX_SAFE_INTEGER;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return left.sourcePath.localeCompare(right.sourcePath);
}

function compareSegments(left: UnifiedSegment, right: UnifiedSegment): number {
  const leftTime = left.timeUnix ?? Number.MAX_SAFE_INTEGER;
  const rightTime = right.timeUnix ?? Number.MAX_SAFE_INTEGER;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  if (left.documentId !== right.documentId) {
    return left.documentId.localeCompare(right.documentId);
  }

  if (left.sequenceIndex !== right.sequenceIndex) {
    return left.sequenceIndex - right.sequenceIndex;
  }

  return left.id.localeCompare(right.id);
}

function buildTimeline(
  segments: UnifiedSegment[],
  documentsById: Map<string, UnifiedDocument>
): UnifiedCorpus["timeline"] {
  return [...segments].sort(compareSegments).map((segment, index) => {
    const document = documentsById.get(segment.documentId);

    return {
      chronologyIndex: index + 1,
      segmentId: segment.id,
      documentId: segment.documentId,
      sourceKind: segment.sourceKind,
      segmentKind: segment.segmentKind,
      signalKind: segment.signalKind,
      authorKind: segment.authorKind,
      documentTitle: document?.title ?? segment.documentId,
      segmentLabel: segment.segmentLabel,
      time: segment.time,
      timeUnix: segment.timeUnix,
      timePrecision: segment.timePrecision,
      textPreview: segment.textPreview
    };
  });
}

function emptyCounts(): Record<SourceKind, number> {
  return {
    writing: 0,
    conversation: 0,
    chat: 0
  };
}

/**
 * Build the final compiler-ready normalized corpus from all source-specific records.
 */
export function buildUnifiedCorpus(
  inputs: {
    writings: WritingRecord[];
    conversations: ConversationRecord[];
    chats: ChatRecord[];
  },
  options: UnifiedNormalizationOptions,
  progress?: ProgressWriter
): UnifiedCorpus {
  const reporter = new ThrottledProgressReporter(progress);
  reporter.phase(
    "unify",
    `building unified corpus from ${inputs.writings.length} writings, ${inputs.conversations.length} conversations, ${inputs.chats.length} chats`
  );

  const documentBuilds = [
    ...inputs.writings.map((writing) => buildWritingDocument(writing)),
    ...inputs.conversations.map((conversation) => buildConversationDocument(conversation, options)),
    ...inputs.chats.map((chat) => buildChatDocument(chat, options))
  ];

  reporter.phase("unify", `built ${documentBuilds.length} source documents, ordering chronology`);
  const documents = documentBuilds.map((item) => item.document).sort(compareDocuments);
  const segments = documentBuilds.flatMap((item) => item.segments);
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const timeline = buildTimeline(segments, documentsById);
  const primaryTimeline = timeline.filter((entry) => entry.signalKind === "primary");
  const documentsBySourceKind = emptyCounts();
  const segmentsBySourceKind = emptyCounts();

  for (const document of documents) {
    documentsBySourceKind[document.sourceKind] += 1;
  }

  for (const segment of segments) {
    segmentsBySourceKind[segment.sourceKind] += 1;
  }

  const includedSourceKinds = (["writing", "conversation", "chat"] as const).filter((sourceKind) => {
    if (sourceKind === "writing") {
      return inputs.writings.length > 0;
    }
    if (sourceKind === "conversation") {
      return inputs.conversations.length > 0;
    }
    return inputs.chats.length > 0;
  });

  reporter.phase(
    "unify",
    `done: ${documents.length} documents / ${segments.length} segments / ${primaryTimeline.length} primary timeline entries`
  );

  return {
    generatedAt: new Date().toISOString(),
    options: {
      ownerNames: [...options.ownerNames],
      includeOtherContext: options.includeOtherContext,
      includeAssistantContext: options.includeAssistantContext,
      includeToolContext: options.includeToolContext,
      contextWindow: options.contextWindow,
      includedSourceKinds: [...includedSourceKinds]
    },
    documents,
    segments,
    timeline,
    primaryTimeline,
    stats: {
      documentCount: documents.length,
      segmentCount: segments.length,
      primarySegmentCount: segments.filter((segment) => segment.signalKind === "primary").length,
      contextSegmentCount: segments.filter((segment) => segment.signalKind === "context").length,
      documentsBySourceKind,
      segmentsBySourceKind
    }
  };
}

/**
 * Write the compiler-ready unified corpus into output/normalized/unified/.
 */
export function writeUnifiedCorpus(paths: ProjectPaths, corpus: UnifiedCorpus): string {
  const target = path.join(paths.normalizedUnifiedDir, "corpus.json");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
  return target;
}

/**
 * Build a compact manifest for the final normalization layer.
 */
export function buildUnifiedManifest(corpus: UnifiedCorpus): Record<string, unknown> {
  const firstPrimary = corpus.primaryTimeline[0] ?? null;
  const lastPrimary = corpus.primaryTimeline[corpus.primaryTimeline.length - 1] ?? null;

  return {
    generatedAt: corpus.generatedAt,
    includedSourceKinds: corpus.options.includedSourceKinds,
    options: corpus.options,
    stats: corpus.stats,
    chronology: {
      firstPrimaryTime: firstPrimary?.time ?? null,
      lastPrimaryTime: lastPrimary?.time ?? null,
      firstPrimarySegmentId: firstPrimary?.segmentId ?? null,
      lastPrimarySegmentId: lastPrimary?.segmentId ?? null
    }
  };
}
