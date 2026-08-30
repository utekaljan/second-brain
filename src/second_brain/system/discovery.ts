import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ProjectPaths } from "./paths.js";

// Discovery only answers "what raw files exist right now"; it does not try to
// interpret meaning yet.
/**
 * Raw source categories discovered directly from input/.
 */
export type SourceType = "conversation_export" | "writing" | "chat";

export type SourceFile = {
  sourceType: SourceType;
  path: string;
  suffix: string;
  sizeBytes: number;
};

export type SourceManifest = {
  root: string;
  inputs: {
    conversationsDir: string;
    writingsDir: string;
    chatsDir: string;
  };
  counts: {
    conversations: number;
    writings: number;
    chats: number;
  };
  sources: {
    conversations: SourceFile[];
    writings: SourceFile[];
    chats: SourceFile[];
  };
};

function collectFiles(baseDir: string, sourceType: SourceType, suffixes: string[]): SourceFile[] {
  try {
    // Recursive scanning is kept intentionally small and inspectable instead of
    // hiding this behavior behind a framework abstraction.
    const entries = readdirSync(baseDir, { withFileTypes: true });
    const files: SourceFile[] = [];

    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);

      if (entry.isDirectory()) {
        files.push(...collectFiles(fullPath, sourceType, suffixes));
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (entry.name === ".gitkeep") {
        // Placeholder files are repo scaffolding, not real source material.
        continue;
      }

      const suffix = path.extname(entry.name).toLowerCase();
      if (!suffixes.includes(suffix)) {
        continue;
      }

      files.push({
        sourceType,
        path: fullPath,
        suffix,
        sizeBytes: statSync(fullPath).size
      });
    }

    files.sort((left, right) => left.path.localeCompare(right.path));
    return files;
  } catch {
    return [];
  }
}

/**
 * Scan input/ and build a raw source manifest without interpreting content.
 */
export function buildManifest(paths: ProjectPaths): SourceManifest {
  // Each source type is counted separately because the repository explicitly
  // distinguishes writings, chats, and conversation exports.
  const conversations = collectFiles(paths.conversationsDir, "conversation_export", [".json"]);
  const writings = collectFiles(paths.writingsDir, "writing", [".txt", ".md"]);
  const chats = collectFiles(paths.chatsDir, "chat", [".json", ".txt", ".md"]);

  return {
    root: paths.root,
    inputs: {
      conversationsDir: paths.conversationsDir,
      writingsDir: paths.writingsDir,
      chatsDir: paths.chatsDir
    },
    counts: {
      conversations: conversations.length,
      writings: writings.length,
      chats: chats.length
    },
    sources: {
      conversations,
      writings,
      chats
    }
  };
}

/**
 * Persist the current raw source manifest to output/manifests/.
 */
export function writeManifest(paths: ProjectPaths, manifest: SourceManifest): string {
  // The manifest is a stable snapshot of inputs for debugging and later change
  // detection.
  const target = path.join(paths.manifestsDir, "source_manifest.json");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return target;
}
