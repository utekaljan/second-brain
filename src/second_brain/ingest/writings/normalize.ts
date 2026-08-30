import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ProjectPaths } from "../../system/paths.js";
import type { WritingRecord } from "../../types/domain.js";
import { ThrottledProgressReporter, type ProgressWriter } from "../../utils/progress.js";
import { countWords, firstNonEmptyLine, slugify } from "../../utils/text.js";

// Writings use a single explicit filename convention:
// <label>_MM_DD_YYYY.<ext>
/**
 * Strict filename suffix used to encode the writing creation date.
 */
const WRITING_DATE_SUFFIX_PATTERN = /_(\d{2})_(\d{2})_(\d{4})$/;

function collectWritingPaths(baseDir: string): string[] {
  try {
    // Recursive collection lets the user organize essays in subfolders later
    // without changing the ingestion code.
    const entries = readdirSync(baseDir, { withFileTypes: true });
    const paths: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);

      if (entry.isDirectory()) {
        paths.push(...collectWritingPaths(fullPath));
        continue;
      }

      if (!entry.isFile() || entry.name === ".gitkeep") {
        continue;
      }

      const suffix = path.extname(entry.name).toLowerCase();
      if (suffix === ".txt" || suffix === ".md") {
        paths.push(fullPath);
      }
    }

    paths.sort((left, right) => left.localeCompare(right));
    return paths;
  } catch {
    return [];
  }
}

function stripDateSuffix(fileStem: string): string {
  const match = fileStem.match(WRITING_DATE_SUFFIX_PATTERN);
  if (!match) {
    return fileStem;
  }

  return fileStem.slice(0, match.index).replace(/[\s_,.-]+$/, "");
}

function parseWritingDate(fileStem: string): { sourceDate: string | null; sourceDateUnix: number | null } {
  const match = fileStem.match(WRITING_DATE_SUFFIX_PATTERN);
  if (!match) {
    return {
      sourceDate: null,
      sourceDateUnix: null
    };
  }

  const [, monthRaw, dayRaw, yearRaw] = match;
  const month = Number.parseInt(monthRaw, 10);
  const day = Number.parseInt(dayRaw, 10);
  const year = Number.parseInt(yearRaw, 10);

  if (
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return {
      sourceDate: null,
      sourceDateUnix: null
    };
  }

  const sourceDate = `${yearRaw}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const sourceDateUnix = Date.parse(`${sourceDate}T00:00:00Z`);

  if (Number.isNaN(sourceDateUnix)) {
    return {
      sourceDate: null,
      sourceDateUnix: null
    };
  }

  return {
    sourceDate,
    sourceDateUnix
  };
}

/**
 * Parse one writing source file into the normalized writing record.
 */
export function parseWritingFile(sourcePath: string): WritingRecord {
  // We preserve the full body because later compilation should be able to
  // trace thought-nodes back to the user's exact wording.
  const body = readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");
  const parsedPath = path.parse(sourcePath);
  const fileLabel = stripDateSuffix(parsedPath.name) || parsedPath.name;
  const { sourceDate, sourceDateUnix } = parseWritingDate(parsedPath.name);
  const title = firstNonEmptyLine(body) ?? parsedPath.name;
  const slug = slugify(fileLabel);

  return {
    id: `writing:${slug}`,
    sourceKind: "writing",
    sourcePath,
    slug,
    fileLabel,
    title,
    sourceDate,
    sourceDateUnix,
    lineCount: body.split("\n").length,
    wordCount: countWords(body),
    characterCount: body.length,
    body
  };
}

/**
 * Normalize all writing files and sort them chronologically when dated.
 */
export function normalizeWritings(
  paths: ProjectPaths,
  progress?: ProgressWriter
): WritingRecord[] {
  // Writings are currently normalized one-to-one: one source file becomes one
  // output record with light metadata and preserved body text.
  const sourcePaths = collectWritingPaths(paths.writingsDir);
  const reporter = new ThrottledProgressReporter(progress, 10);
  reporter.phase("ingest:writings", `reading ${sourcePaths.length} writing files`);

  const writings = sourcePaths.map((sourcePath, index) => {
    const record = parseWritingFile(sourcePath);
    reporter.item("ingest:writings", "writing-files", index + 1, sourcePaths.length, record.slug);
    return record;
  });

  // When a source date exists in the filename, keep essays ordered by that
  // date so later compiler stages can compare them against conversation time.
  writings.sort((left, right) => {
    const leftTime = left.sourceDateUnix ?? Number.MAX_SAFE_INTEGER;
    const rightTime = right.sourceDateUnix ?? Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return left.sourcePath.localeCompare(right.sourcePath);
  });

  reporter.phase("ingest:writings", `done: ${writings.length} normalized writing records`);

  return writings;
}

/**
 * Write the normalized writings bundle into output/normalized/writings/.
 */
export function writeNormalizedWritings(paths: ProjectPaths, writings: WritingRecord[]): string {
  // A single JSON bundle is enough for the current stage and easy to inspect.
  const target = path.join(paths.normalizedWritingsDir, "writings.json");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(writings, null, 2)}\n`, "utf8");
  return target;
}

/**
 * Build a shallow manifest of raw writing source files.
 */
export function buildWritingsManifest(paths: ProjectPaths): Record<string, unknown> {
  // This manifest is intentionally shallow: it tracks file presence and size,
  // while the normalized payload carries the heavier textual data.
  const sourceFiles = collectWritingPaths(paths.writingsDir);
  return {
    sourceDir: paths.writingsDir,
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
