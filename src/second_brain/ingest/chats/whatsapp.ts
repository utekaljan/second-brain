import { readFileSync } from "node:fs";
import path from "node:path";

import type { ChatFocusEntry, ChatMessage, ChatMessageRole, ChatRecord } from "../../types/domain.js";
import { slugify } from "../../utils/text.js";

// This parser targets the plain-text WhatsApp export format currently present
// in input/chats/. If another export variant appears later, it should become a
// separate parser instead of overloading this regex endlessly.
/**
 * WhatsApp plain-text export line pattern.
 */
const WHATSAPP_LINE_PATTERN =
  /^[\u200e\u200f\u202a-\u202e]*\[(\d{2}\.\d{2}\.\d{4}) (\d{1,2}:\d{2}:\d{2})\] ([^:]+):\s?(.*)$/;

function normalizeAuthor(author: string): string {
  // Normalization avoids false mismatches when the same visible name appears
  // with different unicode representations.
  return author.trim().normalize("NFKC");
}

function toIsoTimestamp(datePart: string, timePart: string): string | null {
  const [day, month, year] = datePart.split(".");
  if (!day || !month || !year) {
    return null;
  }

  return `${year}-${month}-${day}T${timePart}`;
}

function toTimestampUnix(datePart: string, timePart: string): number | null {
  const [dayRaw, monthRaw, yearRaw] = datePart.split(".");
  const [hourRaw, minuteRaw, secondRaw] = timePart.split(":");
  const day = Number.parseInt(dayRaw ?? "", 10);
  const month = Number.parseInt(monthRaw ?? "", 10);
  const year = Number.parseInt(yearRaw ?? "", 10);
  const hour = Number.parseInt(hourRaw ?? "", 10);
  const minute = Number.parseInt(minuteRaw ?? "", 10);
  const second = Number.parseInt(secondRaw ?? "", 10);

  if (
    !Number.isInteger(day) ||
    !Number.isInteger(month) ||
    !Number.isInteger(year) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second)
  ) {
    return null;
  }

  // Chat exports are timezone-naive, so we turn them into a stable sortable
  // unix value with Date.UTC instead of relying on the local machine timezone.
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function isSystemText(text: string): boolean {
  // WhatsApp exports mix actual speech with chat housekeeping lines. Those
  // lines should never be attributed as thoughts of any participant.
  const trimmed = text.trim().toLowerCase();
  return (
    trimmed.includes("zprávy a hovory jsou opatřené koncovým šifrováním") ||
    trimmed.includes("vytvořil/a skupinu") ||
    trimmed.includes("přidal/a vás") ||
    trimmed.includes("změnil/a ikonu této skupiny")
  );
}

/**
 * Parse a WhatsApp transcript into normalized messages with owner/context roles.
 */
export function parseWhatsAppTranscript(content: string, ownerNames: string[]): ChatMessage[] {
  // Ownership is configured explicitly from the outside. That keeps the parser
  // user-centered without hardcoding a single identity into the repository.
  const normalizedOwners = new Set(ownerNames.map((name) => normalizeAuthor(name)));
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const messages: ChatMessage[] = [];

  for (const rawLine of lines) {
    // Some exports prefix lines with invisible direction markers. Stripping
    // them here makes matching and downstream display more stable.
    const line = rawLine.replace(/^[\u200e\u200f\u202a-\u202e]+/, "");
    if (!line.trim()) {
      continue;
    }

    const match = line.match(WHATSAPP_LINE_PATTERN);
    if (match) {
      const [, datePart, timePart, authorRaw, textRaw] = match;
      const author = normalizeAuthor(authorRaw);
      const timestamp = toIsoTimestamp(datePart, timePart);
      const timestampUnix = toTimestampUnix(datePart, timePart);
      let role: ChatMessageRole = normalizedOwners.has(author) ? "owner" : "other";

      if (isSystemText(textRaw)) {
        // System lines override participant roles even if the author label
        // happens to match one of the owner names.
        role = "system";
      }

      messages.push({
        id: `msg-${messages.length + 1}`,
        timestamp,
        timestampUnix,
        author,
        role,
        text: textRaw.trim()
      });
      continue;
    }

    const lastMessage = messages[messages.length - 1];
    if (lastMessage) {
      // Lines without a new timestamp belong to the previous message body.
      lastMessage.text = `${lastMessage.text}\n${line.trim()}`;
    }
  }

  return messages;
}

/**
 * Build the user-centered chat focus timeline with optional nearby context.
 */
export function buildFocusTimeline(
  messages: ChatMessage[],
  options: { includeOtherContext: boolean; contextWindow: number }
): ChatFocusEntry[] {
  const focusEntries: ChatFocusEntry[] = [];
  const addedContextIds = new Set<string>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (message.role !== "owner") {
      continue;
    }

    if (options.includeOtherContext) {
      const start = Math.max(0, index - options.contextWindow);

      // Context before the user's message is added first so the resulting
      // timeline reads naturally around the owner's thought.
      for (let contextIndex = start; contextIndex < index; contextIndex += 1) {
        const contextMessage = messages[contextIndex];
        if (contextMessage.role !== "other" || addedContextIds.has(contextMessage.id)) {
          continue;
        }

        focusEntries.push({
          type: "context",
          messageId: contextMessage.id,
          timestamp: contextMessage.timestamp,
          timestampUnix: contextMessage.timestampUnix,
          author: contextMessage.author,
          text: contextMessage.text
        });
        addedContextIds.add(contextMessage.id);
      }
    }

    focusEntries.push({
      type: "owner_message",
      messageId: message.id,
      timestamp: message.timestamp,
      timestampUnix: message.timestampUnix,
      text: message.text
    });

    if (options.includeOtherContext) {
      const end = Math.min(messages.length - 1, index + options.contextWindow);

      // Context after the user's message is appended second for the same
      // reason: the timeline should stay readable as a local dialogue slice.
      for (let contextIndex = index + 1; contextIndex <= end; contextIndex += 1) {
        const contextMessage = messages[contextIndex];
        if (contextMessage.role !== "other" || addedContextIds.has(contextMessage.id)) {
          continue;
        }

        focusEntries.push({
          type: "context",
          messageId: contextMessage.id,
          timestamp: contextMessage.timestamp,
          timestampUnix: contextMessage.timestampUnix,
          author: contextMessage.author,
          text: contextMessage.text
        });
        addedContextIds.add(contextMessage.id);
      }
    }
  }

  return focusEntries;
}

/**
 * Parse one WhatsApp export file into the normalized chat record.
 */
export function parseWhatsAppFile(
  sourcePath: string,
  ownerNames: string[],
  options: { includeOtherContext: boolean; contextWindow: number }
): ChatRecord {
  // The normalized chat record keeps three layers at once:
  // 1. full parsed message roles
  // 2. optional context-only foreign messages
  // 3. a focus timeline centered on owner speech
  const content = readFileSync(sourcePath, "utf8");
  const messages = parseWhatsAppTranscript(content, ownerNames);
  const ownerMessages = messages.filter((message) => message.role === "owner");
  const contextMessages = messages.filter((message) => message.role === "other");
  const systemMessageCount = messages.filter((message) => message.role === "system").length;
  const timedMessages = messages.filter(
    (message): message is ChatMessage & { timestampUnix: number } => message.timestampUnix !== null
  );
  const startMessage = timedMessages[0] ?? null;
  const endMessage = timedMessages[timedMessages.length - 1] ?? null;
  const participantNames = Array.from(
    new Set(messages.filter((message) => message.role !== "system").map((message) => message.author))
  ).sort((left, right) => left.localeCompare(right));

  const parsedPath = path.parse(sourcePath);
  const slug = slugify(parsedPath.name);

  return {
    id: `chat:${slug}`,
    sourceKind: "chat",
    sourcePath,
    slug,
    title: parsedPath.name,
    ownerNames,
    participantNames,
    startTime: startMessage?.timestamp ?? null,
    startTimeUnix: startMessage?.timestampUnix ?? null,
    endTime: endMessage?.timestamp ?? null,
    endTimeUnix: endMessage?.timestampUnix ?? null,
    messageCount: messages.length,
    ownerMessageCount: ownerMessages.length,
    otherMessageCount: contextMessages.length,
    systemMessageCount,
    messages,
    ownerMessages,
    contextMessages: options.includeOtherContext ? contextMessages : [],
    focusTimeline: buildFocusTimeline(messages, options)
  };
}
