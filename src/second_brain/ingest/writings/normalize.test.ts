import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseWritingFile } from "./normalize.js";

test("parseWritingFile uses first non-empty line as title", () => {
  // The first non-empty line is the current title heuristic, so this test
  // locks that behavior before later essay parsing gets more sophisticated.
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "second-brain-writing-"));
  const sourcePath = path.join(tempDir, "moje-esej.txt");

  try {
    writeFileSync(sourcePath, "\n\nMoje esej\n\nPrvni odstavec.\nDruhy odstavec.\n", "utf8");
    const writing = parseWritingFile(sourcePath);

    assert.equal(writing.title, "Moje esej");
    assert.equal(writing.slug, "moje-esej");
    assert.equal(writing.fileLabel, "moje-esej");
    assert.equal(writing.sourceKind, "writing");
    assert.ok(writing.wordCount >= 4);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parseWritingFile extracts source date from filename suffix", () => {
  // Essay filenames now carry creation dates, so the ingest should preserve
  // them explicitly for later chronology across writings and conversations.
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "second-brain-writing-date-"));
  const sourcePath = path.join(tempDir, "esej_01_20_2024.txt");

  try {
    writeFileSync(sourcePath, "Esej s datem\n\nText.", "utf8");
    const writing = parseWritingFile(sourcePath);

    assert.equal(writing.fileLabel, "esej");
    assert.equal(writing.slug, "esej");
    assert.equal(writing.sourceDate, "2024-01-20");
    assert.ok(writing.sourceDateUnix !== null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parseWritingFile ignores filenames that do not match the strict date suffix pattern", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "second-brain-writing-date-invalid-"));
  const sourcePath = path.join(tempDir, "esej_12 03, 2022.txt");

  try {
    writeFileSync(sourcePath, "Esej bez platneho patternu\n\nText.", "utf8");
    const writing = parseWritingFile(sourcePath);

    assert.equal(writing.fileLabel, "esej_12 03, 2022");
    assert.equal(writing.sourceDate, null);
    assert.equal(writing.sourceDateUnix, null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
