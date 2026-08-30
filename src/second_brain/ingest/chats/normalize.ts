import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ProjectPaths } from "../../system/paths.js";
import type { ChatRecord } from "../../types/domain.js";
import { ThrottledProgressReporter, type ProgressWriter } from "../../utils/progress.js";
import { parseWhatsAppFile } from "./whatsapp.js";

function collectChatPaths(baseDir: string): string[] {
  try {
    // Chats may later arrive from multiple folders or exports, so the
    // collector is recursive from the start.
    const entries = readdirSync(baseDir, { withFileTypes: true });
    const paths: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);

      if (entry.isDirectory()) {
        paths.push(...collectChatPaths(fullPath));
        continue;
      }

      if (!entry.isFile() || entry.name === ".gitkeep") {
        continue;
      }

      const suffix = path.extname(entry.name).toLowerCase();
      if (suffix === ".txt") {
        paths.push(fullPath);
      }
    }

    paths.sort((left, right) => left.localeCompare(right));
    return paths;
  } catch {
    return [];
  }
}

/**
 * Normalize all chat source files currently present in input/chats/.
 */
export function normalizeChats(
  paths: ProjectPaths,
  options: { ownerNames: string[]; includeOtherContext: boolean; contextWindow: number },
  progress?: ProgressWriter
): ChatRecord[] {
  // Each chat file is currently assumed to be a WhatsApp text export. If more
  // chat formats appear, dispatching by file type should happen here.
  const sourcePaths = collectChatPaths(paths.chatsDir);
  const reporter = new ThrottledProgressReporter(progress, 10);
  reporter.phase("ingest:chats", `reading ${sourcePaths.length} chat files`);

  const chats = sourcePaths.map((sourcePath, index) => {
    const record = parseWhatsAppFile(sourcePath, options.ownerNames, {
      includeOtherContext: options.includeOtherContext,
      contextWindow: options.contextWindow
    });
    reporter.item("ingest:chats", "chat-files", index + 1, sourcePaths.length, record.id);
    return record;
  });

  reporter.phase("ingest:chats", `done: ${chats.length} normalized chat records`);
  return chats;
}

/**
 * Write the normalized chat bundle into output/normalized/chats/.
 */
export function writeNormalizedChats(paths: ProjectPaths, chats: ChatRecord[]): string {
  // The normalized chat bundle is meant for inspection first, not for final
  // wiki presentation.
  const target = path.join(paths.normalizedChatsDir, "chats.json");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(chats, null, 2)}\n`, "utf8");
  return target;
}

/**
 * Build a shallow manifest of raw chat source files.
 */
export function buildChatsManifest(paths: ProjectPaths): Record<string, unknown> {
  // This manifest answers "which raw chat files were processed" separately
  // from the richer normalized payload.
  const sourceFiles = collectChatPaths(paths.chatsDir);
  return {
    sourceDir: paths.chatsDir,
    fileCount: sourceFiles.length,
    files: sourceFiles.map((sourcePath) => {
      const stats = statSync(sourcePath);
      return {
        path: sourcePath,
        sizeBytes: stats.size
      };
    })
  };
}
