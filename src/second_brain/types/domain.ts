// Shared domain types keep the early pipeline explicit. The project is still
// small enough that centralizing these shapes is clearer than scattering them.
/**
 * Shared source kinds currently handled by the ingestion pipeline.
 */
export type SourceKind = "writing" | "chat" | "conversation";

export type WritingRecord = {
  id: string;
  sourceKind: "writing";
  sourcePath: string;
  slug: string;
  fileLabel: string;
  title: string;
  sourceDate: string | null;
  sourceDateUnix: number | null;
  lineCount: number;
  wordCount: number;
  characterCount: number;
  body: string;
};

// Chat roles are deliberately asymmetrical: owner messages are the primary
// signal, other messages are optional context, and system lines are metadata.
/**
 * Role classification for normalized chat messages.
 */
export type ChatMessageRole = "owner" | "other" | "system";

export type ChatMessage = {
  id: string;
  timestamp: string | null;
  timestampUnix: number | null;
  author: string;
  role: ChatMessageRole;
  text: string;
};

// The focus timeline is the mind-centered view of a chat. It preserves owner
// messages as first-class items and only keeps external speech as context.
/**
 * User-centered chat timeline where owner messages are primary and external
 * messages are retained only as context.
 */
export type ChatFocusEntry =
  | {
      type: "owner_message";
      messageId: string;
      timestamp: string | null;
      timestampUnix: number | null;
      text: string;
    }
  | {
      type: "context";
      messageId: string;
      timestamp: string | null;
      timestampUnix: number | null;
      author: string;
      text: string;
    };

export type ChatRecord = {
  // The normalized chat output keeps both the raw-like message split and the
  // user-centered focus timeline because later compiler stages will likely
  // need both views.
  id: string;
  sourceKind: "chat";
  sourcePath: string;
  slug: string;
  title: string;
  ownerNames: string[];
  participantNames: string[];
  startTime: string | null;
  startTimeUnix: number | null;
  endTime: string | null;
  endTimeUnix: number | null;
  messageCount: number;
  ownerMessageCount: number;
  otherMessageCount: number;
  systemMessageCount: number;
  messages: ChatMessage[];
  ownerMessages: ChatMessage[];
  contextMessages: ChatMessage[];
  focusTimeline: ChatFocusEntry[];
};

// OpenAI export conversations are normalized into active-branch turns so
// regenerated or abandoned branches do not pollute the user's thought history.
/**
 * Role classification for normalized OpenAI conversation turns.
 */
export type ConversationTurnRole = "user" | "assistant" | "tool" | "system" | "unknown";

export type ConversationTurn = {
  id: string;
  nodeId: string;
  authorRole: ConversationTurnRole;
  recipient: string | null;
  contentType: string | null;
  createTime: string | null;
  createTimeUnix: number | null;
  text: string;
};

export type ConversationFocusEntry =
  | {
      type: "user_message";
      turnId: string;
      createTime: string | null;
      createTimeUnix: number | null;
      text: string;
    }
  | {
      type: "assistant_context";
      turnId: string;
      createTime: string | null;
      createTimeUnix: number | null;
      text: string;
    }
  | {
      type: "tool_context";
      turnId: string;
      createTime: string | null;
      createTimeUnix: number | null;
      text: string;
      recipient: string | null;
    };

export type ConversationRecord = {
  id: string;
  sourceKind: "conversation";
  sourcePath: string;
  bundleName: string;
  conversationId: string;
  title: string;
  gizmoId: string | null;
  defaultModelSlug: string | null;
  createTime: string | null;
  createTimeUnix: number | null;
  updateTime: string | null;
  updateTimeUnix: number | null;
  activeNodeIds: string[];
  turns: ConversationTurn[];
  turnCount: number;
  userTurnCount: number;
  assistantTurnCount: number;
  toolTurnCount: number;
  systemTurnCount: number;
  userTurns: ConversationTurn[];
  assistantTurns: ConversationTurn[];
  toolTurns: ConversationTurn[];
  focusTimeline: ConversationFocusEntry[];
};

/**
 * Normalized precision of timestamps carried through the compiler-ready corpus.
 */
export type UnifiedTimePrecision = "day" | "second" | "unknown";

/**
 * Whether a normalized segment is a primary signal of the user's own thinking
 * or supporting context kept around that signal.
 */
export type UnifiedSignalKind = "primary" | "context";

/**
 * Unified author classification used across writings, chats, and conversations.
 */
export type UnifiedAuthorKind = "self" | "assistant" | "other_person" | "tool" | "system" | "unknown";

/**
 * Segment kinds emitted by the final normalization layer.
 */
export type UnifiedSegmentKind =
  | "writing_paragraph"
  | "conversation_user_turn"
  | "conversation_assistant_context"
  | "conversation_tool_context"
  | "chat_owner_message"
  | "chat_context_message";

/**
 * Stable pointer back from a compiler-ready segment to its originating source.
 */
export type UnifiedSourceRef = {
  sourceKind: SourceKind;
  sourcePath: string;
  documentId: string;
  documentTitle: string;
  locator: string;
  sourceItemId: string | null;
  conversationId?: string;
  bundleName?: string;
  turnId?: string;
  messageId?: string;
};

/**
 * Document-level normalized view of one raw source item.
 *
 * This is the place where the compiler can see a whole essay, a full
 * conversation thread, or one chat export as a single inspectable unit.
 */
export type UnifiedDocument = {
  id: string;
  sourceKind: SourceKind;
  sourcePath: string;
  slug: string;
  title: string;
  time: string | null;
  timeUnix: number | null;
  timePrecision: UnifiedTimePrecision;
  sourcePriority: number;
  primaryText: string;
  contextText: string | null;
  primarySegmentCount: number;
  contextSegmentCount: number;
  metadata: {
    fileLabel?: string;
    lineCount?: number;
    wordCount?: number;
    conversationId?: string;
    bundleName?: string;
    gizmoId?: string | null;
    defaultModelSlug?: string | null;
    turnCount?: number;
    ownerNames?: string[];
    participantNames?: string[];
    messageCount?: number;
  };
};

/**
 * Compiler-ready normalized segment used uniformly across all source types.
 */
export type UnifiedSegment = {
  id: string;
  documentId: string;
  sourceKind: SourceKind;
  segmentKind: UnifiedSegmentKind;
  signalKind: UnifiedSignalKind;
  authorKind: UnifiedAuthorKind;
  authorLabel: string | null;
  sequenceIndex: number;
  time: string | null;
  timeUnix: number | null;
  timePrecision: UnifiedTimePrecision;
  sourcePriority: number;
  segmentLabel: string;
  text: string;
  textPreview: string;
  sourceRef: UnifiedSourceRef;
};

/**
 * Chronologically sorted pointer view over normalized segments.
 */
export type UnifiedTimelineEntry = {
  chronologyIndex: number;
  segmentId: string;
  documentId: string;
  sourceKind: SourceKind;
  segmentKind: UnifiedSegmentKind;
  signalKind: UnifiedSignalKind;
  authorKind: UnifiedAuthorKind;
  documentTitle: string;
  segmentLabel: string;
  time: string | null;
  timeUnix: number | null;
  timePrecision: UnifiedTimePrecision;
  textPreview: string;
};

/**
 * Final normalization artifact consumed by the future wiki compiler.
 */
export type UnifiedCorpus = {
  generatedAt: string;
  options: {
    ownerNames: string[];
    includeOtherContext: boolean;
    includeAssistantContext: boolean;
    includeToolContext: boolean;
    contextWindow: number;
    includedSourceKinds: SourceKind[];
  };
  documents: UnifiedDocument[];
  segments: UnifiedSegment[];
  timeline: UnifiedTimelineEntry[];
  primaryTimeline: UnifiedTimelineEntry[];
  stats: {
    documentCount: number;
    segmentCount: number;
    primarySegmentCount: number;
    contextSegmentCount: number;
    documentsBySourceKind: Record<SourceKind, number>;
    segmentsBySourceKind: Record<SourceKind, number>;
  };
};
