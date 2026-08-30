import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import type { ProjectPaths } from "./paths.js";

/**
 * Result of clearing generated artifacts during a debug reset.
 */
export type NukeResult = {
  removedFileCount: number;
  removedDist: boolean;
  clearedDirectories: string[];
};

const PRESERVED_FILENAMES = new Set([".gitkeep"]);

function clearDirectoryContents(directory: string): number {
  if (!existsSync(directory)) {
    return 0;
  }

  let removedFileCount = 0;
  const entries = readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      removedFileCount += clearDirectoryContents(fullPath);
      // Preserve only repo-owned scaffolds marked by .gitkeep. Ad hoc output
      // targets such as calibration runs must disappear completely on nuke.
      if (readdirSync(fullPath).length === 0) {
        rmSync(fullPath, { recursive: true, force: true });
      }
      continue;
    }

    if (PRESERVED_FILENAMES.has(entry.name)) {
      continue;
    }

    rmSync(fullPath, { force: true });
    removedFileCount += 1;
  }

  return removedFileCount;
}

/**
 * Remove generated artifacts while preserving raw inputs and scaffold files.
 */
export function nukeGeneratedArtifacts(paths: ProjectPaths): NukeResult {
  // Nuke is intentionally scoped to generated artifacts only. Raw inputs in
  // input/ are never touched by this command.
  const generatedDirectories = [paths.outputDir];

  let removedFileCount = 0;
  for (const directory of generatedDirectories) {
    removedFileCount += clearDirectoryContents(directory);
  }

  const distDir = path.join(paths.root, "dist");
  const removedDist = existsSync(distDir);
  if (removedDist) {
    // Build output is disposable and can be recreated by npm run build.
    rmSync(distDir, { recursive: true, force: true });
  }

  return {
    removedFileCount,
    removedDist,
    clearedDirectories: generatedDirectories
  };
}
