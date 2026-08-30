import path from "node:path";
import { existsSync } from "node:fs";

// A single path registry keeps the pipeline deterministic and avoids path
// strings being redefined ad hoc across discovery, normalization, and export.
/**
 * Repository path registry used across discovery, normalization, export, and reset flows.
 */
export type ProjectPaths = {
  root: string;
  inputDir: string;
  conversationsDir: string;
  writingsDir: string;
  chatsDir: string;
  outputDir: string;
  normalizedDir: string;
  compiledDir: string;
  normalizedConversationsDir: string;
  normalizedWritingsDir: string;
  normalizedChatsDir: string;
  normalizedUnifiedDir: string;
  manifestsDir: string;
  wikiDir: string;
  wikiThoughtsDir: string;
  wikiQuestionsDir: string;
  wikiThesesDir: string;
  wikiThreadsDir: string;
  wikiThemesDir: string;
  wikiTensionsDir: string;
  wikiChronologyDir: string;
  wikiReferencesDir: string;
  wikiIndexesDir: string;
  exportsDir: string;
  exportsMergedDir: string;
  exportsGptDir: string;
  siteDir: string;
  siteAssetsDir: string;
  stateDir: string;
  stateRunsDir: string;
  stateHashesDir: string;
  stateCheckpointsDir: string;
  stateAuditsDir: string;
};

/**
 * Walk upward from the current directory until the repository root is found.
 */
export function findProjectRoot(start: string = process.cwd()): string {
  // The root is defined by the public package plus the input directory.
  // Walking upward makes CLI commands work from nested directories as well.
  let current = path.resolve(start);

  while (true) {
    const hasPackageJson = existsSync(path.join(current, "package.json"));
    const hasInput = existsSync(path.join(current, "input"));

    if (hasPackageJson && hasInput) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Could not locate project root from current working directory.");
    }

    current = parent;
  }
}

/**
 * Build the full path registry from the resolved repository root.
 */
export function getProjectPaths(start?: string): ProjectPaths {
  // Derived directories are computed in one place so future refactors only
  // require changes here and not across every pipeline step.
  const root = findProjectRoot(start);
  const inputDir = path.join(root, "input");
  const outputDir = path.join(root, "output");
  const normalizedDir = path.join(outputDir, "normalized");
  const compiledDir = path.join(outputDir, "compiled");
  const wikiDir = path.join(outputDir, "wiki");
  const exportsDir = path.join(outputDir, "exports");
  const siteDir = path.join(outputDir, "site");
  const stateDir = path.join(outputDir, "state");

  return {
    root,
    inputDir,
    conversationsDir: path.join(inputDir, "conversations"),
    writingsDir: path.join(inputDir, "writings"),
    chatsDir: path.join(inputDir, "chats"),
    outputDir,
    normalizedDir,
    compiledDir,
    normalizedConversationsDir: path.join(normalizedDir, "conversations"),
    normalizedWritingsDir: path.join(normalizedDir, "writings"),
    normalizedChatsDir: path.join(normalizedDir, "chats"),
    normalizedUnifiedDir: path.join(normalizedDir, "unified"),
    manifestsDir: path.join(outputDir, "manifests"),
    wikiDir,
    wikiThoughtsDir: path.join(wikiDir, "thoughts"),
    wikiQuestionsDir: path.join(wikiDir, "questions"),
    wikiThesesDir: path.join(wikiDir, "theses"),
    wikiThreadsDir: path.join(wikiDir, "threads"),
    wikiThemesDir: path.join(wikiDir, "themes"),
    wikiTensionsDir: path.join(wikiDir, "tensions"),
    wikiChronologyDir: path.join(wikiDir, "chronology"),
    wikiReferencesDir: path.join(wikiDir, "references"),
    wikiIndexesDir: path.join(wikiDir, "indexes"),
    exportsDir,
    exportsMergedDir: path.join(exportsDir, "merged"),
    exportsGptDir: path.join(exportsDir, "gpt"),
    siteDir,
    siteAssetsDir: path.join(siteDir, "assets"),
    stateDir,
    stateRunsDir: path.join(stateDir, "runs"),
    stateHashesDir: path.join(stateDir, "hashes"),
    stateCheckpointsDir: path.join(stateDir, "checkpoints"),
    stateAuditsDir: path.join(stateDir, "audits")
  };
}

/**
 * Rebase generated artifacts onto another output directory while preserving
 * repository inputs. This keeps source runs read-only when
 * a deterministic renderer needs to materialize a separate presentation layer.
 */
export function withOutputDir(paths: ProjectPaths, outputDirValue: string): ProjectPaths {
  const outputDir = path.isAbsolute(outputDirValue)
    ? path.normalize(outputDirValue)
    : path.resolve(paths.root, outputDirValue);
  const normalizedDir = path.join(outputDir, "normalized");
  const compiledDir = path.join(outputDir, "compiled");
  const wikiDir = path.join(outputDir, "wiki");
  const exportsDir = path.join(outputDir, "exports");
  const siteDir = path.join(outputDir, "site");
  const stateDir = path.join(outputDir, "state");

  return {
    ...paths,
    outputDir,
    normalizedDir,
    compiledDir,
    normalizedConversationsDir: path.join(normalizedDir, "conversations"),
    normalizedWritingsDir: path.join(normalizedDir, "writings"),
    normalizedChatsDir: path.join(normalizedDir, "chats"),
    normalizedUnifiedDir: path.join(normalizedDir, "unified"),
    manifestsDir: path.join(outputDir, "manifests"),
    wikiDir,
    wikiThoughtsDir: path.join(wikiDir, "thoughts"),
    wikiQuestionsDir: path.join(wikiDir, "questions"),
    wikiThesesDir: path.join(wikiDir, "theses"),
    wikiThreadsDir: path.join(wikiDir, "threads"),
    wikiThemesDir: path.join(wikiDir, "themes"),
    wikiTensionsDir: path.join(wikiDir, "tensions"),
    wikiChronologyDir: path.join(wikiDir, "chronology"),
    wikiReferencesDir: path.join(wikiDir, "references"),
    wikiIndexesDir: path.join(wikiDir, "indexes"),
    exportsDir,
    exportsMergedDir: path.join(exportsDir, "merged"),
    exportsGptDir: path.join(exportsDir, "gpt"),
    siteDir,
    siteAssetsDir: path.join(siteDir, "assets"),
    stateDir,
    stateRunsDir: path.join(stateDir, "runs"),
    stateHashesDir: path.join(stateDir, "hashes"),
    stateCheckpointsDir: path.join(stateDir, "checkpoints"),
    stateAuditsDir: path.join(stateDir, "audits")
  };
}
