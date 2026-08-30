import type { ProjectPaths } from "../system/paths.js";
import type { ProgressWriter } from "../utils/progress.js";
import {
  renderMacroGptMarkdownExport,
  type MacroGptExportSummary
} from "./gpt_macro.js";

type UploadBudget = {
  maxMarkdownFiles: number;
  targetMaxBytesPerFile: number;
  hardMaxBytesPerFile: number;
};

/** Runtime options for the deterministic macro-map knowledge-pack export. */
export type GptExportOptions = {
  budget?: Partial<UploadBudget>;
  sourceOutputDir?: string;
  targetOutputDir?: string;
  macroMapPath?: string;
  progress?: ProgressWriter;
};

/** Small CLI summary for one GPT knowledge-pack render. */
export type GptExportSummary = MacroGptExportSummary;

/**
 * Render the single public GPT export format.
 *
 * The semantic pipeline must produce a macro map first. Keeping that
 * requirement explicit avoids silently falling back to a corpus-specific
 * area taxonomy when an artifact is missing.
 */
export function renderGptMarkdownExport(
  paths: ProjectPaths,
  options: GptExportOptions = {}
): GptExportSummary {
  return renderMacroGptMarkdownExport(paths, options);
}
