import test from "node:test";
import assert from "node:assert/strict";

import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import { buildThoughtBatchPrompt } from "./prompt.js";
import type { ThoughtCompilerBatch } from "./types.js";

function createBatch(): ThoughtCompilerBatch {
  return {
    batchId: "batch-0001",
    batchIndex: 1,
    estimatedInputTokens: 120,
    items: [
      {
        inputId: "writing:synthetic-measurement:paragraph:1",
        documentId: "writing:synthetic-measurement",
        sourceKind: "writing",
        documentTitle: "Syntetická poznámka o měření",
        chronologyIndex: 0,
        time: "2015-12-27T00:00:00.000Z",
        segmentLabel: "Paragraph 1",
        text: "Přesnost měření závisí na kalibraci a známých mezích senzoru.",
        textPreview: "Přesnost měření závisí na kalibraci a známých mezích senzoru.",
        estimatedTokens: 40
      }
    ]
  };
}

test("buildThoughtBatchPrompt requires Czech natural-language output", () => {
  const prompt = buildThoughtBatchPrompt(createBatch());

  assert.match(prompt, /v jazyce Czech \(cs\)/);
  assert.match(prompt, /Nepřekládej uživatelovo myšlení do angličtiny/);
  assert.match(prompt, new RegExp(SECOND_BRAIN_DEFAULTS.language.output));
  assert.match(prompt, /documentFrameId/);
  assert.match(prompt, /documentFrameHint/);
  assert.match(prompt, /frameRole/);
});

test("buildThoughtBatchPrompt decomposes reflective conversation turns without inflating noise", () => {
  const batch = createBatch();
  batch.items[0] = {
    ...batch.items[0],
    inputId: "conversation:test:turn:user-1",
    documentId: "conversation:test",
    sourceKind: "conversation",
    segmentLabel: "User turn 1"
  };

  const prompt = buildThoughtBatchPrompt(batch);

  assert.match(prompt, /delších reflektivních conversation turnů/);
  assert.match(prompt, /více nezávislých trvalých signálů/);
  assert.match(prompt, /velmi dlouhého reflektivního turnu/);
  assert.match(prompt, /provozní pokyny/);
  assert.match(prompt, /Stručnou explicitní otázku nebo korekci/);
  assert.match(prompt, /centrální diagnózu threadu/);
  assert.match(prompt, /jednu vývojovou linii/);
});
