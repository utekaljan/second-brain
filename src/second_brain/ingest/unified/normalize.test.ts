import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseWhatsAppFile } from "../chats/whatsapp.js";
import { parseOpenAIConversation } from "../conversations/openai.js";
import { parseWritingFile } from "../writings/normalize.js";
import { buildUnifiedCorpus } from "./normalize.js";

const DEFAULT_OPTIONS = {
  ownerNames: ["Alex"],
  includeOtherContext: true,
  includeAssistantContext: true,
  includeToolContext: false,
  contextWindow: 1
};

test("buildUnifiedCorpus turns writings into paragraph-level primary segments", () => {
  // The compiler should see authored texts as paragraph-level thought units,
  // while the document still keeps the full essay body for broader context.
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "second-brain-unified-writing-"));
  const sourcePath = path.join(tempDir, "esej_01_20_2024.txt");

  try {
    writeFileSync(sourcePath, "Moje esej\n\nPrvní odstavec.\n\nDruhý odstavec.", "utf8");
    const writing = parseWritingFile(sourcePath);
    const corpus = buildUnifiedCorpus(
      {
        writings: [writing],
        conversations: [],
        chats: []
      },
      DEFAULT_OPTIONS
    );

    assert.equal(corpus.documents.length, 1);
    assert.equal(corpus.stats.segmentCount, 2);
    assert.equal(corpus.documents[0]?.primaryText, "Moje esej\n\nPrvní odstavec.\n\nDruhý odstavec.");
    assert.deepEqual(
      corpus.segments.map((segment) => segment.segmentKind),
      ["writing_paragraph", "writing_paragraph"]
    );
    assert.deepEqual(
      corpus.segments.map((segment) => segment.text),
      ["První odstavec.", "Druhý odstavec."]
    );
    assert.equal(corpus.primaryTimeline[0]?.timePrecision, "day");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildUnifiedCorpus merges writings, chats, and conversations into one chronology", () => {
  // This locks the main contract of the final normalization phase: one shared
  // chronology where authored text, chat speech, and OpenAI turns can be
  // processed uniformly without losing primary-vs-context distinctions.
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "second-brain-unified-mixed-"));
  const writingPath = path.join(tempDir, "teze_01_20_2024.txt");
  const chatPath = path.join(tempDir, "whatsapp.txt");

  try {
    writeFileSync(writingPath, "Teze\n\nMoje raná formulace.", "utf8");
    writeFileSync(
      chatPath,
      [
        "[21.01.2024 11:59:00] David: Kontext předem",
        "[21.01.2024 12:00:00] Alex: Tohle řeším já",
        "[21.01.2024 12:01:00] David: Kontext potom"
      ].join("\n"),
      "utf8"
    );

    const writing = parseWritingFile(writingPath);
    const chat = parseWhatsAppFile(chatPath, ["Alex"], {
      includeOtherContext: true,
      contextWindow: 1
    });
    const conversation = parseOpenAIConversation(
      "input/conversations/conversations-debug.json",
      {
        conversation_id: "conv-unified-1",
        title: "Unified chronology test",
        create_time: 1705921200,
        update_time: 1705921260,
        current_node: "assistant-1",
        mapping: {
          root: {
            id: "root",
            parent: null,
            children: ["user-1"],
            message: null
          },
          "user-1": {
            id: "user-1",
            parent: "root",
            children: ["assistant-1"],
            message: {
              id: "turn-user-1",
              author: { role: "user" },
              recipient: "all",
              create_time: 1705921210,
              content: { content_type: "text", parts: ["Pozdější otázka"] }
            }
          },
          "assistant-1": {
            id: "assistant-1",
            parent: "user-1",
            children: [],
            message: {
              id: "turn-assistant-1",
              author: { role: "assistant" },
              recipient: "all",
              create_time: 1705921250,
              content: { content_type: "text", parts: ["Pozdější odpověď"] }
            }
          }
        }
      },
      {
        includeAssistantContext: true,
        includeToolContext: false,
        contextWindow: 1
      }
    );

    const corpus = buildUnifiedCorpus(
      {
        writings: [writing],
        conversations: [conversation],
        chats: [chat]
      },
      DEFAULT_OPTIONS
    );

    assert.equal(corpus.stats.documentCount, 3);
    assert.deepEqual(corpus.stats.documentsBySourceKind, {
      writing: 1,
      conversation: 1,
      chat: 1
    });
    assert.equal(corpus.stats.primarySegmentCount, 3);
    assert.equal(corpus.stats.contextSegmentCount, 3);
    assert.deepEqual(
      corpus.primaryTimeline.map((entry) => entry.sourceKind),
      ["writing", "chat", "conversation"]
    );
    assert.deepEqual(
      corpus.segments.filter((segment) => segment.signalKind === "context").map((segment) => segment.segmentKind),
      ["conversation_assistant_context", "chat_context_message", "chat_context_message"]
    );
    assert.equal(corpus.documents.find((document) => document.sourceKind === "chat")?.contextText?.includes("Kontext"), true);
    assert.equal(
      corpus.segments.find((segment) => segment.segmentKind === "conversation_user_turn")?.sourceRef.turnId,
      "turn-user-1"
    );
    assert.equal(
      corpus.segments.find((segment) => segment.segmentKind === "chat_owner_message")?.sourceRef.messageId,
      "msg-2"
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
