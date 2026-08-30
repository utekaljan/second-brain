import test from "node:test";
import assert from "node:assert/strict";

import { buildFocusTimeline, parseWhatsAppTranscript } from "./whatsapp.js";

test("parseWhatsAppTranscript distinguishes owner, others, and system messages", () => {
  // This guards the most important identity rule in the repository: my own
  // speech must not be collapsed with everyone else's speech.
  const transcript = `
[01.11.2023 12:44:21] Taylor: Taylor vytvořil/a skupinu
[01.11.2023 12:44:54] Alex: Ahoj
[01.11.2023 12:45:00] Taylor: Nazdar
[01.11.2023 12:45:12] Alex: Tohle je moje myslenka
Pokračování stejné zprávy
`;

  const messages = parseWhatsAppTranscript(transcript, ["Alex"]);

  assert.equal(messages.length, 4);
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "owner");
  assert.equal(messages[2]?.role, "other");
  assert.equal(messages[3]?.text, "Tohle je moje myslenka\nPokračování stejné zprávy");
});

test("buildFocusTimeline can omit other participants entirely", () => {
  // The user explicitly asked for the option to drop friends' messages instead
  // of always keeping them in the thought graph.
  const transcript = `
[01.11.2023 12:44:54] Alex: Ahoj
[01.11.2023 12:45:00] Taylor: Nazdar
[01.11.2023 12:45:12] Alex: Tohle resim
`;

  const messages = parseWhatsAppTranscript(transcript, ["Alex"]);
  const focusTimeline = buildFocusTimeline(messages, {
    includeOtherContext: false,
    contextWindow: 1
  });

  assert.deepEqual(
    focusTimeline.map((entry) => entry.type),
    ["owner_message", "owner_message"]
  );
});

test("buildFocusTimeline can keep nearby other messages only as context", () => {
  // When context is enabled, foreign messages should stay secondary and sit
  // around the owner's message rather than replacing it as the focal unit.
  const transcript = `
[01.11.2023 12:44:54] Taylor: Kontext
[01.11.2023 12:45:00] Alex: Muj point
[01.11.2023 12:45:12] Taylor: Reakce
`;

  const messages = parseWhatsAppTranscript(transcript, ["Alex"]);
  const focusTimeline = buildFocusTimeline(messages, {
    includeOtherContext: true,
    contextWindow: 1
  });

  assert.deepEqual(
    focusTimeline.map((entry) => entry.type),
    ["context", "owner_message", "context"]
  );
});
