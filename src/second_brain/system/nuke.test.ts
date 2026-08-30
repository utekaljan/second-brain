import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { nukeGeneratedArtifacts } from "./nuke.js";
import { getProjectPaths } from "./paths.js";

test("nukeGeneratedArtifacts removes generated artifacts and preserves input files", () => {
  // The command exists for implementation/debug cycles, so it must be safe to
  // wipe outputs without damaging the raw corpus.
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-nuke-"));

  try {
    writeFileSync(path.join(tempRoot, "package.json"), "{}\n", "utf8");
    mkdirSync(path.join(tempRoot, "input", "writings"), { recursive: true });
    mkdirSync(path.join(tempRoot, "output", "manifests"), { recursive: true });
    mkdirSync(path.join(tempRoot, "output", "normalized", "writings"), { recursive: true });
    mkdirSync(path.join(tempRoot, "output", "compiled"), { recursive: true });
    mkdirSync(path.join(tempRoot, "output", "wiki", "thoughts"), { recursive: true });
    mkdirSync(path.join(tempRoot, "output", "exports", "merged"), { recursive: true });
    mkdirSync(path.join(tempRoot, "output", "state", "runs"), { recursive: true });
    mkdirSync(path.join(tempRoot, "output", "macro_scaled_test", "state"), {
      recursive: true
    });
    mkdirSync(path.join(tempRoot, "dist", "second_brain"), { recursive: true });

    const inputPath = path.join(tempRoot, "input", "writings", "essay.txt");
    const manifestGitkeep = path.join(tempRoot, "output", "manifests", ".gitkeep");
    const manifestPath = path.join(tempRoot, "output", "manifests", "source_manifest.json");
    const normalizedPath = path.join(
      tempRoot,
      "output",
      "normalized",
      "writings",
      "writings.json"
    );
    const compiledPath = path.join(tempRoot, "output", "compiled", "thought_nodes.json");
    const wikiPath = path.join(tempRoot, "output", "wiki", "thoughts", "page.md");
    const customOutputPath = path.join(
      tempRoot,
      "output",
      "macro_scaled_test",
      "state",
      "checkpoint.json"
    );
    const distPath = path.join(tempRoot, "dist", "second_brain", "cli.js");

    writeFileSync(inputPath, "Moje esej", "utf8");
    writeFileSync(manifestGitkeep, "", "utf8");
    writeFileSync(manifestPath, "{}", "utf8");
    writeFileSync(normalizedPath, "[]", "utf8");
    writeFileSync(compiledPath, "[]", "utf8");
    writeFileSync(wikiPath, "# Page", "utf8");
    writeFileSync(customOutputPath, "{}", "utf8");
    writeFileSync(distPath, "console.log('compiled');", "utf8");

    const paths = getProjectPaths(tempRoot);
    const result = nukeGeneratedArtifacts(paths);

    assert.equal(readFileSync(inputPath, "utf8"), "Moje esej");
    assert.equal(existsSync(manifestPath), false);
    assert.equal(existsSync(normalizedPath), false);
    assert.equal(existsSync(compiledPath), false);
    assert.equal(existsSync(wikiPath), false);
    assert.equal(existsSync(path.join(tempRoot, "output", "macro_scaled_test")), false);
    assert.equal(existsSync(distPath), false);
    assert.equal(existsSync(manifestGitkeep), true);
    assert.deepEqual(result.clearedDirectories, [paths.outputDir]);
    assert.equal(result.removedDist, true);
    assert.ok(result.removedFileCount >= 5);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
