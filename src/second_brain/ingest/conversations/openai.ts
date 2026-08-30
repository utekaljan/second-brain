import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  ConversationFocusEntry,
  ConversationRecord,
  ConversationTurn,
  ConversationTurnRole
} from "../../types/domain.js";
import { slugify } from "../../utils/text.js";

// OpenAI export bundles currently contain arrays of conversation objects, each
// with a mapping graph and a current_node that identifies the active branch.
/**
 * Internal OpenAI export bundle types used by the conversation normalizer.
 */
type OpenAIConversation = Record<string, unknown>;
type OpenAIMessage = Record<string, unknown>;
type OpenAINode = {
  id?: unknown;
  message?: unknown;
  parent?: unknown;
  children?: unknown;
};

/**
 * Options controlling how much assistant/tool context is retained around user turns.
 */
export type NormalizeConversationsOptions = {
  includeAssistantContext: boolean;
  includeToolContext: boolean;
  contextWindow: number;
  enablePrefilter?: boolean;
  enableWorkFilter?: boolean;
};

const MIN_NULL_GIZMO_TURN_COUNT = 10;
const MIN_PASTED_DOCUMENT_TURN_CHARS = 4000;
const MIN_STRUCTURED_DOCUMENT_TURN_CHARS = 8000;
const MIN_ACADEMIC_PASTE_TURN_CHARS = 40000;
const STRUCTURED_DOCUMENT_MIN_NON_EMPTY_LINES = 120;
const STRUCTURED_DOCUMENT_MIN_SHORT_LINE_RATIO = 0.45;
const MAX_TRIMMED_INTRO_CHARS = 320;
const WORK_CLASSIFIER_MAX_USER_TURNS = 6;
const WORK_CLASSIFIER_MAX_TEXT_CHARS = 8000;

const EXPLICIT_PASTED_DOCUMENT_PATTERNS = [
  /tady mas obsah souboru/i,
  /obsah souboru jako text/i,
  /jeste je tam soubor/i,
  /file contents?/i,
  /api reference/i,
  /zakaznicka app:/i,
  /partnerska app:/i,
  /funkcni popis/i,
  /login\s*\/\s*pristupy/i,
  /billing:/i
] as const;

const PASTED_DOCUMENT_TRANSPORT_PATTERNS = [
  /dam ti sem/i,
  /ted ti sem dam/i,
  /jeste tam je/i,
  /tady to je/i,
  /posilam sem/i,
  /pockej na pokyn/i,
  /zatim nic nerikej/i
] as const;

const PASTED_DOCUMENT_OBJECT_PATTERNS = [
  /souboru/i,
  /kapitolu/i,
  /clanku/i,
  /studii/i,
  /textu/i,
  /paperu/i,
  /api/i,
  /reference/i,
  /admin/i,
  /login/i,
  /billing/i,
  /backend/i,
  /utf8/i,
  /json/i,
  /aplikace/i
] as const;

const PASTED_ACADEMIC_ABSTRACT_PATTERNS = [
  /here we present/i,
  /\bet al\.?\b/i,
  /\(n.?=\s*\d+\)/i,
  /\b\d+,\d+\b/,
  /\d+[–,-]\d+/,
  /theory-neutral consortium/i
] as const;

const EXTERNAL_TEXT_INTRO_PATTERNS = [
  /nasel jsem tento clanek\s*:/i,
  /potrebuju vysvetlit nasledujici text/i,
  /o tomto clanku bych se dnes chtel bavit/i,
  /kolega mi poslal sv[uů]j text/i,
  /tady (?:autor|autorka) pise/i,
  /toto je vynatek z knihy/i,
  /chatgpt\s*[rř]ekl\s*:/i,
  /tady je lepsi vysvetleni/i
] as const;

const EXTERNAL_TEXT_BODY_MARKER_PATTERNS = [
  /toto jsou jejich terms\s*(?:&|and)\s*conditions\s*:/i
] as const;

const PURE_EXTERNAL_PROMPT_PATTERNS = [
  /from now on you are going to act as a dan/i,
  /do anything now/i
] as const;

const WORK_SYSTEM_KEYWORDS = [
  { label: "aplikace", pattern: /\baplikac\w*/gi },
  { label: "app", pattern: /\bapp\b/gi },
  { label: "projekt", pattern: /\bprojekt\w*/gi },
  { label: "backend", pattern: /\bbackend\w*/gi },
  { label: "frontend", pattern: /\bfrontend\w*/gi },
  { label: "admin", pattern: /\badmin\b/gi },
  { label: "billing", pattern: /\bbilling\b/gi },
  { label: "klient", pattern: /\bklient\w*/gi },
  { label: "registrace", pattern: /\bregistrac\w*/gi },
  { label: "login", pattern: /\blogin\b/gi },
  { label: "databaze", pattern: /\bdatab[aá]z\w*/gi },
  { label: "db", pattern: /\bdb\b/gi },
  { label: "endpoint", pattern: /\bendpoint\w*/gi }
] as const;

const WORK_IMPLEMENTATION_KEYWORDS = [
  { label: "kod", pattern: /\bk[oó]d\w*/gi },
  { label: "code", pattern: /\bcode\b/gi },
  { label: "api", pattern: /\bapi\b/gi },
  { label: "json", pattern: /\bjson\b/gi },
  { label: "python", pattern: /\bpython\b/gi },
  { label: "typescript", pattern: /\btypescript\b/gi },
  { label: "javascript", pattern: /\bjavascript\b/gi },
  { label: "flutter", pattern: /\bflutter\b/gi },
  { label: "xcode", pattern: /\bxcode\b/gi },
  { label: "swift", pattern: /\bswift\b/gi },
  { label: "skript", pattern: /\bskript\w*/gi },
  { label: "script", pattern: /\bscript\w*/gi },
  { label: "soubor", pattern: /\bsoubor\w*/gi },
  { label: "dokument", pattern: /\bdokument\w*/gi },
  { label: "schema", pattern: /\bsch[eé]ma\w*/gi },
  { label: "enum", pattern: /\benum\b/gi },
  { label: "class", pattern: /\bclass\b/gi },
  { label: "function", pattern: /\bfunction\b/gi },
  { label: "return", pattern: /\breturn\b/gi },
  { label: "repo", pattern: /\b(?:repo|repozitar\w*)\b/gi },
  { label: "build", pattern: /\bbuild\b/gi },
  { label: "deploy", pattern: /\bdeploy\b/gi },
  { label: "workflow", pattern: /\bworkflow\b/gi }
] as const;

const WORK_INTENT_KEYWORDS = [
  { label: "specifikace", pattern: /\bspecifikac\w*/gi },
  { label: "analyza", pattern: /\banal[yý]z\w*/gi },
  { label: "algoritmus", pattern: /\balgoritm\w*/gi },
  { label: "implementace", pattern: /\bimplement\w*/gi },
  { label: "prehled", pattern: /\bp[rř]ehled\w*/gi },
  { label: "funkcionalita", pattern: /\bfunkcionalit\w*/gi },
  { label: "oprava", pattern: /\b(oprava|opravit|opraven\w*|opravy)\b/gi },
  { label: "debug", pattern: /\bdebug\w*/gi },
  { label: "bug", pattern: /\bbug\w*/gi },
  { label: "nasazeni", pattern: /\bnasad\w*/gi },
  { label: "konfigurace", pattern: /\bkonfigurac\w*/gi },
  { label: "tabulka", pattern: /\btabulk\w*/gi },
  { label: "požadavky", pattern: /\bpo[zž]adav\w*/gi },
  { label: "pravidla", pattern: /\bpravidl\w*/gi }
] as const;

type KeywordMatch = {
  keyword: string;
  count: number;
};

type WorkKeywordBucket = {
  name: "system" | "implementation" | "intent";
  keywords: readonly {
    label: string;
    pattern: RegExp;
  }[];
};

const WORK_KEYWORD_BUCKETS: readonly WorkKeywordBucket[] = [
  { name: "system", keywords: WORK_SYSTEM_KEYWORDS },
  { name: "implementation", keywords: WORK_IMPLEMENTATION_KEYWORDS },
  { name: "intent", keywords: WORK_INTENT_KEYWORDS }
] as const;

// Generic words such as project, document, analysis, class, or administration
// also occur in political and philosophical sources. A hard work exclusion
// therefore requires multiple unambiguous software-engineering markers.
const WORK_STRONG_TECHNICAL_PATTERNS = [
  /\bbackend\w*/i,
  /\bfrontend\w*/i,
  /\bendpoint\w*/i,
  /\bapi\b/i,
  /\bjson\b/i,
  /\bpython\b/i,
  /\btypescript\b/i,
  /\bjavascript\b/i,
  /\bflutter\b/i,
  /\bxcode\b/i,
  /\bdatabaz\w*/i,
  /\bdb\b/i,
  /\benum\b/i,
  /\bfunction\b/i,
  /\b(?:repo|repozitar\w*)\b/i,
  /\bdeploy\w*/i,
  /\blogin\b/i,
  /\bbilling\b/i
] as const;

export type WorkConversationClassification = {
  exclude: boolean;
  score: number;
  matchedBucketCount: number;
  totalKeywordHits: number;
  titleKeywordHits: number;
  matchedBuckets: Array<{
    bucket: "system" | "implementation" | "intent";
    hitCount: number;
    matches: KeywordMatch[];
  }>;
};

/**
 * Deterministic pre-ingest decision for whether one conversation should enter
 * the second-brain pipeline at all.
 */
export type ConversationInclusionDecision =
  | {
      include: true;
      gizmoId: null;
      reason: "null_gizmo_long_non_code";
    }
  | {
      include: false;
      gizmoId: string;
      reason: "excluded_gizmo";
    }
  | {
      include: false;
      gizmoId: null;
      reason: "excluded_null_gizmo_short";
    }
  | {
      include: false;
      gizmoId: null;
      reason: "excluded_null_gizmo_code";
    };

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return new Date(value * 1000).toISOString();
}

function extractPartText(part: unknown): string {
  if (typeof part === "string") {
    return part.trim();
  }

  if (!part || typeof part !== "object") {
    return "";
  }

  const record = part as Record<string, unknown>;
  if (typeof record.text === "string" && record.text.trim()) {
    return record.text.trim();
  }

  const contentType = typeof record.content_type === "string" ? record.content_type : null;
  if (contentType === "image_asset_pointer") {
    return "[image]";
  }
  if (contentType === "audio_asset_pointer") {
    return "[audio]";
  }
  if (contentType === "video_asset_pointer") {
    return "[video]";
  }
  if (typeof record.asset_pointer === "string") {
    return "[asset]";
  }

  return contentType ? `[${contentType}]` : "[object]";
}

function joinTextParts(parts: unknown[]): string {
  return parts
    .map((part) => extractPartText(part))
    .filter((part) => part.length > 0)
    .join("\n");
}

function extractThoughtsText(content: Record<string, unknown>): string {
  const thoughts = content.thoughts;
  if (!Array.isArray(thoughts)) {
    return "";
  }

  return thoughts
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }

      const record = item as Record<string, unknown>;
      if (typeof record.summary === "string" && record.summary.trim()) {
        return record.summary.trim();
      }
      if (typeof record.content === "string" && record.content.trim()) {
        return record.content.trim();
      }
      return "";
    })
    .filter((item) => item.length > 0)
    .join("\n\n");
}

// Content extraction intentionally reduces many OpenAI-specific payload shapes
// into one readable text field that later compiler stages can inspect.
/**
 * Reduce one OpenAI content payload into a single readable text field.
 */
export function extractConversationContentText(content: unknown): {
  contentType: string | null;
  text: string;
} {
  if (!content || typeof content !== "object") {
    return {
      contentType: null,
      text: ""
    };
  }

  const record = content as Record<string, unknown>;
  const contentType = typeof record.content_type === "string" ? record.content_type : null;

  if (Array.isArray(record.parts)) {
    return {
      contentType,
      text: joinTextParts(record.parts)
    };
  }

  if (contentType === "code" || contentType === "execution_output") {
    return {
      contentType,
      text: typeof record.text === "string" ? record.text.trim() : ""
    };
  }

  if (contentType === "reasoning_recap") {
    return {
      contentType,
      text: typeof record.content === "string" ? record.content.trim() : ""
    };
  }

  if (contentType === "thoughts") {
    return {
      contentType,
      text: extractThoughtsText(record)
    };
  }

  if (contentType === "tether_quote") {
    return {
      contentType,
      text: typeof record.text === "string" ? record.text.trim() : ""
    };
  }

  if (contentType === "tether_browsing_display") {
    return {
      contentType,
      text: typeof record.result === "string" ? record.result.trim() : ""
    };
  }

  if (contentType === "user_editable_context") {
    const parts: string[] = [];
    if (typeof record.user_instructions === "string" && record.user_instructions.trim()) {
      parts.push(`User instructions:\n${record.user_instructions.trim()}`);
    }
    if (typeof record.user_profile === "string" && record.user_profile.trim()) {
      parts.push(`User profile:\n${record.user_profile.trim()}`);
    }

    return {
      contentType,
      text: parts.join("\n\n")
    };
  }

  if (contentType === "sonic_webpage") {
    return {
      contentType,
      text:
        typeof record.text === "string"
          ? record.text.trim()
          : typeof record.snippet === "string"
            ? record.snippet.trim()
            : ""
    };
  }

  return {
    contentType,
    text:
      typeof record.text === "string"
        ? record.text.trim()
        : typeof record.content === "string"
          ? record.content.trim()
          : typeof record.result === "string"
            ? record.result.trim()
            : ""
  };
}

function classifyTurnRole(authorRole: unknown, contentType: string | null): ConversationTurnRole {
  if (contentType === "user_editable_context") {
    return "system";
  }

  if (authorRole === "user") {
    return "user";
  }
  if (authorRole === "assistant") {
    return "assistant";
  }
  if (authorRole === "tool") {
    return "tool";
  }
  if (authorRole === "system") {
    return "system";
  }

  return "unknown";
}

function collectActiveNodeIds(mapping: Record<string, OpenAINode>, currentNode: unknown): string[] {
  if (typeof currentNode === "string" && mapping[currentNode]) {
    const chain: string[] = [];
    const seen = new Set<string>();
    let nodeId: string | null = currentNode;

    while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
      chain.push(nodeId);
      seen.add(nodeId);
      const parent: unknown = mapping[nodeId]?.parent;
      nodeId = typeof parent === "string" ? parent : null;
    }

    chain.reverse();
    return chain;
  }

  // Fallback only if current_node is missing or malformed. Sorting all message
  // nodes by timestamp is less accurate than branch walking, but still usable.
  return Object.entries(mapping)
    .filter(([, node]) => node && typeof node === "object" && typeof node.message === "object")
    .sort((left, right) => {
      const leftMessage = left[1].message as OpenAIMessage;
      const rightMessage = right[1].message as OpenAIMessage;
      const leftTime = typeof leftMessage.create_time === "number" ? leftMessage.create_time : 0;
      const rightTime = typeof rightMessage.create_time === "number" ? rightMessage.create_time : 0;
      return leftTime - rightTime;
    })
    .map(([nodeId]) => nodeId);
}

function extractMessageGizmoId(message: OpenAIMessage): string | null {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const gizmoId = (metadata as Record<string, unknown>).gizmo_id;
  return typeof gizmoId === "string" && gizmoId.trim() ? gizmoId : null;
}

/**
 * Resolve the conversation-level gizmo id from the most stable available
 * export fields. The top-level template id is preferred because it survives
 * even if some individual message metadata are sparse.
 */
export function extractConversationGizmoId(
  rawConversation: OpenAIConversation,
  activeNodeIds?: string[],
  mappingOverride?: Record<string, OpenAINode>
): string | null {
  const topLevelTemplateId = rawConversation.conversation_template_id;
  if (typeof topLevelTemplateId === "string" && topLevelTemplateId.trim()) {
    return topLevelTemplateId;
  }

  const mappingValue = mappingOverride ?? rawConversation.mapping;
  const mapping =
    mappingValue && typeof mappingValue === "object"
      ? (mappingValue as Record<string, OpenAINode>)
      : {};
  const nodeIds = activeNodeIds ?? collectActiveNodeIds(mapping, rawConversation.current_node);

  for (const nodeId of nodeIds) {
    const message = mapping[nodeId]?.message;
    if (!message || typeof message !== "object") {
      continue;
    }

    const gizmoId = extractMessageGizmoId(message as OpenAIMessage);
    if (gizmoId) {
      return gizmoId;
    }
  }

  return null;
}

function containsCodeFence(turns: ConversationTurn[]): boolean {
  return turns.some(
    (turn) => turn.authorRole !== "system" && turn.text.includes("```")
  );
}

function countMatches(patterns: readonly RegExp[], value: string): number {
  return patterns.reduce((total, pattern) => total + (pattern.test(value) ? 1 : 0), 0);
}

function countRegexMatches(pattern: RegExp, value: string): number {
  return (value.match(pattern) ?? []).length;
}

function countKeywordMatches(
  keywords: readonly {
    label: string;
    pattern: RegExp;
  }[],
  value: string
): KeywordMatch[] {
  return keywords
    .map((keyword) => ({
      keyword: keyword.label,
      count: countRegexMatches(keyword.pattern, value)
    }))
    .filter((match) => match.count > 0);
}

function normalizeConversationTurnWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\u000c/g, "\n")
    .trim();
}

function collapseConversationTurnWhitespace(value: string): string {
  return value.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function trimConversationTurnToIntroPrefix(value: string): string {
  const normalized = normalizeConversationTurnWhitespace(value);
  if (!normalized) {
    return "";
  }

  const firstParagraphBreak = normalized.indexOf("\n\n");
  if (firstParagraphBreak > 0 && firstParagraphBreak <= MAX_TRIMMED_INTRO_CHARS * 2) {
    return collapseConversationTurnWhitespace(normalized.slice(0, firstParagraphBreak));
  }

  const firstLineBreak = normalized.indexOf("\n");
  if (firstLineBreak > 0 && firstLineBreak <= MAX_TRIMMED_INTRO_CHARS) {
    return collapseConversationTurnWhitespace(normalized.slice(0, firstLineBreak));
  }

  const limited = normalized.slice(0, MAX_TRIMMED_INTRO_CHARS);
  const sentenceBoundary = Math.max(
    limited.lastIndexOf(". "),
    limited.lastIndexOf("? "),
    limited.lastIndexOf("! "),
    limited.lastIndexOf(": ")
  );

  if (sentenceBoundary >= 40) {
    return collapseConversationTurnWhitespace(limited.slice(0, sentenceBoundary + 1));
  }

  return collapseConversationTurnWhitespace(limited);
}

function trimConversationTurnBeforeMarker(
  value: string,
  patterns: readonly RegExp[]
): string | null {
  const markerIndex = patterns.reduce((earliest, pattern) => {
    const index = value.search(pattern);
    return index >= 0 && (earliest < 0 || index < earliest) ? index : earliest;
  }, -1);

  if (markerIndex < 0) {
    return null;
  }

  return collapseConversationTurnWhitespace(value.slice(0, markerIndex));
}

function hasChapterHeadingLead(value: string): boolean {
  const head = value.slice(0, 160);
  return (
    /^\s*\d+(?:[.-]\d+)+(?:\s+|$)/.test(head) ||
    /^\s*\d+\.[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/.test(head) ||
    /^\s*[IVXLC]+\.\s+/i.test(head) ||
    /^\s*\d+\.\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/.test(head)
  );
}

function hasOcrNoiseSignal(value: string): boolean {
  return countRegexMatches(/[a-záčďéěíňóřšťúůýž]{2,}-\n[a-záčďéěíňóřšťúůýž]{2,}/gi, value) >= 2;
}

function normalizeWorkConversationText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export type ConversationTurnSanitization = {
  action: "keep" | "trim" | "drop";
  sanitizedText: string;
  reasons: string[];
};

/**
 * Drop obvious pasted external documents before they become primary
 * conversation segments. The goal is high precision on transport-style dumps,
 * not broad length-based suppression of legitimate authored thought.
 */
export function sanitizeConversationTurnText(turn: ConversationTurn): ConversationTurnSanitization {
  const trimmed = normalizeConversationTurnWhitespace(turn.text);

  if (turn.authorRole !== "user") {
    return {
      action: "keep",
      sanitizedText: trimmed,
      reasons: []
    };
  }

  if (!trimmed) {
    return {
      action: "drop",
      sanitizedText: "",
      reasons: ["empty_user_turn"]
    };
  }

  const head = trimmed.slice(0, 1600);
  const nonEmptyLines = trimmed.split(/\n/).filter((line) => line.trim().length > 0);
  const shortLineRatio =
    nonEmptyLines.length === 0
      ? 0
      : nonEmptyLines.filter((line) => line.trim().length <= 80).length / nonEmptyLines.length;
  const urlCount = countRegexMatches(/https?:\/\//gi, trimmed);
  const bulletCount = countRegexMatches(/^\s*[-*•]/gm, trimmed);
  const colonLineCount = countRegexMatches(/:\s*$/gm, trimmed);
  const explicitDocumentSignal = countMatches(EXPLICIT_PASTED_DOCUMENT_PATTERNS, head) > 0;
  const transportSignal = countMatches(PASTED_DOCUMENT_TRANSPORT_PATTERNS, head) > 0;
  const introSignal = countMatches(EXTERNAL_TEXT_INTRO_PATTERNS, head) > 0;
  const introBeforeBodyMarker = trimConversationTurnBeforeMarker(
    trimmed,
    EXTERNAL_TEXT_BODY_MARKER_PATTERNS
  );
  const documentObjectSignalCount = countMatches(PASTED_DOCUMENT_OBJECT_PATTERNS, head);
  const academicAbstractSignal =
    trimmed.length >= MIN_ACADEMIC_PASTE_TURN_CHARS &&
    countMatches(PASTED_ACADEMIC_ABSTRACT_PATTERNS, head) >= 2;
  const structuredDocumentSignal =
    trimmed.length >= MIN_STRUCTURED_DOCUMENT_TURN_CHARS &&
    nonEmptyLines.length >= STRUCTURED_DOCUMENT_MIN_NON_EMPTY_LINES &&
    shortLineRatio >= STRUCTURED_DOCUMENT_MIN_SHORT_LINE_RATIO &&
    (urlCount >= 2 || bulletCount >= 6 || colonLineCount >= 6);
  const pureExternalPromptSignal = countMatches(PURE_EXTERNAL_PROMPT_PATTERNS, head) > 0;
  const pureChapterDumpSignal =
    trimmed.length >= MIN_STRUCTURED_DOCUMENT_TURN_CHARS &&
    hasChapterHeadingLead(trimmed) &&
    (academicAbstractSignal || hasOcrNoiseSignal(trimmed) || shortLineRatio >= 0.35);

  if (trimmed.length < MIN_PASTED_DOCUMENT_TURN_CHARS) {
    return {
      action: "keep",
      sanitizedText: trimmed,
      reasons: []
    };
  }

  if (pureExternalPromptSignal) {
    return {
      action: "drop",
      sanitizedText: "",
      reasons: ["prompt_dump"]
    };
  }

  if (explicitDocumentSignal) {
    const intro = trimConversationTurnToIntroPrefix(trimmed);
    return intro
      ? {
          action: "trim",
          sanitizedText: intro,
          reasons: ["explicit_pasted_document"]
        }
      : {
          action: "drop",
          sanitizedText: "",
          reasons: ["explicit_pasted_document"]
        };
  }

  if (transportSignal && documentObjectSignalCount > 0) {
    const intro = trimConversationTurnToIntroPrefix(trimmed);
    return intro
      ? {
          action: "trim",
          sanitizedText: intro,
          reasons: ["transport_preface_plus_document_dump"]
        }
      : {
          action: "drop",
          sanitizedText: "",
          reasons: ["transport_preface_plus_document_dump"]
        };
  }

  if (introBeforeBodyMarker) {
    return {
      action: "trim",
      sanitizedText: introBeforeBodyMarker,
      reasons: ["intro_before_external_body"]
    };
  }

  if (introSignal) {
    const intro = trimConversationTurnToIntroPrefix(trimmed);
    return intro
      ? {
          action: "trim",
          sanitizedText: intro,
          reasons: ["intro_plus_external_excerpt"]
        }
      : {
          action: "drop",
          sanitizedText: "",
          reasons: ["intro_plus_external_excerpt"]
        };
  }

  if (structuredDocumentSignal && documentObjectSignalCount >= 2) {
    return {
      action: "drop",
      sanitizedText: "",
      reasons: ["structured_document_dump"]
    };
  }

  if (academicAbstractSignal) {
    return {
      action: "drop",
      sanitizedText: "",
      reasons: ["academic_abstract_dump"]
    };
  }

  if (pureChapterDumpSignal) {
    return {
      action: "drop",
      sanitizedText: "",
      reasons: ["chapter_or_ocr_excerpt_dump"]
    };
  }

  return {
    action: "keep",
    sanitizedText: trimmed,
    reasons: []
  };
}

/**
 * Identify operational/work conversations that should not enter the thought
 * corpus. This is intentionally deterministic and keyword-bucket based so the
 * excluded set stays inspectable and easy to audit.
 */
export function classifyWorkConversation(record: ConversationRecord): WorkConversationClassification {
  const normalizedTitle = normalizeWorkConversationText(record.title);
  const bodySlice = record.userTurns
    .slice(0, WORK_CLASSIFIER_MAX_USER_TURNS)
    .map((turn) => turn.text)
    .join("\n\n")
    .slice(0, WORK_CLASSIFIER_MAX_TEXT_CHARS);
  const normalizedBody = normalizeWorkConversationText(
    [record.title, bodySlice].join("\n\n")
  );
  const matchedBuckets = WORK_KEYWORD_BUCKETS.map((bucket) => {
    const matches = countKeywordMatches(bucket.keywords, normalizedBody);
    return {
      bucket: bucket.name,
      hitCount: matches.reduce((total, match) => total + match.count, 0),
      matches
    };
  }).filter((bucket) => bucket.hitCount > 0);

  const totalKeywordHits = matchedBuckets.reduce((total, bucket) => total + bucket.hitCount, 0);
  const matchedBucketCount = matchedBuckets.length;
  const titleKeywordHits = WORK_KEYWORD_BUCKETS.reduce(
    (total, bucket) => total + countKeywordMatches(bucket.keywords, normalizedTitle).reduce((sum, match) => sum + match.count, 0),
    0
  );
  const maxBucketHits = matchedBuckets.reduce((max, bucket) => Math.max(max, bucket.hitCount), 0);
  const strongTechnicalMarkerCount = countMatches(WORK_STRONG_TECHNICAL_PATTERNS, normalizedBody);
  const score = matchedBucketCount * 3 + totalKeywordHits + Math.min(titleKeywordHits, 2);

  return {
    exclude:
      matchedBucketCount >= 2 &&
      totalKeywordHits >= 5 &&
      strongTechnicalMarkerCount >= 2 &&
      (titleKeywordHits >= 1 || maxBucketHits >= 3),
    score,
    matchedBucketCount,
    totalKeywordHits,
    titleKeywordHits,
    matchedBuckets
  };
}

function sanitizeConversationTurn(turn: ConversationTurn): ConversationTurn | null {
  const sanitization = sanitizeConversationTurnText(turn);
  if (sanitization.action === "drop" || !sanitization.sanitizedText) {
    return null;
  }

  return {
    ...turn,
    text: sanitization.sanitizedText
  };
}

function shouldKeepConversationTurn(turn: ConversationTurn): boolean {
  if (turn.authorRole !== "user") {
    return true;
  }

  return sanitizeConversationTurnText(turn).action !== "drop";
}

/**
 * Apply the hard conversation-source filter before the unified corpus is
 * built. This is intentionally narrow and operational, not semantic ranking.
 */
export function decideConversationInclusion(
  rawConversation: OpenAIConversation,
  turns: ConversationTurn[],
  activeNodeIds?: string[],
  mappingOverride?: Record<string, OpenAINode>
): ConversationInclusionDecision {
  const gizmoId = extractConversationGizmoId(rawConversation, activeNodeIds, mappingOverride);
  if (gizmoId) {
    return {
      include: false,
      gizmoId,
      reason: "excluded_gizmo"
    };
  }

  if (turns.length <= MIN_NULL_GIZMO_TURN_COUNT) {
    return {
      include: false,
      gizmoId: null,
      reason: "excluded_null_gizmo_short"
    };
  }

  if (containsCodeFence(turns)) {
    return {
      include: false,
      gizmoId: null,
      reason: "excluded_null_gizmo_code"
    };
  }

  return {
    include: true,
    gizmoId: null,
    reason: "null_gizmo_long_non_code"
  };
}

function parseTurn(nodeId: string, node: OpenAINode): ConversationTurn | null {
  if (!node.message || typeof node.message !== "object") {
    return null;
  }

  const message = node.message as OpenAIMessage;
  const author = (message.author ?? {}) as Record<string, unknown>;
  const { contentType, text } = extractConversationContentText(message.content);
  const authorRole = classifyTurnRole(author.role, contentType);

  // Empty transport nodes occur in some exports and add no semantic value.
  if (!text.trim()) {
    return null;
  }

  const createTimeSeconds =
    typeof message.create_time === "number" && Number.isFinite(message.create_time)
      ? message.create_time
      : null;
  const createTimeUnix = createTimeSeconds === null ? null : createTimeSeconds * 1000;

  return {
    id: typeof message.id === "string" ? message.id : `message:${nodeId}`,
    nodeId,
    authorRole,
    recipient: typeof message.recipient === "string" ? message.recipient : null,
    contentType,
    createTime: toIsoTimestamp(createTimeSeconds),
    createTimeUnix,
    text
  };
}

function isContextTurn(
  turn: ConversationTurn,
  options: NormalizeConversationsOptions
): turn is ConversationTurn {
  return (
    (turn.authorRole === "assistant" && options.includeAssistantContext) ||
    (turn.authorRole === "tool" && options.includeToolContext)
  );
}

// The focus timeline is the compact, mind-centered representation: user
// messages are primary units, assistant/tool turns are optional local context.
/**
 * Build the user-centered focus timeline for a normalized OpenAI conversation.
 */
export function buildConversationFocusTimeline(
  turns: ConversationTurn[],
  options: NormalizeConversationsOptions
): ConversationFocusEntry[] {
  const focusEntries: ConversationFocusEntry[] = [];
  const addedContextIds = new Set<string>();

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];

    if (turn.authorRole !== "user") {
      continue;
    }

    const start = Math.max(0, index - options.contextWindow);
    for (let contextIndex = start; contextIndex < index; contextIndex += 1) {
      const contextTurn = turns[contextIndex];
      if (!isContextTurn(contextTurn, options) || addedContextIds.has(contextTurn.id)) {
        continue;
      }

      focusEntries.push(
        contextTurn.authorRole === "assistant"
          ? {
              type: "assistant_context",
              turnId: contextTurn.id,
              createTime: contextTurn.createTime,
              createTimeUnix: contextTurn.createTimeUnix,
              text: contextTurn.text
            }
          : {
              type: "tool_context",
              turnId: contextTurn.id,
              createTime: contextTurn.createTime,
              createTimeUnix: contextTurn.createTimeUnix,
              text: contextTurn.text,
              recipient: contextTurn.recipient
            }
      );
      addedContextIds.add(contextTurn.id);
    }

    focusEntries.push({
      type: "user_message",
      turnId: turn.id,
      createTime: turn.createTime,
      createTimeUnix: turn.createTimeUnix,
      text: turn.text
    });

    const end = Math.min(turns.length - 1, index + options.contextWindow);
    for (let contextIndex = index + 1; contextIndex <= end; contextIndex += 1) {
      const contextTurn = turns[contextIndex];
      if (!isContextTurn(contextTurn, options) || addedContextIds.has(contextTurn.id)) {
        continue;
      }

      focusEntries.push(
        contextTurn.authorRole === "assistant"
          ? {
              type: "assistant_context",
              turnId: contextTurn.id,
              createTime: contextTurn.createTime,
              createTimeUnix: contextTurn.createTimeUnix,
              text: contextTurn.text
            }
          : {
              type: "tool_context",
              turnId: contextTurn.id,
              createTime: contextTurn.createTime,
              createTimeUnix: contextTurn.createTimeUnix,
              text: contextTurn.text,
              recipient: contextTurn.recipient
            }
      );
      addedContextIds.add(contextTurn.id);
    }
  }

  return focusEntries;
}

/**
 * Parse one OpenAI conversation object into the normalized conversation record.
 */
export function parseOpenAIConversation(
  sourcePath: string,
  rawConversation: OpenAIConversation,
  options: NormalizeConversationsOptions
): ConversationRecord {
  const mappingValue = rawConversation.mapping;
  const mapping =
    mappingValue && typeof mappingValue === "object"
      ? (mappingValue as Record<string, OpenAINode>)
      : {};

  const activeNodeIds = collectActiveNodeIds(mapping, rawConversation.current_node);
  const turns = activeNodeIds
    .map((nodeId) => parseTurn(nodeId, mapping[nodeId] ?? {}))
    .filter((turn): turn is ConversationTurn => turn !== null)
    .map((turn) => sanitizeConversationTurn(turn))
    .filter((turn): turn is ConversationTurn => turn !== null)
    .filter((turn) => shouldKeepConversationTurn(turn));
  const gizmoId = extractConversationGizmoId(rawConversation, activeNodeIds, mapping);

  const bundleName = path.basename(sourcePath);
  const conversationId =
    typeof rawConversation.conversation_id === "string"
      ? rawConversation.conversation_id
      : typeof rawConversation.id === "string"
        ? rawConversation.id
        : bundleName;
  const title =
    typeof rawConversation.title === "string" && rawConversation.title.trim()
      ? rawConversation.title.trim()
      : conversationId;
  const slug = slugify(`${title}-${conversationId}`);
  const createTimeSeconds =
    typeof rawConversation.create_time === "number" && Number.isFinite(rawConversation.create_time)
      ? rawConversation.create_time
      : null;
  const updateTimeSeconds =
    typeof rawConversation.update_time === "number" && Number.isFinite(rawConversation.update_time)
      ? rawConversation.update_time
      : null;
  const createTimeUnix = createTimeSeconds === null ? null : createTimeSeconds * 1000;
  const updateTimeUnix = updateTimeSeconds === null ? null : updateTimeSeconds * 1000;

  return {
    id: `conversation:${slug}`,
    sourceKind: "conversation",
    sourcePath,
    bundleName,
    conversationId,
    title,
    gizmoId,
    defaultModelSlug:
      typeof rawConversation.default_model_slug === "string"
        ? rawConversation.default_model_slug
        : null,
    createTime: toIsoTimestamp(createTimeSeconds),
    createTimeUnix,
    updateTime: toIsoTimestamp(updateTimeSeconds),
    updateTimeUnix,
    activeNodeIds,
    turns,
    turnCount: turns.length,
    userTurnCount: turns.filter((turn) => turn.authorRole === "user").length,
    assistantTurnCount: turns.filter((turn) => turn.authorRole === "assistant").length,
    toolTurnCount: turns.filter((turn) => turn.authorRole === "tool").length,
    systemTurnCount: turns.filter((turn) => turn.authorRole === "system").length,
    userTurns: turns.filter((turn) => turn.authorRole === "user"),
    assistantTurns: turns.filter((turn) => turn.authorRole === "assistant"),
    toolTurns: turns.filter((turn) => turn.authorRole === "tool"),
    focusTimeline: buildConversationFocusTimeline(turns, options)
  };
}

/**
 * Read one OpenAI bundle file containing multiple conversation objects.
 */
export function readOpenAIConversationBundle(sourcePath: string): OpenAIConversation[] {
  const content = readFileSync(sourcePath, "utf8");
  const payload = JSON.parse(content);
  return Array.isArray(payload) ? payload : [];
}
