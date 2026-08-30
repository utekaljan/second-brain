import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import { loadThoughtCompilationArtifacts } from "../compiler/consolidate.js";
import type {
  ConsolidatedThoughtEdge,
  ConsolidatedThoughtGraph,
  ConsolidatedThoughtNode,
  ThoughtClaim,
  ThoughtCompilationArtifacts,
  ThoughtDocumentFrame,
  ThoughtDocumentOutline,
  ThoughtDocumentOutlineRole,
  ThoughtDocumentSubframe,
  ThoughtFrameAlignmentArtifact,
  ThoughtFrameAlignmentFamily,
  ThoughtHigherOrderPattern,
  ThoughtNodeState,
  ThoughtNodeStatus,
  ThoughtNodeType,
  ThoughtRelationType,
  ThoughtWorldline
} from "../compiler/types.js";
import type {
  ThoughtMacroConstellation,
  ThoughtMacroMapArtifact,
  ThoughtMacroTrajectory
} from "../structure/macro_map.js";
import { withOutputDir, type ProjectPaths } from "../system/paths.js";
import type {
  SourceKind,
  UnifiedCorpus,
  UnifiedDocument,
  UnifiedSegment,
  UnifiedSourceRef
} from "../types/domain.js";
import { slugify } from "../utils/text.js";
import { ThrottledProgressReporter, type ProgressWriter } from "../utils/progress.js";

const THOUGHT_CONSOLIDATION_DEFAULTS = SECOND_BRAIN_DEFAULTS.thoughtConsolidation;
const THOUGHT_COMPILER_DEFAULTS = SECOND_BRAIN_DEFAULTS.thoughtCompiler;
const MAX_VERTICAL_FILENAME_STEM_LENGTH = 120;
const INVENTORY_PAGE_SIZE = 200;
const THOUGHT_AUDIT_LIMITS = {
  sourceDocuments: 24,
  localFrames: 24,
  verticalItems: 24,
  relationships: 60,
  claims: 40,
  sourcePassages: 24,
  states: 32,
  compilerItems: 32
} as const;

type ThoughtPageInfo = {
  node: ConsolidatedThoughtNode;
  targetPath: string;
  relativePath: string;
};

type WikiPageKind = "index" | "thought" | "reference" | "constellation" | "trajectory";

type MacroPageInfo<T> = {
  item: T;
  targetPath: string;
  relativePath: string;
};

type ReferencePageInfo = {
  document: UnifiedDocument;
  targetPath: string;
  relativePath: string;
};

type ThoughtPageClaimView = {
  claim: ThoughtClaim;
  excerpt: string;
  sourceLink: string;
  referenceLink: string;
  isCurrent: boolean;
};

type RenderedWikiFile = {
  title: string;
  kind: WikiPageKind;
  targetPath: string;
  relativePath: string;
  summary: string;
  nodeType?: ThoughtNodeType;
  nodeId?: string;
  documentId?: string;
  contents: string;
};

type ValidationWikiInputs = {
  sourcePaths: ProjectPaths;
  sourceCorpusPath: string;
  corpus: UnifiedCorpus;
  compilation: ThoughtCompilationArtifacts;
  consolidatedGraph: ConsolidatedThoughtGraph;
  frameAlignment: ThoughtFrameAlignmentArtifact | null;
  macroMap: ThoughtMacroMapArtifact | null;
};

type ValidationWikiManifestPage = {
  title: string;
  path: string;
  kind: WikiPageKind;
  summary: string;
  nodeType?: ThoughtNodeType;
  nodeId?: string;
  documentId?: string;
};

type ValidationWikiManifest = {
  generatedAt: string;
  sourceRunId: string;
  sourceCorpusPath: string;
  sourceGraphPath: string;
  pageCount: number;
  thoughtPageCount: number;
  referencePageCount: number;
  indexPageCount: number;
  pages: ValidationWikiManifestPage[];
};

type ValidationWikiSearchEntry = {
  id: string;
  title: string;
  path: string;
  kind: WikiPageKind;
  summary: string;
  nodeType?: ThoughtNodeType;
  nodeStatus?: ThoughtNodeStatus;
  documentId?: string;
  aliases?: string[];
  keywords: string[];
};

type ValidationWikiArtifacts = {
  files: RenderedWikiFile[];
  manifest: ValidationWikiManifest;
  searchIndex: ValidationWikiSearchEntry[];
};

type VerticalFramePageInfo = {
  id: string;
  label: string;
  targetPath: string;
  relativePath: string;
  kind: "frame" | "subframe";
};

type VerticalOutlinePageInfo = {
  documentId: string;
  label: string;
  sourceKind: SourceKind;
  targetPath: string;
  relativePath: string;
};

/**
 * Small CLI summary for one wiki render.
 *
 * The markdown wiki is the first human-validation surface above the compiled
 * graph, so the summary keeps the main counts and output paths easy to inspect.
 */
export type ValidationWikiRenderSummary = {
  generatedAt: string;
  sourceRunId: string;
  sourceCorpusPath: string;
  consolidatedNodeCount: number;
  consolidatedEdgeCount: number;
  thoughtPageCount: number;
  referencePageCount: number;
  indexPageCount: number;
  pageCount: number;
  indexPath: string;
  manifestPath: string;
  searchIndexPath: string;
};

const TYPE_DESCRIPTIONS: Record<
  ThoughtNodeType,
  { singular: string; plural: string; description: string; directory: (paths: ProjectPaths) => string }
> = {
  thesis: {
    singular: "Teze",
    plural: "Teze",
    description: "Stabilnější formulace uživatelových postojů a závěrů.",
    directory: (paths) => paths.wikiThesesDir
  },
  question: {
    singular: "Otázka",
    plural: "Otázky",
    description: "Opakující se otázky a problémy, ke kterým se myšlení vrací.",
    directory: (paths) => paths.wikiQuestionsDir
  },
  theme: {
    singular: "Téma",
    plural: "Témata",
    description: "Širší tematické clustery, které spojují více příbuzných linek.",
    directory: (paths) => paths.wikiThemesDir
  },
  tension: {
    singular: "Tenze",
    plural: "Tenze",
    description: "Vnitřní napětí, rozpory nebo explicitně neuzavřené konflikty mezi pozicemi.",
    directory: (paths) => paths.wikiTensionsDir
  },
  thread: {
    singular: "Vlákno",
    plural: "Vlákna",
    description: "Vývojové linie, které se skládají přes více dokumentů a časových bodů.",
    directory: (paths) => paths.wikiThreadsDir
  }
};

const RELATION_LABELS: Record<ThoughtRelationType, string> = {
  co_occurs: "spoluvýskyt",
  semantic_related: "sémantická blízkost",
  supports: "podpora",
  tensions_with: "tenze",
  revises: "revize",
  supersedes: "nahrazení",
  context_split: "kontextové rozdělení"
};

const STATUS_LABELS: Record<ThoughtNodeStatus, string> = {
  active: "aktivní",
  tentative: "pracovní",
  unresolved: "neuzavřené",
  revised: "revidované"
};

function readJsonFile<T>(target: string): T {
  return JSON.parse(readFileSync(target, "utf8")) as T;
}

function replacePathSeparators(value: string): string {
  return value.split(path.sep).join("/");
}

function formatDate(value: string | null): string {
  return value ? value.slice(0, 10) : "neznamé";
}

function compareDates(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left.localeCompare(right);
}

function compareLocators(left: string, right: string): number {
  const [leftKind, leftIndexRaw] = left.split(":");
  const [rightKind, rightIndexRaw] = right.split(":");

  if (leftKind !== rightKind) {
    return left.localeCompare(right);
  }

  const leftIndex = Number.parseInt(leftIndexRaw ?? "", 10);
  const rightIndex = Number.parseInt(rightIndexRaw ?? "", 10);
  if (Number.isFinite(leftIndex) && Number.isFinite(rightIndex)) {
    return leftIndex - rightIndex;
  }

  return left.localeCompare(right);
}

function markdownLink(label: string, relativePath: string): string {
  return `[${label}](${relativePath})`;
}

function formatCzechCount(
  count: number,
  forms: { one: string; few: string; many: string }
): string {
  const absolute = Math.abs(count);
  const mod100 = absolute % 100;
  const mod10 = absolute % 10;
  const noun = absolute === 1
    ? forms.one
    : mod100 >= 12 && mod100 <= 14
      ? forms.many
      : mod10 >= 2 && mod10 <= 4
        ? forms.few
        : forms.many;
  return `${count} ${noun}`;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function blockquote(text: string): string {
  return text
    .replace(
      /\[(?:real_time_user_audio_video_asset_pointer|audio_video_asset_pointer|audio_transcription)\]/gi,
      " "
    )
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `> ${line}`)
    .join("\n");
}

function boundedExcerpt(text: string, maxLength = 1200): string {
  const normalized = text.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const boundary = normalized.lastIndexOf(" ", maxLength);
  const end = boundary > Math.floor(maxLength * 0.7) ? boundary : maxLength;
  return `${normalized.slice(0, end).trimEnd()}…`;
}

function relativeLink(fromTarget: string, toTarget: string): string {
  return replacePathSeparators(path.relative(path.dirname(fromTarget), toTarget));
}

function wikiRelativePath(paths: ProjectPaths, target: string): string {
  return replacePathSeparators(path.relative(paths.wikiDir, target));
}

function sourceRefKey(sourceRef: UnifiedSourceRef): string {
  return [
    sourceRef.sourceKind,
    sourceRef.documentId,
    sourceRef.sourcePath,
    sourceRef.sourceItemId ?? "",
    sourceRef.locator
  ].join("|");
}

function resolveSourceDocumentPath(sourcePaths: ProjectPaths, sourcePath: string): string {
  if (existsSync(sourcePath)) {
    return sourcePath;
  }
  const normalized = replacePathSeparators(sourcePath);
  const inputMarker = "/input/";
  const markerIndex = normalized.lastIndexOf(inputMarker);
  if (markerIndex !== -1) {
    const relativeInputPath = normalized.slice(markerIndex + inputMarker.length);
    const frozenCandidate = path.join(
      path.dirname(sourcePaths.outputDir),
      "input",
      ...relativeInputPath.split("/")
    );
    if (existsSync(frozenCandidate)) {
      return frozenCandidate;
    }
  }
  return sourcePath;
}

function formatSourceKind(kind: SourceKind): string {
  switch (kind) {
    case "writing":
      return "writing";
    case "conversation":
      return "conversation";
    case "chat":
      return "chat";
  }
}

function signalMixSummary(signalBySourceKind: Record<SourceKind, number>): string {
  return (Object.entries(signalBySourceKind) as Array<[SourceKind, number]>)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([kind, count]) => `${formatSourceKind(kind)} ${count}`)
    .join(", ");
}

function thoughtPageFilename(node: ConsolidatedThoughtNode): string {
  return `${slugify(node.canonicalKey || node.title || node.id)}.md`;
}

function macroPageFilename(item: { id: string; title: string }): string {
  return `${slugify(item.title || item.id)}.md`;
}

function macroRoleLabel(role: ThoughtMacroConstellation["atlasRole"]): string {
  switch (role) {
    case "core_direction":
      return "hlavní směr";
    case "active_exploration":
      return "aktivní zkoumání";
    case "supporting_context":
      return "podpůrný kontext";
  }
}

function macroMemberRoleLabel(role: ThoughtMacroConstellation["members"][number]["role"]): string {
  switch (role) {
    case "core":
      return "jádro";
    case "supporting":
      return "opora";
    case "context":
      return "kontext";
  }
}

function verticalFamilyFilename(family: ThoughtFrameAlignmentFamily): string {
  return boundedVerticalFilename("family", family.label || family.id, family.id);
}

function verticalPatternFilename(pattern: ThoughtHigherOrderPattern): string {
  return boundedVerticalFilename("pattern", pattern.label || pattern.id, pattern.id);
}

function referencePageFilename(document: UnifiedDocument): string {
  return `${slugify(`${document.sourceKind}-${document.id}`)}.md`;
}

function verticalOutlineFilename(outline: ThoughtDocumentOutline): string {
  return boundedVerticalFilename(outline.sourceKind, outline.label || outline.documentId, outline.id);
}

function referenceAnchorId(locator: string): string {
  return `ref-${slugify(locator)}`;
}

function dedupeByKey<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function previewJoined(items: string[], limit: number): string {
  if (items.length <= limit) {
    return items.join(", ");
  }

  const visible = items.slice(0, limit);
  return `${visible.join(", ")} a ${items.length - limit} dalších`;
}

function relationPriority(type: ThoughtRelationType): number {
  switch (type) {
    case "revises":
      return 0;
    case "supersedes":
      return 1;
    case "supports":
      return 2;
    case "tensions_with":
      return 3;
    case "semantic_related":
      return 4;
    case "co_occurs":
      return 5;
    case "context_split":
      return 6;
  }
}

function summarizeRelationTypes(types: ThoughtRelationType[]): string {
  const ordered = [...new Set(types)].sort(
    (left, right) => relationPriority(left) - relationPriority(right)
  );
  return ordered.map((type) => RELATION_LABELS[type]).join(", ");
}

function validateMacroMap(
  macroMap: ThoughtMacroMapArtifact,
  consolidatedGraph: ConsolidatedThoughtGraph,
  consolidatedGraphText: string
): void {
  const graphNodeIds = new Set(consolidatedGraph.nodes.map((node) => node.id));
  const referencedNodeIds = new Set([
    ...macroMap.constellations.flatMap((constellation) => constellation.memberNodeIds),
    ...macroMap.trajectories.flatMap((trajectory) => [
      ...trajectory.stages.flatMap((stage) => stage.nodeIds),
      ...trajectory.currentPositionNodeIds,
      ...trajectory.openTensionNodeIds
    ]),
    ...macroMap.currentPositions.map((item) => item.nodeId),
    ...macroMap.openQuestions.map((item) => item.nodeId),
    ...macroMap.openTensions.map((item) => item.nodeId)
  ]);
  const missingNodeIds = Array.from(referencedNodeIds).filter((nodeId) => !graphNodeIds.has(nodeId));
  const graphHash = createHash("sha256").update(consolidatedGraphText).digest("hex");

  if (macroMap.sourceNodeCount !== consolidatedGraph.nodeCount) {
    throw new Error(
      `Macro map expects ${macroMap.sourceNodeCount} nodes, but the consolidated graph has ${consolidatedGraph.nodeCount}.`
    );
  }
  if (macroMap.sourceConsolidatedGraphHash !== graphHash) {
    throw new Error("Macro map source hash does not match the selected consolidated graph.");
  }
  if (missingNodeIds.length > 0) {
    throw new Error(
      `Macro map references ${missingNodeIds.length} nodes missing from the selected consolidated graph.`
    );
  }
}

function loadValidationWikiInputs(
  paths: ProjectPaths,
  macroMapPath?: string
): ValidationWikiInputs {
  const consolidatedGraphPath = path.join(
    paths.compiledDir,
    THOUGHT_CONSOLIDATION_DEFAULTS.compiledGraphFilename
  );
  const frameAlignmentPath = path.join(
    paths.compiledDir,
    SECOND_BRAIN_DEFAULTS.thoughtFrameAlignment.compiledArtifactFilename
  );

  if (!existsSync(consolidatedGraphPath)) {
    throw new Error(
      `Missing consolidated thought graph at ${consolidatedGraphPath}. Run consolidate-thought-graph first.`
    );
  }

  const compilation = loadThoughtCompilationArtifacts(paths);
  const consolidatedGraphText = readFileSync(consolidatedGraphPath, "utf8");
  const consolidatedGraph = JSON.parse(consolidatedGraphText) as ConsolidatedThoughtGraph;
  const localCorpusPath = path.join(paths.normalizedUnifiedDir, "corpus.json");
  const sourceCorpusPath = existsSync(localCorpusPath)
    ? localCorpusPath
    : compilation.graph.sourceCorpusPath;

  if (!existsSync(sourceCorpusPath)) {
    throw new Error(
      `Missing source corpus at ${sourceCorpusPath}. Re-run unified normalization before rendering the wiki.`
    );
  }

  const corpus = readJsonFile<UnifiedCorpus>(sourceCorpusPath);
  const macroMap = macroMapPath && existsSync(macroMapPath)
    ? readJsonFile<ThoughtMacroMapArtifact>(macroMapPath)
    : null;
  if (macroMap) {
    validateMacroMap(macroMap, consolidatedGraph, consolidatedGraphText);
  }
  return {
    sourcePaths: paths,
    sourceCorpusPath,
    corpus,
    compilation,
    consolidatedGraph,
    frameAlignment: existsSync(frameAlignmentPath)
      ? readJsonFile<ThoughtFrameAlignmentArtifact>(frameAlignmentPath)
      : null,
    macroMap
  };
}

function buildTypeCounts(nodes: ConsolidatedThoughtNode[]): Record<ThoughtNodeType, number> {
  return nodes.reduce(
    (counts, node) => {
      counts[node.nodeType] += 1;
      return counts;
    },
    {
      thesis: 0,
      question: 0,
      theme: 0,
      tension: 0,
      thread: 0
    } satisfies Record<ThoughtNodeType, number>
  );
}

function formatFrameKind(kind: "frame" | "subframe"): string {
  return kind === "frame" ? "hlavní rámec" : "podrámec";
}

function formatFrameScope(scope: string): string {
  return scope === "document" ? "celý dokument" : scope === "section" ? "část dokumentu" : scope;
}

function formatFrameRole(role: string | null): string {
  if (role === null) {
    return "";
  }
  return role === "main_claim"
    ? "hlavní formulace"
    : role === "subclaim"
      ? "dílčí formulace"
      : role === "question"
        ? "otázka"
        : role === "tension"
          ? "tenze"
          : role === "revision_branch"
            ? "revizní větev"
            : role;
}

function formatOutlineRole(role: ThoughtDocumentOutlineRole): string {
  switch (role) {
    case "opening":
      return "otevření";
    case "development":
      return "rozvinutí";
    case "branch":
      return "větev";
    case "return":
      return "návrat";
    case "conclusion":
      return "závěr";
  }
}

function formatSourceLocalContainerNoun(sourceKind: SourceKind): string {
  return sourceKind === "conversation" ? "thread" : "text";
}

function formatSequenceRange(start: number, end: number, sourceKind: SourceKind): string {
  const singular = sourceKind === "conversation" ? "turn" : "odstavec";
  const plural = sourceKind === "conversation" ? "turny" : "odstavce";
  return start === end ? `${singular} ${start}` : `${plural} ${start}-${end}`;
}

function shortStableHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 10);
}

function boundedVerticalFilename(prefix: string, label: string, stableId: string): string {
  const prefixSlug = slugify(prefix) || "vertical";
  const labelSlug = slugify(label) || "item";
  const hashSuffix = shortStableHash(stableId);
  const reservedLength = prefixSlug.length + hashSuffix.length + ".md".length + 2;
  const maxLabelLength = Math.max(24, MAX_VERTICAL_FILENAME_STEM_LENGTH - reservedLength);
  const boundedLabel = labelSlug.slice(0, maxLabelLength).replace(/-+$/g, "") || "item";
  return `${prefixSlug}-${boundedLabel}-${hashSuffix}.md`;
}

function verticalFrameFilename(item: { id: string; label: string }, kind: "frame" | "subframe"): string {
  return boundedVerticalFilename(kind, item.label || item.id, item.id);
}

function buildReferencePageSummary(document: UnifiedDocument, thoughtCount: number): string {
  return `${formatSourceKind(document.sourceKind)} dokument s ${thoughtCount} propojenými myšlenkami`;
}

function buildSearchKeywords(parts: Array<string | undefined | null>): string[] {
  return Array.from(
    new Set(
      parts
        .flatMap((part) => (part ?? "").split(/[^0-9A-Za-zÀ-ž_-]+/))
        .map((value) => value.trim())
        .filter((value) => value.length >= 2)
    )
  ).sort((left, right) => left.localeCompare(right));
}

function sortNodesForRecency(nodes: ConsolidatedThoughtNode[]): ConsolidatedThoughtNode[] {
  return [...nodes].sort((left, right) => {
    const lastSeenComparison = compareDates(right.lastSeen, left.lastSeen);
    if (lastSeenComparison !== 0) {
      return lastSeenComparison;
    }

    const firstSeenComparison = compareDates(right.firstSeen, left.firstSeen);
    if (firstSeenComparison !== 0) {
      return firstSeenComparison;
    }

    return left.title.localeCompare(right.title);
  });
}

function sortClaimsForPresentation(
  claims: ThoughtClaim[],
  currentStateClaimIds: Set<string>
): ThoughtClaim[] {
  return [...claims].sort((left, right) => {
    const leftIsCurrent = currentStateClaimIds.has(left.id);
    const rightIsCurrent = currentStateClaimIds.has(right.id);
    if (leftIsCurrent !== rightIsCurrent) {
      return leftIsCurrent ? -1 : 1;
    }

    const timeComparison = compareDates(right.time, left.time);
    if (timeComparison !== 0) {
      return timeComparison;
    }

    return right.chronologyIndex - left.chronologyIndex;
  });
}

function sentenceCase(text: string): string {
  if (text.length === 0) {
    return text;
  }

  return `${text.slice(0, 1).toLocaleUpperCase("cs-CZ")}${text.slice(1)}`;
}

function normalizePresentationSummary(text: string): string {
  const cleaned = text
    .trim()
    .replace(/^Node zachycuje postoj, že\s+/iu, "")
    .replace(/^Node zachycuje\s+/iu, "")
    .replace(/^Node popisuje\s+/iu, "")
    .replace(/^Teze, že\s+/iu, "")
    .replace(/^Téma, že\s+/iu, "")
    .replace(/\bsamostatný kulturní theme node\b/giu, "samostatné kulturní téma")
    .replace(/\btheme node\b/giu, "téma")
    .replace(/\s+/g, " ")
    .trim();

  return sentenceCase(cleaned);
}

function scorePresentationSummary(options: {
  nodeType: ThoughtNodeType;
  text: string;
  source: "claim" | "summary";
}): number {
  const normalized = options.text.toLocaleLowerCase("cs-CZ");
  let score = 0;

  if (options.source === "summary") {
    score += options.nodeType === "thread" || options.nodeType === "question" ? 1 : 4;
  } else {
    score += options.nodeType === "thread" || options.nodeType === "question" ? 4 : 1;
  }

  if (options.text.length >= 70 && options.text.length <= 220) {
    score += 2;
  } else if (options.text.length >= 40 && options.text.length < 70) {
    score += 1;
  } else if (options.text.length < 30 || options.text.length > 260) {
    score -= 1;
  }

  if (options.nodeType !== "question" && options.text.endsWith("?")) {
    score -= 2;
  }

  if (normalized.includes("theme node") || normalized.includes("samostatný kulturní theme node")) {
    score -= 5;
  }

  if (
    normalized.startsWith("node ") ||
    normalized.includes("tento text") ||
    normalized.includes("má být veden") ||
    normalized.includes("má být vedena")
  ) {
    score -= 4;
  }

  if (normalized.startsWith("vlákno o ") || normalized.startsWith("otázka ")) {
    score -= 1;
  }

  return score;
}

function buildThoughtPageSummaryFromEvidence(options: {
  node: ConsolidatedThoughtNode;
  claims: ThoughtClaim[];
  states: ThoughtNodeState[];
}): string {
  const currentStateClaimIds = new Set(
    options.states
      .filter((state) => options.node.currentStateIds.includes(state.id))
      .flatMap((state) => state.claimIds)
  );
  const prioritizedClaims = sortClaimsForPresentation(options.claims, currentStateClaimIds);
  const summaryCandidates = [
    ...options.states
      .filter((state) => options.node.currentStateIds.includes(state.id))
      .map((state) => normalizePresentationSummary(state.summary)),
    normalizePresentationSummary(options.node.summary)
  ]
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  const claimCandidates = prioritizedClaims
    .map((claim) => normalizePresentationSummary(claim.claim))
    .filter((text) => text.length > 0);

  const allCandidates = [
    ...summaryCandidates.map((text) => ({ text, source: "summary" as const })),
    ...claimCandidates.map((text) => ({ text, source: "claim" as const }))
  ];
  const bestCandidate = allCandidates.sort((left, right) => {
    const scoreDifference =
      scorePresentationSummary({
        nodeType: options.node.nodeType,
        text: right.text,
        source: right.source
      }) -
      scorePresentationSummary({
        nodeType: options.node.nodeType,
        text: left.text,
        source: left.source
      });
    if (scoreDifference !== 0) {
      return scoreDifference;
    }

    return right.text.length - left.text.length;
  })[0];

  return bestCandidate?.text || normalizePresentationSummary(options.node.summary);
}

function scorePresentationClaimView(
  view: ThoughtPageClaimView,
  nodeType: ThoughtNodeType
): number {
  let score = scorePresentationSummary({
    nodeType,
    text: normalizePresentationSummary(view.claim.claim),
    source: "claim"
  });

  if (view.isCurrent) {
    score += 2;
  }

  return score;
}

function buildThoughtIndexSection(
  type: ThoughtNodeType,
  nodes: ConsolidatedThoughtNode[],
  pageByNodeId: Map<string, ThoughtPageInfo>,
  summaryByNodeId: Map<string, string>,
  currentPageTarget: string
): string {
  const config = TYPE_DESCRIPTIONS[type];
  const lines = [`## ${config.plural}`, "", config.description, ""];

  if (nodes.length === 0) {
    lines.push("_Zatím žádné stránky._", "");
    return lines.join("\n");
  }

  lines.push("| Stránka | Shrnutí | Stav | Poprvé | Naposledy | Zdroje |");
  lines.push("| --- | --- | --- | --- | --- | --- |");

  for (const node of nodes) {
    const page = pageByNodeId.get(node.id);
    if (!page) {
      continue;
    }

    lines.push(
      `| ${markdownLink(node.title, relativeLink(currentPageTarget, page.targetPath))} | ${escapeTableCell(summaryByNodeId.get(node.id) ?? node.summary)} | ${STATUS_LABELS[node.status]} | ${formatDate(node.firstSeen)} | ${formatDate(node.lastSeen)} | ${escapeTableCell(signalMixSummary(node.signalBySourceKind))} |`
    );
  }

  lines.push("");
  return lines.join("\n");
}

function linkedMacroNodes(options: {
  nodeIds: string[];
  targetPath: string;
  pageByNodeId: Map<string, ThoughtPageInfo>;
  assessmentByNodeId: Map<string, ThoughtMacroMapArtifact["nodeAssessments"][number]>;
  limit?: number;
}): string[] {
  return options.nodeIds
    .map((nodeId) => ({
      nodeId,
      page: options.pageByNodeId.get(nodeId),
      assessment: options.assessmentByNodeId.get(nodeId)
    }))
    .filter((row): row is typeof row & { page: ThoughtPageInfo } => row.page !== undefined)
    .sort((left, right) => {
      const salienceDifference =
        (right.assessment?.salienceScore ?? 0) - (left.assessment?.salienceScore ?? 0);
      return salienceDifference !== 0
        ? salienceDifference
        : left.page.node.title.localeCompare(right.page.node.title);
    })
    .slice(0, options.limit)
    .map((row) => markdownLink(row.page.node.title, relativeLink(options.targetPath, row.page.targetPath)));
}

function buildMacroHomePage(options: {
  paths: ProjectPaths;
  macroMap: ThoughtMacroMapArtifact;
  consolidatedGraph: ConsolidatedThoughtGraph;
  targetPath: string;
  constellationPageById: Map<string, MacroPageInfo<ThoughtMacroConstellation>>;
  trajectoryPageById: Map<string, MacroPageInfo<ThoughtMacroTrajectory>>;
  pageByNodeId: Map<string, ThoughtPageInfo>;
  pageCount: number;
}): string {
  const assessmentByNodeId = new Map(
    options.macroMap.nodeAssessments.map((assessment) => [assessment.nodeId, assessment])
  );
  const lines = [
    `# ${options.macroMap.atlas.title}`,
    "",
    blockquote(options.macroMap.atlas.summary),
    "",
    "## Hlavní vstupy",
    "",
    "Těchto šest konstelací dává nejrychlejší orientaci v dlouhodobých směrech myšlení.",
    "",
    "| Konstelace | O čem je | Role |",
    "| --- | --- | --- |"
  ];

  for (const constellationId of options.macroMap.atlas.entrypointConstellationIds) {
    const page = options.constellationPageById.get(constellationId);
    if (!page) {
      continue;
    }
    lines.push(
      `| ${markdownLink(page.item.title, relativeLink(options.targetPath, page.targetPath))} | ${escapeTableCell(page.item.summary)} | ${macroRoleLabel(page.item.atlasRole)} |`
    );
  }

  lines.push(
    "",
    `Všech ${options.macroMap.constellations.length} oblastí: ${markdownLink("Konstelace atlasu", relativeLink(options.targetPath, path.join(options.paths.wikiDir, "atlas", "index.md")))}`,
    "",
    "## Vývojové trajektorie",
    "",
    "Trajektorie ukazují změnu formulací a přesun těžiště v čase; nejsou jen další tematickou kategorií.",
    "",
    "| Trajektorie | Směr vývoje |",
    "| --- | --- |"
  );
  for (const trajectoryId of options.macroMap.atlas.trajectoryIds) {
    const page = options.trajectoryPageById.get(trajectoryId);
    if (!page) {
      continue;
    }
    lines.push(
      `| ${markdownLink(page.item.title, relativeLink(options.targetPath, page.targetPath))} | ${escapeTableCell(page.item.summary)} |`
    );
  }

  const zooms: Array<{ title: string; nodeIds: string[]; target: string }> = [
    {
      title: "Aktuální pozice",
      nodeIds: options.macroMap.atlas.currentPositionNodeIds,
      target: path.join(options.paths.wikiDir, "atlas", "current_positions.md")
    },
    {
      title: "Otevřené otázky",
      nodeIds: options.macroMap.atlas.openQuestionNodeIds,
      target: path.join(options.paths.wikiDir, "atlas", "open_questions.md")
    },
    {
      title: "Otevřená napětí",
      nodeIds: options.macroMap.atlas.openTensionNodeIds,
      target: path.join(options.paths.wikiDir, "atlas", "open_tensions.md")
    }
  ];
  lines.push("", "## Aktuální zoom", "");
  for (const zoom of zooms) {
    const linkedNodes = linkedMacroNodes({
      nodeIds: zoom.nodeIds,
      targetPath: options.targetPath,
      pageByNodeId: options.pageByNodeId,
      assessmentByNodeId,
      limit: 6
    });
    lines.push(
      `### ${markdownLink(zoom.title, relativeLink(options.targetPath, zoom.target))}`,
      "",
      linkedNodes.length > 0 ? linkedNodes.map((link) => `- ${link}`).join("\n") : "_Bez položek._",
      ""
    );
  }

  lines.push(
    "## Další způsoby čtení",
    "",
    `- ${markdownLink("Všechny myšlenky", relativeLink(options.targetPath, path.join(options.paths.wikiThoughtsDir, "index.md")))} slouží jako inventář, ne jako hlavní vstup`,
    `- ${markdownLink("Vertikální mapa zdrojů", relativeLink(options.targetPath, path.join(options.paths.wikiIndexesDir, "vertical_alignment.md")))} ukazuje kompoziční rámce konkrétních textů`,
    `- ${markdownLink("Zdrojové reference", relativeLink(options.targetPath, path.join(options.paths.wikiReferencesDir, "index.md")))} umožňují ověřit formulace proti původním pasážím`,
    "",
    "## Appendix: Rozsah mapy",
    "",
    `- ${options.macroMap.constellations.length} konstelací a ${options.macroMap.trajectories.length} trajektorií`,
    `- ${options.macroMap.quality.mappedNodeCount} z ${options.macroMap.sourceNodeCount} konsolidovaných uzlů zařazených alespoň do jedné konstelace`,
    `- ${options.pageCount} vygenerovaných wiki stránek`,
    `- kontrakt \`${options.macroMap.contractVersion}\``,
    ""
  );
  return lines.join("\n");
}

function buildAtlasIndexPage(options: {
  macroMap: ThoughtMacroMapArtifact;
  targetPath: string;
  constellationPageById: Map<string, MacroPageInfo<ThoughtMacroConstellation>>;
}): string {
  const lines = [
    "# Konstelace atlasu",
    "",
    `> Navigace: ${markdownLink("Mapa myšlení", relativeLink(options.targetPath, path.join(path.dirname(path.dirname(options.targetPath)), "index.md")))}`,
    "",
    "Konstelace jsou stabilní orientační oblasti nad jednotlivými myšlenkami. Jeden uzel může patřit do dvou oblastí, pokud skutečně propojuje jejich význam.",
    ""
  ];
  const roles: ThoughtMacroConstellation["atlasRole"][] = [
    "core_direction",
    "active_exploration",
    "supporting_context"
  ];
  for (const role of roles) {
    const pages = Array.from(options.constellationPageById.values())
      .filter((page) => page.item.atlasRole === role)
      .sort((left, right) => right.item.salienceScore - left.item.salienceScore);
    lines.push(`## ${macroRoleLabel(role)}`, "", "| Konstelace | Shrnutí | Uzly |", "| --- | --- | ---: |");
    for (const page of pages) {
      lines.push(
        `| ${markdownLink(page.item.title, relativeLink(options.targetPath, page.targetPath))} | ${escapeTableCell(page.item.summary)} | ${page.item.memberNodeIds.length} |`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildConstellationPage(options: {
  paths: ProjectPaths;
  constellation: ThoughtMacroConstellation;
  targetPath: string;
  memberInventoryPath: string;
  pageByNodeId: Map<string, ThoughtPageInfo>;
  assessmentByNodeId: Map<string, ThoughtMacroMapArtifact["nodeAssessments"][number]>;
  trajectoryPageById: Map<string, MacroPageInfo<ThoughtMacroTrajectory>>;
  trajectories: ThoughtMacroTrajectory[];
}): string {
  const selected = (predicate: (member: ThoughtMacroConstellation["members"][number]) => boolean, limit: number) =>
    linkedMacroNodes({
      nodeIds: options.constellation.members.filter(predicate).map((member) => member.nodeId),
      targetPath: options.targetPath,
      pageByNodeId: options.pageByNodeId,
      assessmentByNodeId: options.assessmentByNodeId,
      limit
    });
  const core = selected((member) => member.role === "core", 12);
  const current = selected((member) => member.currentPosition, 8);
  const questions = selected((member) => member.openQuestion, 10);
  const tensions = selected((member) => member.tension, 10);
  const trajectories = options.trajectories.filter((trajectory) =>
    trajectory.constellationIds.includes(options.constellation.id)
  );
  const lines = [
    `# ${options.constellation.title}`,
    "",
    `> ${macroRoleLabel(options.constellation.atlasRole)} · ${options.constellation.memberNodeIds.length} myšlenek · ${formatDate(options.constellation.firstSeen)} až ${formatDate(options.constellation.lastSeen)}`,
    `> Navigace: ${markdownLink("Mapa myšlení", relativeLink(options.targetPath, path.join(options.paths.wikiDir, "index.md")))} · ${markdownLink("Všechny konstelace", relativeLink(options.targetPath, path.join(options.paths.wikiDir, "atlas", "index.md")))}`,
    "",
    "## Smysl oblasti",
    "",
    options.constellation.summary,
    "",
    options.constellation.rationale,
    "",
    "## Jádro",
    "",
    ...(core.length > 0 ? core.map((link) => `- ${link}`) : ["_Bez jádrových uzlů._"]),
    ""
  ];
  const sections: Array<[string, string[]]> = [
    ["Aktuální pozice", current],
    ["Otevřené otázky", questions],
    ["Napětí a rozpory", tensions]
  ];
  for (const [title, links] of sections) {
    if (links.length === 0) {
      continue;
    }
    lines.push(`## ${title}`, "", ...links.map((link) => `- ${link}`), "");
  }
  if (trajectories.length > 0) {
    lines.push("## Vývojové trajektorie", "");
    for (const trajectory of trajectories) {
      const page = options.trajectoryPageById.get(trajectory.id);
      lines.push(
        `- ${page ? markdownLink(trajectory.title, relativeLink(options.targetPath, page.targetPath)) : trajectory.title}: ${trajectory.summary}`
      );
    }
    lines.push("");
  }
  lines.push(
    "## Rozsah a nejistota",
    "",
    `- role v atlasu: ${macroRoleLabel(options.constellation.atlasRole)}`,
    `- jistota zařazení: ${options.constellation.confidence}`,
    `- úplný seznam: ${markdownLink(`${options.constellation.memberNodeIds.length} členů konstelace`, relativeLink(options.targetPath, options.memberInventoryPath))}`,
    `- nejistota: ${options.constellation.uncertainty || "neuvedena"}`,
    ""
  );
  return lines.join("\n");
}

function buildConstellationMembersPage(options: {
  constellation: ThoughtMacroConstellation;
  targetPath: string;
  constellationPath: string;
  pageByNodeId: Map<string, ThoughtPageInfo>;
  assessmentByNodeId: Map<string, ThoughtMacroMapArtifact["nodeAssessments"][number]>;
}): string {
  const rows = options.constellation.members
    .map((member) => ({
      member,
      page: options.pageByNodeId.get(member.nodeId),
      assessment: options.assessmentByNodeId.get(member.nodeId)
    }))
    .filter((row): row is typeof row & { page: ThoughtPageInfo } => row.page !== undefined)
    .sort((left, right) => {
      const roleOrder = { core: 0, supporting: 1, context: 2 } as const;
      const roleDifference = roleOrder[left.member.role] - roleOrder[right.member.role];
      if (roleDifference !== 0) return roleDifference;
      return (right.assessment?.salienceScore ?? 0) - (left.assessment?.salienceScore ?? 0);
    });
  return [
    `# Členové · ${options.constellation.title}`,
    "",
    `> Zpět na ${markdownLink(options.constellation.title, relativeLink(options.targetPath, options.constellationPath))}`,
    "",
    "Toto je úplný auditní inventář. Pro běžnou orientaci používej hlavní stránku konstelace.",
    "",
    "| Myšlenka | Role | Aktuální | Otázka | Napětí |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((row) =>
      `| ${markdownLink(row.page.node.title, relativeLink(options.targetPath, row.page.targetPath))} | ${macroMemberRoleLabel(row.member.role)} | ${row.member.currentPosition ? "ano" : ""} | ${row.member.openQuestion ? "ano" : ""} | ${row.member.tension ? "ano" : ""} |`
    ),
    ""
  ].join("\n");
}

function buildTrajectoryPage(options: {
  paths: ProjectPaths;
  trajectory: ThoughtMacroTrajectory;
  targetPath: string;
  constellationPageById: Map<string, MacroPageInfo<ThoughtMacroConstellation>>;
  pageByNodeId: Map<string, ThoughtPageInfo>;
}): string {
  const lines = [
    `# ${options.trajectory.title}`,
    "",
    `> Navigace: ${markdownLink("Mapa myšlení", relativeLink(options.targetPath, path.join(options.paths.wikiDir, "index.md")))} · ${markdownLink("Všechny trajektorie", relativeLink(options.targetPath, path.join(options.paths.wikiDir, "trajectories", "index.md")))}`,
    "",
    options.trajectory.summary,
    "",
    "## Oblasti, kterými prochází",
    "",
    ...options.trajectory.constellationIds.map((constellationId) => {
      const page = options.constellationPageById.get(constellationId);
      return page
        ? `- ${markdownLink(page.item.title, relativeLink(options.targetPath, page.targetPath))}`
        : `- ${constellationId}`;
    }),
    "",
    "## Vývoj v čase",
    ""
  ];
  for (const [index, stage] of options.trajectory.stages.entries()) {
    lines.push(`### ${index + 1}. ${stage.label}`, "", stage.summary, "");
    for (const nodeId of stage.nodeIds) {
      const page = options.pageByNodeId.get(nodeId);
      if (page) {
        lines.push(`- ${markdownLink(page.node.title, relativeLink(options.targetPath, page.targetPath))}`);
      }
    }
    lines.push("");
  }
  const appendNodeSection = (title: string, nodeIds: string[]) => {
    const pages = nodeIds.map((nodeId) => options.pageByNodeId.get(nodeId)).filter((page): page is ThoughtPageInfo => page !== undefined);
    if (pages.length === 0) return;
    lines.push(`## ${title}`, "", ...pages.map((page) => `- ${markdownLink(page.node.title, relativeLink(options.targetPath, page.targetPath))}`), "");
  };
  appendNodeSection("Současné těžiště", options.trajectory.currentPositionNodeIds);
  appendNodeSection("Nevyřešená napětí", options.trajectory.openTensionNodeIds);
  lines.push(
    "## Nejistota",
    "",
    `- jistota trajektorie: ${options.trajectory.confidence}`,
    `- ${options.trajectory.uncertainty || "bez uvedené nejistoty"}`,
    ""
  );
  return lines.join("\n");
}

function buildMacroZoomPage(options: {
  title: string;
  description: string;
  items: ThoughtMacroMapArtifact["currentPositions"];
  targetPath: string;
  paths: ProjectPaths;
  pageByNodeId: Map<string, ThoughtPageInfo>;
  constellationPageById: Map<string, MacroPageInfo<ThoughtMacroConstellation>>;
}): string {
  const lines = [
    `# ${options.title}`,
    "",
    `> Navigace: ${markdownLink("Mapa myšlení", relativeLink(options.targetPath, path.join(options.paths.wikiDir, "index.md")))}`,
    "",
    options.description,
    "",
    "| Myšlenka | Konstelace | Autorita |",
    "| --- | --- | --- |"
  ];
  for (const item of [...options.items].sort((left, right) => right.salienceScore - left.salienceScore).slice(0, 80)) {
    const page = options.pageByNodeId.get(item.nodeId);
    if (!page) continue;
    const constellations = item.constellationIds
      .map((id) => options.constellationPageById.get(id))
      .filter((candidate): candidate is MacroPageInfo<ThoughtMacroConstellation> => candidate !== undefined)
      .map((candidate) => markdownLink(candidate.item.title, relativeLink(options.targetPath, candidate.targetPath)))
      .join(", ");
    lines.push(
      `| ${markdownLink(page.node.title, relativeLink(options.targetPath, page.targetPath))} | ${constellations} | ${item.sourceAuthority} |`
    );
  }
  lines.push("", "> Zobrazeno nejvýše 80 nejsilnějších položek; úplný uzlový inventář zůstává dostupný přes typové indexy a hledání.", "");
  return lines.join("\n");
}

function buildGlobalIndexPage(options: {
  paths: ProjectPaths;
  corpus: UnifiedCorpus;
  compilation: ThoughtCompilationArtifacts;
  consolidatedGraph: ConsolidatedThoughtGraph;
  pageCount: number;
  pageByNodeId: Map<string, ThoughtPageInfo>;
  indexPath: string;
  hasFrameAlignment: boolean;
}): string {
  const typeCounts = buildTypeCounts(options.consolidatedGraph.nodes);
  const recentNodes = sortNodesForRecency(options.consolidatedGraph.nodes).slice(0, 12);
  const lines: string[] = [
    "# Validační wiki",
    "",
    "> Prohlížitelná wiki vrstva nad zkompilovaným a konsolidovaným thought graphem.",
    `> Vygenerováno: ${formatDate(options.consolidatedGraph.generatedAt)} · Běh: \`${options.consolidatedGraph.sourceRunId}\``,
    "",
    "## Kde začít",
    "",
    "- pokud chceš číst obsahově, začni přes [Všechny myšlenky](thoughts/index.md) nebo přes konkrétní typ myšlenky",
    ...(options.hasFrameAlignment
      ? ["- pokud chceš chápat větší kompoziční vrstvy textů, jdi na [Vertikální mapu](indexes/vertical_alignment.md)"]
      : []),
    "- pokud chceš ověřovat původ tvrzení, jdi do [Zdrojových referencí](references/index.md)",
    "",
    "## Jak wiki číst",
    "",
    "Tato wiki má dvě osy, mezi nimiž se má dát přepínat skoro na každé stránce.",
    "",
    "### Vertikálně",
    "",
    "- sestupuješ od širších tematických vrstev k užším lokálním rámcům a konkrétním myšlenkám",
    ...(options.hasFrameAlignment
      ? ["- začni přes [Vertikální mapu](indexes/vertical_alignment.md)"]
      : ["- v tomto běhu ještě není vygenerovaná samostatná vertikální mapa"]),
    "",
    "### Horizontálně",
    "",
    "- přecházíš mezi příbuznými, podpůrnými nebo konfliktními myšlenkami napříč grafem",
    "- začni přes [Všechny myšlenky](thoughts/index.md) nebo přes konkrétní typ myšlenky",
    "",
    "## Procházet horizontálně",
    "",
    "- [Všechny myšlenky](thoughts/index.md)",
    "- [Teze](theses/index.md)",
    "- [Otázky](questions/index.md)",
    "- [Témata](themes/index.md)",
    "- [Tenze](tensions/index.md)",
    "- [Vlákna](threads/index.md)",
    "- [Chronologie](chronology/index.md)",
    "- [Zdrojové reference](references/index.md)",
    "- [Diagnostika grafu](indexes/graph.md)",
    "",
    "## Procházet vertikálně",
    "",
    ...(options.hasFrameAlignment
      ? ["- [Vertikální mapa](indexes/vertical_alignment.md)"]
      : ["- _Vertikální mapa v tomto běhu chybí._"]),
    "",
    "## Přehled",
    "",
    "| Vrstva | Počet |",
    "| --- | ---: |",
    `| Dokumenty ve zdrojovém korpusu | ${options.corpus.stats.documentCount} |`,
    `| Segmenty ve zdrojovém korpusu | ${options.corpus.stats.segmentCount} |`,
    `| Granulární myšlenkové uzly | ${options.compilation.graph.nodeCount} |`,
    `| Granulární myšlenkové hrany | ${options.compilation.graph.edgeCount} |`,
    `| Tvrzení | ${options.compilation.graph.claimCount} |`,
    `| Stavy | ${options.compilation.graph.nodeStateCount} |`,
    `| Konsolidované myšlenkové uzly | ${options.consolidatedGraph.nodeCount} |`,
    `| Konsolidované myšlenkové hrany | ${options.consolidatedGraph.edgeCount} |`,
    `| Vygenerované wiki stránky | ${options.pageCount} |`,
    "",
    "## Typy myšlenek",
    "",
    "| Typ | Počet |",
    "| --- | ---: |",
    `| Teze | ${typeCounts.thesis} |`,
    `| Otázky | ${typeCounts.question} |`,
    `| Témata | ${typeCounts.theme} |`,
    `| Tenze | ${typeCounts.tension} |`,
    `| Vlákna | ${typeCounts.thread} |`,
    "",
    ...(typeCounts.theme === 0 && options.hasFrameAlignment
      ? [
          "> Poznámka: tento běh nevytvořil žádné samostatné uzly typu `Téma`.",
          "> Tematická hierarchie je proto teď nesena hlavně přes [Vertikální mapu](indexes/vertical_alignment.md), sdílené rodiny a vyšší vzory.",
          ""
        ]
      : []),
    "## Naposledy aktualizované myšlenky",
    "",
    "| Myšlenka | Typ | Stav | Poprvé | Naposledy |",
    "| --- | --- | --- | --- | --- |"
  ];

  for (const node of recentNodes) {
    const page = options.pageByNodeId.get(node.id);
    if (!page) {
      continue;
    }

    lines.push(
      `| ${markdownLink(node.title, relativeLink(options.indexPath, page.targetPath))} | ${TYPE_DESCRIPTIONS[node.nodeType].singular} | ${STATUS_LABELS[node.status]} | ${formatDate(node.firstSeen)} | ${formatDate(node.lastSeen)} |`
    );
  }

  lines.push(
    "",
    "## Appendix: Artefakty běhu",
    "",
    `- [Konsolidovaný thought graph](${replacePathSeparators(path.relative(options.paths.wikiDir, path.join(options.paths.compiledDir, THOUGHT_CONSOLIDATION_DEFAULTS.compiledGraphFilename)))})`,
    `- [Granulární thought graph](${replacePathSeparators(path.relative(options.paths.wikiDir, options.consolidatedGraph.sourceGraphPath || path.join(options.paths.compiledDir, THOUGHT_COMPILER_DEFAULTS.compiledGraphFilename)))})`,
    `- [Sjednocený korpus](${replacePathSeparators(path.relative(options.paths.wikiDir, options.compilation.graph.sourceCorpusPath))})`,
    `- [Wiki manifest](indexes/wiki_manifest.json)`,
    `- [Wiki vyhledávací index](indexes/search_index.json)`,
    ""
  );
  return lines.join("\n");
}

function buildThoughtPage(options: {
  paths: ProjectPaths;
  node: ConsolidatedThoughtNode;
  targetPath: string;
  claimsById: Map<string, ThoughtClaim>;
  statesById: Map<string, ThoughtNodeState>;
  worldlinesById: Map<string, ThoughtWorldline>;
  pageByNodeId: Map<string, ThoughtPageInfo>;
  referenceByDocumentId: Map<string, ReferencePageInfo>;
  documentById: Map<string, UnifiedDocument>;
  segmentBySourceRefKey: Map<string, UnifiedSegment>;
  edgesByNodeId: Map<string, ConsolidatedThoughtEdge[]>;
  identityMergeNotes: string[];
  pageSummary: string;
  localFramePageById: Map<string, VerticalFramePageInfo>;
  localSubframePageById: Map<string, VerticalFramePageInfo>;
  alignmentFamiliesByNodeId: Map<string, ThoughtFrameAlignmentFamily[]>;
  alignmentPatternsByNodeId: Map<string, ThoughtHigherOrderPattern[]>;
  verticalFamilyPageById: Map<string, { targetPath: string }>;
  verticalPatternPageById: Map<string, { targetPath: string }>;
  macroMemberships: Array<{
    constellation: ThoughtMacroConstellation;
    member: ThoughtMacroConstellation["members"][number];
    targetPath: string;
  }>;
  macroTrajectories: Array<{
    trajectory: ThoughtMacroTrajectory;
    targetPath: string;
    stageLabels: string[];
  }>;
}): string {
  const { node, targetPath } = options;
  const typeConfig = TYPE_DESCRIPTIONS[node.nodeType];
  const sourceDocuments = dedupeByKey(
    node.sourceRefs
      .map((sourceRef) => options.documentById.get(sourceRef.documentId))
      .filter((document): document is UnifiedDocument => document !== undefined),
    (document) => document.id
  );
  const claims = node.memberClaimIds
    .map((claimId) => options.claimsById.get(claimId))
    .filter((claim): claim is ThoughtClaim => claim !== undefined)
    .sort((left, right) => {
      const timeComparison = compareDates(left.time, right.time);
      if (timeComparison !== 0) {
        return timeComparison;
      }
      return left.id.localeCompare(right.id);
    });
  const states = node.memberStateIds
    .map((stateId) => options.statesById.get(stateId))
    .filter((state): state is ThoughtNodeState => state !== undefined)
    .sort((left, right) => {
      const timeComparison = compareDates(left.validFrom, right.validFrom);
      if (timeComparison !== 0) {
        return timeComparison;
      }
      return left.stateIndex - right.stateIndex;
    });
  const worldlines = node.memberWorldlineIds
    .map((worldlineId) => options.worldlinesById.get(worldlineId))
    .filter((worldline): worldline is ThoughtWorldline => worldline !== undefined);
  const currentStateIds = new Set(node.currentStateIds);
  const relatedEdges = options.edgesByNodeId.get(node.id) ?? [];
  const alignmentFamilies = options.alignmentFamiliesByNodeId.get(node.id) ?? [];
  const alignmentPatterns = options.alignmentPatternsByNodeId.get(node.id) ?? [];
  const localMemberships = dedupeByKey(
    node.frameMemberships ?? [],
    (membership) =>
      `${membership.documentId}:${membership.frameId}:${membership.subframeId ?? "main"}:${membership.frameRole ?? "none"}`
  ).sort((left, right) => {
    if (left.frameLabel !== right.frameLabel) {
      return left.frameLabel.localeCompare(right.frameLabel);
    }
    return (left.subframeLabel ?? "").localeCompare(right.subframeLabel ?? "");
  });
  const relatedRows = new Map<
    string,
    {
      targetNode: ConsolidatedThoughtNode;
      edges: ConsolidatedThoughtEdge[];
    }
  >();

  for (const edge of relatedEdges) {
    const targetNodeId = edge.from === node.id ? edge.to : edge.from;
    const targetNode = options.pageByNodeId.get(targetNodeId)?.node;
    if (!targetNode) {
      continue;
    }
    const bucket = relatedRows.get(targetNodeId) ?? { targetNode, edges: [] };
    bucket.edges.push(edge);
    relatedRows.set(targetNodeId, bucket);
  }

  const evidenceByDocumentId = new Map<
    string,
    Array<{
      sourceRef: UnifiedSourceRef;
      excerpt: string;
      referenceLink: string;
    }>
  >();
  for (const sourceRef of node.sourceRefs.sort((left, right) => {
    if (left.documentId !== right.documentId) {
      return left.documentId.localeCompare(right.documentId);
    }
    return compareLocators(left.locator, right.locator);
  })) {
    const referencePage = options.referenceByDocumentId.get(sourceRef.documentId);
    const excerpt = boundedExcerpt(
      options.segmentBySourceRefKey.get(sourceRefKey(sourceRef))?.text ??
      options.segmentBySourceRefKey.get(sourceRefKey(sourceRef))?.textPreview ??
      "Segment not found in unified corpus."
    );
    const bucket = evidenceByDocumentId.get(sourceRef.documentId) ?? [];
    bucket.push({
      sourceRef,
      excerpt,
      referenceLink:
        referencePage === undefined
          ? ""
          : `${relativeLink(targetPath, referencePage.targetPath)}#${referenceAnchorId(sourceRef.locator)}`
    });
    evidenceByDocumentId.set(sourceRef.documentId, bucket);
  }

  const currentStateClaimIds = new Set(
    states
      .filter((state) => currentStateIds.has(state.id))
      .flatMap((state) => state.claimIds)
  );
  const claimViews = claims.map((claim) => {
    const referencePage = options.referenceByDocumentId.get(claim.sourceRef.documentId);
    const sourceLink =
      referencePage === undefined
        ? claim.sourceRef.locator
        : markdownLink(
            `${claim.sourceRef.documentTitle} / ${claim.sourceRef.locator}`,
            `${relativeLink(targetPath, referencePage.targetPath)}#${referenceAnchorId(claim.sourceRef.locator)}`
          );
    const excerpt = boundedExcerpt(
      options.segmentBySourceRefKey.get(sourceRefKey(claim.sourceRef))?.text ??
      options.segmentBySourceRefKey.get(sourceRefKey(claim.sourceRef))?.textPreview ??
      "Segment not found in unified corpus."
    );
    return {
      claim,
      excerpt,
      sourceLink,
      referenceLink:
        referencePage === undefined
          ? ""
          : `${relativeLink(targetPath, referencePage.targetPath)}#${referenceAnchorId(claim.sourceRef.locator)}`,
      isCurrent: currentStateClaimIds.has(claim.id)
    } satisfies ThoughtPageClaimView;
  });
  const prioritizedClaimViews = [...claimViews].sort((left, right) => {
    const scoreDifference =
      scorePresentationClaimView(right, node.nodeType) -
      scorePresentationClaimView(left, node.nodeType);
    if (scoreDifference !== 0) {
      return scoreDifference;
    }
    const timeComparison = compareDates(right.claim.time, left.claim.time);
    if (timeComparison !== 0) {
      return timeComparison;
    }
    return right.claim.chronologyIndex - left.claim.chronologyIndex;
  });
  const presentationClaims = dedupeByKey(
    prioritizedClaimViews,
    (view) => `${view.claim.sourceRef.documentId}:${view.claim.sourceRef.locator}`
  ).slice(0, 4);
  const sortedRelatedRows = Array.from(relatedRows.values())
    .map((row) => ({
      ...row,
      relationTypes: [...new Set(row.edges.map((edge) => edge.type))].sort(
        (left, right) => relationPriority(left) - relationPriority(right)
      ),
      totalWeight: row.edges.reduce((sum, edge) => sum + edge.weight, 0)
    }))
    .sort((left, right) => {
      if (left.totalWeight !== right.totalWeight) {
        return right.totalWeight - left.totalWeight;
      }
      return left.targetNode.title.localeCompare(right.targetNode.title);
    });
  const featuredRelatedRows = sortedRelatedRows.slice(0, 8);
  const latestStates = [...states]
    .sort((left, right) => {
      const comparison = compareDates(right.validFrom, left.validFrom);
      if (comparison !== 0) {
        return comparison;
      }
      return right.stateIndex - left.stateIndex;
    })
    .slice(0, 6);
  const sourceDocumentLinks = sourceDocuments.map((document) => {
    const referencePage = options.referenceByDocumentId.get(document.id);
    return referencePage
      ? markdownLink(document.title, relativeLink(targetPath, referencePage.targetPath))
      : document.title;
  });
  const localMembershipSummaries = localMemberships.map((membership) => {
    const framePage = options.localFramePageById.get(membership.frameId);
    const subframePage =
      membership.subframeId === null ? null : options.localSubframePageById.get(membership.subframeId);
    const frameLabel = framePage
      ? markdownLink(membership.frameLabel, relativeLink(targetPath, framePage.targetPath))
      : membership.frameLabel;
    const subframeLabel =
      membership.subframeLabel === null
        ? ""
        : subframePage
          ? markdownLink(membership.subframeLabel, relativeLink(targetPath, subframePage.targetPath))
          : membership.subframeLabel;
    const sourceDocument = options.documentById.get(membership.documentId);
    return `${frameLabel}${subframeLabel ? ` → ${subframeLabel}` : ""}${sourceDocument ? ` · ${sourceDocument.title}` : ""}${membership.frameRole ? ` · ${formatFrameRole(membership.frameRole)}` : ""}`;
  });
  const familySummaries = alignmentFamilies
    .slice()
    .sort((left, right) => left.label.localeCompare(right.label))
    .map((family) => {
      const familyPage = options.verticalFamilyPageById.get(family.id);
      const familyLabel = familyPage
        ? markdownLink(family.label, relativeLink(targetPath, familyPage.targetPath))
        : family.label;
      return `${familyLabel} (${formatCzechCount(family.memberDocumentIds.length, {
        one: "dokument",
        few: "dokumenty",
        many: "dokumentů"
      })})`;
    });
  const patternSummaries = alignmentPatterns
    .slice()
    .sort((left, right) => left.label.localeCompare(right.label))
    .map((pattern) => {
      const patternPage = options.verticalPatternPageById.get(pattern.id);
      const patternLabel = patternPage
        ? markdownLink(pattern.label, relativeLink(targetPath, patternPage.targetPath))
        : pattern.label;
      return `${patternLabel} (${formatCzechCount(pattern.familyIds.length, {
        one: "rodina",
        few: "rodiny",
        many: "rodin"
      })})`;
    });
  const lines: string[] = [
    `# ${node.title}`,
    "",
    `> Typ: ${typeConfig.singular} · Stav: ${STATUS_LABELS[node.status]} · Poprvé: ${formatDate(node.firstSeen)} · Naposledy: ${formatDate(node.lastSeen)}`,
    `> Navigace: ${markdownLink("Wiki", relativeLink(targetPath, path.join(options.paths.wikiDir, "index.md")))} · ${markdownLink("Všechny myšlenky", relativeLink(targetPath, path.join(options.paths.wikiThoughtsDir, "index.md")))} · ${markdownLink(typeConfig.plural, relativeLink(targetPath, path.join(typeConfig.directory(options.paths), "index.md")))}`,
    "",
    "## Přehled",
    "",
    options.pageSummary,
    ""
  ];

  if (options.macroMemberships.length > 0 || options.macroTrajectories.length > 0) {
    lines.push("## V atlasu", "");
    for (const membership of options.macroMemberships) {
      const flags = [
        macroMemberRoleLabel(membership.member.role),
        membership.member.currentPosition ? "aktuální pozice" : "",
        membership.member.openQuestion ? "otevřená otázka" : "",
        membership.member.tension ? "napětí" : ""
      ].filter((value) => value.length > 0);
      lines.push(
        `- ${markdownLink(membership.constellation.title, relativeLink(targetPath, membership.targetPath))} · ${flags.join(" · ")}`
      );
    }
    for (const trajectory of options.macroTrajectories) {
      const stage = trajectory.stageLabels.length > 0
        ? ` · fáze: ${trajectory.stageLabels.join(", ")}`
        : "";
      lines.push(
        `- Trajektorie ${markdownLink(trajectory.trajectory.title, relativeLink(targetPath, trajectory.targetPath))}${stage}`
      );
    }
    lines.push("");
  }

  const developmentSectionTitle =
    node.nodeType === "thesis"
      ? "## Co se zde konkrétně tvrdí"
      : node.nodeType === "question"
        ? "## V čem přesně spočívá otázka"
        : node.nodeType === "tension"
          ? "## Co je tu v rozporu"
          : node.nodeType === "thread"
            ? "## Co toto vlákno otevírá"
            : "## Co tento celek spojuje";
  lines.push(developmentSectionTitle, "");
  if (presentationClaims.length === 0) {
    lines.push("_Zatím bez výrazných klíčových formulací._", "");
  } else {
    for (const [index, view] of presentationClaims.entries()) {
      lines.push(`### ${index + 1}. ${view.claim.claim}`, "");
      lines.push(view.claim.rationale, "");
      lines.push(`Zdroj: ${view.sourceLink}${view.isCurrent ? " · aktuální formulace" : ""}`, "");
      lines.push(blockquote(view.excerpt), "");
    }
  }

  if (featuredRelatedRows.length > 0) {
    lines.push("## Související myšlenky", "");
    for (const row of featuredRelatedRows) {
      const targetPage = options.pageByNodeId.get(row.targetNode.id);
      if (!targetPage) {
        continue;
      }
      lines.push(
        `- ${markdownLink(row.targetNode.title, relativeLink(targetPath, targetPage.targetPath))} · ${summarizeRelationTypes(row.relationTypes)} · váha ${row.totalWeight}`
      );
    }
    lines.push("");
  }

  if (
    sourceDocumentLinks.length > 0 ||
    localMembershipSummaries.length > 0 ||
    familySummaries.length > 0 ||
    patternSummaries.length > 0
  ) {
    lines.push("## Zasazení do celku", "");
    if (sourceDocumentLinks.length > 0) {
      lines.push(`- Opírá se hlavně o dokumenty: ${previewJoined(sourceDocumentLinks, 6)}.`);
    }
    if (localMembershipSummaries.length > 0) {
      lines.push(`- Ve zdrojových textech se vrací v liniích: ${previewJoined(localMembershipSummaries, 4)}.`);
    }
    if (familySummaries.length > 0) {
      lines.push(`- Napříč texty se skládá do rodin: ${previewJoined(familySummaries, 4)}.`);
    }
    if (patternSummaries.length > 0) {
      lines.push(`- Na širší úrovni spadá do vzorů: ${previewJoined(patternSummaries, 3)}.`);
    }
    lines.push("");
  }

  if (latestStates.length > 0) {
    lines.push("## Vývoj myšlenky", "");
    for (const state of latestStates) {
      const periodLabel =
        state.validUntil === null
          ? `od ${formatDate(state.validFrom)}`
          : `${formatDate(state.validFrom)} až ${formatDate(state.validUntil)}`;
      const phaseLabel = currentStateIds.has(state.id) ? "aktuální formulace" : "dřívější formulace";
      lines.push(`- ${periodLabel} · ${phaseLabel}: ${normalizePresentationSummary(state.summary)}`);
    }
    lines.push("");
  }

  const aliases = node.aliases.filter((alias) => alias.trim() !== node.title.trim());
  const meaningfulIdentityNotes = options.identityMergeNotes.filter(
    (note) =>
      !note.endsWith(": single_candidate") &&
      !note.endsWith(": single_node") &&
      !note.endsWith(": single claim family") &&
      !note.endsWith(": exact_canonical_key")
  );
  const hasNonTrivialMergeContext =
    node.memberNodeIds.length > 1 || meaningfulIdentityNotes.length > 0;
  const shouldShowSnapshot =
    hasNonTrivialMergeContext ||
    Object.values(node.signalBySourceKind).filter((count) => count > 0).length > 1;
  const shouldShowWorldlines =
    hasNonTrivialMergeContext &&
    (worldlines.length > 1 || worldlines.some((worldline) => worldline.transitions.length > 1));
  const shouldShowAppendix =
    sourceDocumentLinks.length > 0 ||
    localMembershipSummaries.length > 0 ||
    familySummaries.length > 0 ||
    patternSummaries.length > 0 ||
    sortedRelatedRows.length > 0 ||
    claims.length > 0 ||
    evidenceByDocumentId.size > 0 ||
    states.length > 0 ||
    (hasNonTrivialMergeContext && aliases.length > 0) ||
    meaningfulIdentityNotes.length > 0 ||
    shouldShowWorldlines ||
    shouldShowSnapshot;
  if (shouldShowAppendix) {
    lines.push("## Appendix: Evidence a audit", "");

    if (sourceDocumentLinks.length > 0) {
      lines.push("### Zdrojové dokumenty", "");
      for (const sourceDocumentLink of sourceDocumentLinks.slice(0, THOUGHT_AUDIT_LIMITS.sourceDocuments)) {
        lines.push(`- ${sourceDocumentLink}`);
      }
      if (sourceDocumentLinks.length > THOUGHT_AUDIT_LIMITS.sourceDocuments) {
        lines.push(`- _Dalších ${sourceDocumentLinks.length - THOUGHT_AUDIT_LIMITS.sourceDocuments} dokumentů je dostupných přes zdrojové reference._`);
      }
      lines.push("");
    }

    if (localMembershipSummaries.length > 0) {
      lines.push("### Lokální rámce ve zdrojích", "");
      for (const summary of localMembershipSummaries.slice(0, THOUGHT_AUDIT_LIMITS.localFrames)) {
        lines.push(`- ${summary}`);
      }
      if (localMembershipSummaries.length > THOUGHT_AUDIT_LIMITS.localFrames) {
        lines.push(`- _Dalších ${localMembershipSummaries.length - THOUGHT_AUDIT_LIMITS.localFrames} lokálních rámců je dostupných ve vertikální mapě._`);
      }
      lines.push("");
    }

    if (alignmentFamilies.length > 0 || alignmentPatterns.length > 0) {
      lines.push("### Vertikální souvislosti", "");

      if (alignmentFamilies.length > 0) {
        lines.push("#### Sdílené rodiny napříč texty", "");
        for (const family of alignmentFamilies.sort((left, right) => left.label.localeCompare(right.label)).slice(0, THOUGHT_AUDIT_LIMITS.verticalItems)) {
          const familyPage = options.verticalFamilyPageById.get(family.id);
          const familyLabel = familyPage
            ? markdownLink(family.label, relativeLink(targetPath, familyPage.targetPath))
            : family.label;
          lines.push(
            `- ${familyLabel} · dokumenty ${family.memberDocumentIds.length} · rámce ${family.memberFrameIds.length} · anchor tokeny: ${family.anchorTokens.join(", ") || "n/a"}`
          );
        }
        lines.push("");
      }

      if (alignmentPatterns.length > 0) {
        lines.push("#### Vyšší vzory", "");
        for (const pattern of alignmentPatterns.sort((left, right) => left.label.localeCompare(right.label)).slice(0, THOUGHT_AUDIT_LIMITS.verticalItems)) {
          const patternPage = options.verticalPatternPageById.get(pattern.id);
          const patternLabel = patternPage
            ? markdownLink(pattern.label, relativeLink(targetPath, patternPage.targetPath))
            : pattern.label;
          lines.push(
            `- ${patternLabel} · rodiny ${pattern.familyIds.length} · dokumenty ${pattern.documentIds.length} · anchor tokeny: ${pattern.anchorTokens.join(", ") || "n/a"}`
          );
        }
        lines.push("");
      }
    }

    lines.push("### Kompletní horizontální souvislosti", "");
    if (sortedRelatedRows.length === 0) {
      lines.push("_Zatím bez konsolidovaných vztahů._", "");
    } else {
      lines.push("| Myšlenka | Vztahy | Váha |");
      lines.push("| --- | --- | ---: |");
      for (const row of sortedRelatedRows.slice(0, THOUGHT_AUDIT_LIMITS.relationships)) {
        const targetPage = options.pageByNodeId.get(row.targetNode.id);
        if (!targetPage) {
          continue;
        }
        lines.push(
          `| ${markdownLink(row.targetNode.title, relativeLink(targetPath, targetPage.targetPath))} | ${escapeTableCell(summarizeRelationTypes(row.relationTypes))} | ${row.totalWeight} |`
        );
      }
      if (sortedRelatedRows.length > THOUGHT_AUDIT_LIMITS.relationships) {
        lines.push(
          `| _Další vztahy_ | _${sortedRelatedRows.length - THOUGHT_AUDIT_LIMITS.relationships} slabších vazeb zůstává v konsolidovaném grafu_ | |`
        );
      }
      lines.push("");
    }

    lines.push("### Další formulace", "");
    if (claims.length === 0) {
      lines.push("_Zatím bez claims._", "");
    } else {
      for (const claim of claims.slice(0, THOUGHT_AUDIT_LIMITS.claims)) {
        const view = claimViews.find((candidate) => candidate.claim.id === claim.id);
        if (!view) {
          continue;
        }
        lines.push(`- ${formatDate(claim.time)} · ${claim.claim} (${view.sourceLink})`);
        lines.push(`  Rationale: ${claim.rationale}`);
      }
      if (claims.length > THOUGHT_AUDIT_LIMITS.claims) {
        lines.push(`- _Dalších ${claims.length - THOUGHT_AUDIT_LIMITS.claims} formulací je dohledatelných ve zdrojových referencích._`);
      }
      lines.push("");
    }

    lines.push("### Zdrojové pasáže", "");
    if (evidenceByDocumentId.size === 0) {
      lines.push("_Zatím bez source refs._", "");
    } else {
      let renderedPassageCount = 0;
      for (const document of sourceDocuments) {
        if (renderedPassageCount >= THOUGHT_AUDIT_LIMITS.sourcePassages) {
          break;
        }
        const entries = evidenceByDocumentId.get(document.id) ?? [];
        const referencePage = options.referenceByDocumentId.get(document.id);
        const heading =
          referencePage === undefined
            ? document.title
            : markdownLink(document.title, relativeLink(targetPath, referencePage.targetPath));
        lines.push(`#### ${heading}`, "");
        for (const entry of entries.slice(0, THOUGHT_AUDIT_LIMITS.sourcePassages - renderedPassageCount)) {
          const locatorLabel =
            entry.referenceLink.length > 0
              ? markdownLink(entry.sourceRef.locator, entry.referenceLink)
              : entry.sourceRef.locator;
          lines.push(`##### ${locatorLabel}`, "");
          lines.push(blockquote(entry.excerpt), "");
          renderedPassageCount += 1;
        }
        lines.push("");
      }
      if (node.sourceRefs.length > renderedPassageCount) {
        lines.push(`_Dalších ${node.sourceRefs.length - renderedPassageCount} pasáží je dostupných přes odkazované zdrojové dokumenty._`, "");
      }
    }

    lines.push("### Detailní vývoj v čase", "");
    if (states.length === 0) {
      lines.push("_Zatím bez materializovaných stavů._", "");
    } else {
      lines.push("| Období | Fáze | Formulace |");
      lines.push("| --- | --- | --- |");
      for (const state of states.slice(0, THOUGHT_AUDIT_LIMITS.states)) {
        const phaseLabel =
          currentStateIds.has(state.id)
            ? "aktuální formulace"
            : state.transitionType === "introduced"
              ? "první formulace"
              : state.transitionType === "continued"
                ? "průběžné držení"
                : "posun";
        const periodLabel =
          state.validUntil === null
            ? `od ${formatDate(state.validFrom)}`
            : `${formatDate(state.validFrom)} až ${formatDate(state.validUntil)}`;
        lines.push(
          `| ${periodLabel} | ${phaseLabel} | ${escapeTableCell(normalizePresentationSummary(state.summary))} |`
        );
      }
      if (states.length > THOUGHT_AUDIT_LIMITS.states) {
        lines.push(`| _Další stavy_ | | _${states.length - THOUGHT_AUDIT_LIMITS.states} starších stavů zůstává v kompilovaném artefaktu_ |`);
      }
      lines.push("");
    }

    if (hasNonTrivialMergeContext && aliases.length > 0) {
      lines.push("### Compiler notes", "", "#### Aliases", "");
      for (const alias of aliases.slice(0, THOUGHT_AUDIT_LIMITS.compilerItems)) {
        lines.push(`- ${alias}`);
      }
      lines.push("");
    }

    if (meaningfulIdentityNotes.length > 0) {
      if (!(hasNonTrivialMergeContext && aliases.length > 0)) {
        lines.push("### Compiler notes", "");
      }
      lines.push("#### Merge reasons", "");
      for (const note of meaningfulIdentityNotes.slice(0, THOUGHT_AUDIT_LIMITS.compilerItems)) {
        lines.push(`- ${note}`);
      }
      lines.push("");
    }

    if (shouldShowWorldlines) {
      if (!(hasNonTrivialMergeContext && aliases.length > 0) && meaningfulIdentityNotes.length === 0) {
        lines.push("### Compiler notes", "");
      }
      lines.push("#### Worldlines", "");
      for (const worldline of worldlines.slice(0, THOUGHT_AUDIT_LIMITS.compilerItems)) {
        lines.push(
          `- ${worldline.id}: poprvé ${formatDate(worldline.firstSeen)}, naposledy ${formatDate(worldline.lastSeen)}, přechody ${worldline.transitions.length}`
        );
      }
      lines.push("");
    }

    if (shouldShowSnapshot) {
      if (
        !(hasNonTrivialMergeContext && aliases.length > 0) &&
        meaningfulIdentityNotes.length === 0 &&
        !shouldShowWorldlines
      ) {
        lines.push("### Compiler notes", "");
      }
      lines.push("#### Internal snapshot", "");
      lines.push("| Pole | Hodnota |");
      lines.push("| --- | --- |");
      lines.push(`| Kanonický klíč | \`${node.canonicalKey}\` |`);
      lines.push(`| Členské uzly | ${node.memberNodeIds.length} |`);
      lines.push(`| Tvrzení | ${node.memberClaimIds.length} |`);
      lines.push(`| Stavy | ${node.memberStateIds.length} |`);
      lines.push(`| Vývojové linie | ${node.memberWorldlineIds.length} |`);
      lines.push(`| Zdrojové reference | ${node.sourceRefs.length} |`);
      lines.push(`| Zdrojová směs | ${escapeTableCell(signalMixSummary(node.signalBySourceKind)) || "žádná"} |`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

function buildReferencePage(options: {
  paths: ProjectPaths;
  sourceDocumentPath: string;
  document: UnifiedDocument;
  targetPath: string;
  referencedNodes: ConsolidatedThoughtNode[];
  outlinePageByDocumentId: Map<string, VerticalOutlinePageInfo>;
  pageByNodeId: Map<string, ThoughtPageInfo>;
  pageBySourceNodeId: Map<string, ThoughtPageInfo>;
  segments: UnifiedSegment[];
  sourceRefsByLocator: Map<string, UnifiedSourceRef[]>;
  claimRefsByLocator: Map<string, ThoughtClaim[]>;
}): string {
  const { document, targetPath } = options;
  const rawSourceLink = replacePathSeparators(
    path.relative(path.dirname(targetPath), options.sourceDocumentPath)
  );
  const referencedNodes = [...options.referencedNodes].sort((left, right) => {
    const leftCount = left.sourceRefs.filter((sourceRef) => sourceRef.documentId === document.id).length;
    const rightCount = right.sourceRefs.filter((sourceRef) => sourceRef.documentId === document.id).length;
    if (leftCount !== rightCount) {
      return rightCount - leftCount;
    }
    return left.title.localeCompare(right.title);
  });
  const outlinePage = options.outlinePageByDocumentId.get(document.id);
  const lines: string[] = [
    `# ${document.title}`,
    "",
    `> Zdrojový typ: ${formatSourceKind(document.sourceKind)} · Datum: ${formatDate(document.time)} · Surový soubor: ${markdownLink(path.basename(options.sourceDocumentPath), rawSourceLink)}`,
    `> Navigace: ${markdownLink("Wiki", relativeLink(targetPath, path.join(options.paths.wikiDir, "index.md")))} · ${markdownLink("Zdrojové reference", relativeLink(targetPath, path.join(options.paths.wikiReferencesDir, "index.md")))}`,
    "",
    "## Přehled",
    "",
    `Tento dokument je propojen s ${formatCzechCount(options.referencedNodes.length, {
      one: "myšlenkou",
      few: "myšlenkami",
      many: "myšlenkami"
    })} a ${formatCzechCount(options.sourceRefsByLocator.size, {
      one: "konkrétní odkazovanou pasáží",
      few: "konkrétními odkazovanými pasážemi",
      many: "konkrétními odkazovanými pasážemi"
    })}.`,
    ""
  ];

  lines.push("## Hlavní navázané myšlenky", "");
  if (referencedNodes.length === 0) {
    lines.push("_Zatím bez odkazů z myšlenkových stránek._", "");
  } else {
    lines.push("| Myšlenka | Typ | Stav | Odkazy v dokumentu |");
    lines.push("| --- | --- | --- | ---: |");
    for (const node of referencedNodes.slice(0, 30)) {
      const thoughtPage = options.pageByNodeId.get(node.id);
      if (!thoughtPage) {
        continue;
      }
      const referenceCount = node.sourceRefs.filter((sourceRef) => sourceRef.documentId === document.id).length;
      lines.push(
        `| ${markdownLink(node.title, relativeLink(targetPath, thoughtPage.targetPath))} | ${TYPE_DESCRIPTIONS[node.nodeType].singular} | ${STATUS_LABELS[node.status]} | ${referenceCount} |`
      );
    }
    lines.push("");
  }

  lines.push("## Jak tento dokument vstupuje do wiki", "");
  lines.push("");
  lines.push(`- Primární segmenty: ${document.primarySegmentCount}`);
  lines.push(`- Kontextové segmenty: ${document.contextSegmentCount}`);
  lines.push(`- Priorita zdroje: ${document.sourcePriority}`);
  lines.push(`- Surový zdroj: ${markdownLink(path.basename(options.sourceDocumentPath), rawSourceLink)}`);
  if (outlinePage) {
    lines.push(
      `- Lokální outline ${formatSourceLocalContainerNoun(document.sourceKind)}u: ${markdownLink("vertikální spine dokumentu", relativeLink(targetPath, outlinePage.targetPath))}`
    );
  }
  lines.push("");

  lines.push("## Appendix: Metadata a surové segmenty", "");
  lines.push("### Metadata dokumentu", "");
  lines.push("| Pole | Hodnota |");
  lines.push("| --- | --- |");
  lines.push(`| ID dokumentu | \`${document.id}\` |`);
  lines.push(`| Cesta ke zdroji | \`${escapeTableCell(replacePathSeparators(path.relative(options.paths.root, options.sourceDocumentPath)))}\` |`);
  lines.push(`| Primární segmenty | ${document.primarySegmentCount} |`);
  lines.push(`| Kontextové segmenty | ${document.contextSegmentCount} |`);
  lines.push(`| Priorita zdroje | ${document.sourcePriority} |`);
  lines.push("");

  lines.push("### Surové segmenty", "");
  if (options.segments.length === 0) {
    lines.push("_Zatím bez dostupných normalizovaných segmentů._", "");
  } else {
    for (const segment of [...options.segments].sort((left, right) => compareLocators(left.sourceRef.locator, right.sourceRef.locator))) {
      const locator = segment.sourceRef.locator;
      const anchorId = referenceAnchorId(locator);
      const sourceRefs = options.sourceRefsByLocator.get(locator) ?? [];
      const linkedClaims = options.claimRefsByLocator.get(locator) ?? [];
      const linkedThoughtLinks = dedupeByKey(
        linkedClaims
          .map((claim) => options.pageBySourceNodeId.get(claim.nodeId))
          .filter((page): page is ThoughtPageInfo => page !== undefined),
        (page) => page.node.id
      );

      lines.push(`<a id="${anchorId}"></a>`);
      lines.push(`### ${locator}`, "");
      lines.push(blockquote(segment.text), "");
      lines.push(
        `Signál: ${segment.signalKind} · Autor: ${segment.authorKind} · Pořadí: ${segment.sequenceIndex}`
      );
      lines.push("");

      if (linkedThoughtLinks.length > 0) {
        lines.push("Propojené myšlenky:");
        for (const page of linkedThoughtLinks) {
          lines.push(`- ${markdownLink(page.node.title, relativeLink(targetPath, page.targetPath))}`);
        }
        lines.push("");
      }

      if (sourceRefs.length > 1) {
        lines.push(`Další odkazy na stejném locatoru: ${sourceRefs.length}`, "");
      }
    }
  }

  return lines.join("\n");
}

function buildChronologyPage(options: {
  paths: ProjectPaths;
  nodes: ConsolidatedThoughtNode[];
  pageByNodeId: Map<string, ThoughtPageInfo>;
  targetPath: string;
  summaryLines?: string[];
  pagination?: string;
}): string {
  const grouped = new Map<string, ConsolidatedThoughtNode[]>();
  for (const node of options.nodes) {
    const bucketKey = node.firstSeen ? node.firstSeen.slice(0, 7) : "unknown";
    const bucket = grouped.get(bucketKey) ?? [];
    bucket.push(node);
    grouped.set(bucketKey, bucket);
  }

  const lines: string[] = [
    "# Chronologie myšlenek",
    "",
    "> Chronologie podle prvního výskytu konsolidovaných myšlenek.",
    `> Navigace: ${markdownLink("Wiki", relativeLink(options.targetPath, path.join(options.paths.wikiDir, "index.md")))}`,
    "",
    ...(options.summaryLines ?? []),
    ...(options.summaryLines?.length ? [""] : []),
    ...(options.pagination ? [`**${options.pagination}**`, ""] : [])
  ];

  for (const bucketKey of Array.from(grouped.keys()).sort((left, right) => right.localeCompare(left))) {
    lines.push(`## ${bucketKey}`, "");
    lines.push("| Myšlenka | Typ | Stav | Poprvé | Naposledy |");
    lines.push("| --- | --- | --- | --- | --- |");

    const bucket = grouped.get(bucketKey) ?? [];
    for (const node of bucket.sort((left, right) => {
      const firstComparison = compareDates(left.firstSeen, right.firstSeen);
      if (firstComparison !== 0) {
        return firstComparison;
      }
      return left.title.localeCompare(right.title);
    })) {
      const page = options.pageByNodeId.get(node.id);
      if (!page) {
        continue;
      }
      lines.push(
        `| ${markdownLink(node.title, relativeLink(options.targetPath, page.targetPath))} | ${TYPE_DESCRIPTIONS[node.nodeType].singular} | ${STATUS_LABELS[node.status]} | ${formatDate(node.firstSeen)} | ${formatDate(node.lastSeen)} |`
      );
    }

    lines.push("");
  }

  if (options.pagination) {
    lines.push(`**${options.pagination}**`, "");
  }

  return lines.join("\n");
}

function buildReferencesIndexPage(options: {
  paths: ProjectPaths;
  referencedDocuments: UnifiedDocument[];
  referenceByDocumentId: Map<string, ReferencePageInfo>;
  nodesByDocumentId: Map<string, ConsolidatedThoughtNode[]>;
  targetPath: string;
}): string {
  const lines: string[] = [
    "# Zdrojové reference",
    "",
    "> Dokumentový index pro dohledání textů, z nichž jsou wiki stránky složené.",
    `> Navigace: ${markdownLink("Wiki", relativeLink(options.targetPath, path.join(options.paths.wikiDir, "index.md")))}`,
    "",
    "Tyto stránky jsou hlavně podpůrná vrstva pro čtení důkazů a návrat k původním pasážím.",
    "",
    "| Dokument | Zdrojový typ | Datum | Myšlenky | Primární segmenty |",
    "| --- | --- | --- | ---: | ---: |"
  ];

  for (const document of [...options.referencedDocuments].sort((left, right) => {
    const timeComparison = compareDates(left.time, right.time);
    if (timeComparison !== 0) {
      return timeComparison;
    }
    return left.title.localeCompare(right.title);
  })) {
    const page = options.referenceByDocumentId.get(document.id);
    if (!page) {
      continue;
    }
    const thoughtCount = options.nodesByDocumentId.get(document.id)?.length ?? 0;
    lines.push(
      `| ${markdownLink(document.title, relativeLink(options.targetPath, page.targetPath))} | ${formatSourceKind(document.sourceKind)} | ${formatDate(document.time)} | ${thoughtCount} | ${document.primarySegmentCount} |`
    );
  }

  lines.push("");
  return lines.join("\n");
}

function buildGraphDiagnosticsPage(options: {
  paths: ProjectPaths;
  compilation: ThoughtCompilationArtifacts;
  consolidatedGraph: ConsolidatedThoughtGraph;
  pageByNodeId: Map<string, ThoughtPageInfo>;
  targetPath: string;
}): string {
  const topEdges = [...options.consolidatedGraph.edges]
    .sort((left, right) => {
      if (left.weight !== right.weight) {
        return right.weight - left.weight;
      }
      return left.id.localeCompare(right.id);
    })
    .slice(0, 25);
  const topNodes = [...options.consolidatedGraph.nodes]
    .sort((left, right) => {
      if (left.relatedNodeIds.length !== right.relatedNodeIds.length) {
        return right.relatedNodeIds.length - left.relatedNodeIds.length;
      }
      return left.title.localeCompare(right.title);
    })
    .slice(0, 20);

  const lines: string[] = [
    "# Diagnostika grafu",
    "",
    "> Strukturální diagnostika konsolidovaného thought graphu.",
    `> Navigace: ${markdownLink("Wiki", relativeLink(options.targetPath, path.join(options.paths.wikiDir, "index.md")))}`,
    "",
    "## Snapshot",
    "",
    "| Vrstva | Počet |",
    "| --- | ---: |",
    `| Granulární uzly | ${options.compilation.graph.nodeCount} |`,
    `| Granulární hrany | ${options.compilation.graph.edgeCount} |`,
    `| Tvrzení | ${options.compilation.graph.claimCount} |`,
    `| Stavy | ${options.compilation.graph.nodeStateCount} |`,
    `| Vývojové linie | ${options.compilation.graph.worldlineCount} |`,
    `| Konsolidované uzly | ${options.consolidatedGraph.nodeCount} |`,
    `| Konsolidované hrany | ${options.consolidatedGraph.edgeCount} |`,
    "",
    "## Nejpropojenější myšlenky",
    "",
    "| Myšlenka | Typ | Související myšlenky | Claims | Stavy |",
    "| --- | --- | ---: | ---: | ---: |"
  ];

  for (const node of topNodes) {
    const page = options.pageByNodeId.get(node.id);
    if (!page) {
      continue;
    }

    lines.push(
      `| ${markdownLink(node.title, relativeLink(options.targetPath, page.targetPath))} | ${TYPE_DESCRIPTIONS[node.nodeType].singular} | ${node.relatedNodeIds.length} | ${node.memberClaimIds.length} | ${node.memberStateIds.length} |`
    );
  }

  lines.push("", "## Nejsilnější vztahy", "", "| Odkud | Vztah | Kam | Váha |", "| --- | --- | --- | ---: |");

  for (const edge of topEdges) {
    const fromPage = options.pageByNodeId.get(edge.from);
    const toPage = options.pageByNodeId.get(edge.to);
    if (!fromPage || !toPage) {
      continue;
    }

    lines.push(
      `| ${markdownLink(fromPage.node.title, relativeLink(options.targetPath, fromPage.targetPath))} | ${RELATION_LABELS[edge.type]} | ${markdownLink(toPage.node.title, relativeLink(options.targetPath, toPage.targetPath))} | ${edge.weight} |`
    );
  }

  lines.push("");
  return lines.join("\n");
}

function buildWritingOutlinePage(options: {
  paths: ProjectPaths;
  outline: ThoughtDocumentOutline;
  targetPath: string;
  verticalIndexPath: string;
  documentById: Map<string, UnifiedDocument>;
  frameById: Map<string, ThoughtDocumentFrame>;
  subframeById: Map<string, ThoughtDocumentSubframe>;
  localFramePageById: Map<string, VerticalFramePageInfo>;
  nodes: ConsolidatedThoughtNode[];
}): string {
  const document = options.documentById.get(options.outline.documentId);
  const containerNoun = formatSourceLocalContainerNoun(options.outline.sourceKind);
  const lines: string[] = [
    `# ${options.outline.label}`,
    "",
    `> Lokální outline jednoho ${containerNoun}u.`,
    `> Navigace: ${markdownLink("Wiki", relativeLink(options.targetPath, path.join(options.paths.wikiDir, "index.md")))} · ${markdownLink("Vertikální mapa", relativeLink(options.targetPath, options.verticalIndexPath))}`,
    "",
    "## Přehled",
    "",
    options.outline.summary,
    "",
    "## Metadata outline",
    "",
    "| Pole | Hodnota |",
    "| --- | --- |",
    `| Dokument | ${document ? markdownLink(document.title, relativeLink(options.targetPath, path.join(options.paths.wikiReferencesDir, referencePageFilename(document)))) : options.outline.documentId} |`,
    `| Hlavní rámce | ${options.outline.frameIds.length} |`,
    `| Kroky outline | ${options.outline.steps.length} |`,
    ""
  ];

  lines.push("## Lokální spine", "");
  if (options.outline.steps.length === 0) {
    lines.push("_Tato outline zatím nemá kroky._", "");
  } else {
    lines.push("| Pořadí | Rámec | Role v textu | Návrat k | Rozsah | Myšlenky | Proč je ten krok tady |");
    lines.push("| ---: | --- | --- | --- | --- | ---: | --- |");
    for (const step of options.outline.steps
      .slice()
      .sort((left, right) => left.orderIndex - right.orderIndex)) {
      const frame = options.frameById.get(step.frameId);
      if (!frame) {
        continue;
      }
      const framePage = options.localFramePageById.get(frame.id);
      const returnsToFrame = step.returnsToFrameId
        ? options.frameById.get(step.returnsToFrameId) ?? null
        : null;
      const memberNodes = options.nodes.filter((node) =>
        (node.frameMemberships ?? []).some((membership) => membership.frameId === frame.id)
      );
      const frameLabel = framePage
        ? markdownLink(frame.label, relativeLink(options.targetPath, framePage.targetPath))
        : frame.label;
      const returnLabel =
        returnsToFrame === null
          ? ""
          : options.localFramePageById.get(returnsToFrame.id)
            ? markdownLink(
                returnsToFrame.label,
                relativeLink(
                  options.targetPath,
                  options.localFramePageById.get(returnsToFrame.id)!.targetPath
                )
              )
            : returnsToFrame.label;
      lines.push(
        `| ${step.orderIndex + 1} | ${frameLabel} | ${formatOutlineRole(step.role)} | ${returnLabel} | ${formatSequenceRange(frame.startSequenceIndex, frame.endSequenceIndex, frame.sourceKind)} | ${memberNodes.length} | ${step.rationale} |`
      );
    }
    lines.push("");
  }

  lines.push("## Rámce v pořadí", "");
  for (const step of options.outline.steps
    .slice()
    .sort((left, right) => left.orderIndex - right.orderIndex)) {
    const frame = options.frameById.get(step.frameId);
    if (!frame) {
      continue;
    }
    const framePage = options.localFramePageById.get(frame.id);
    const heading = framePage
      ? markdownLink(frame.label, relativeLink(options.targetPath, framePage.targetPath))
      : frame.label;
    const subframes = frame.subframeIds
      .map((subframeId) => options.subframeById.get(subframeId))
      .filter((subframe): subframe is ThoughtDocumentSubframe => Boolean(subframe));
    const memberNodes = options.nodes
      .filter((node) => (node.frameMemberships ?? []).some((membership) => membership.frameId === frame.id))
      .sort((left, right) => left.title.localeCompare(right.title));

    lines.push(`### ${step.orderIndex + 1}. ${heading}`, "");
    lines.push(`- Role v textu: ${formatOutlineRole(step.role)}`);
    lines.push(`- Rozsah: ${formatSequenceRange(frame.startSequenceIndex, frame.endSequenceIndex, frame.sourceKind)}`);
    if (step.returnsToFrameId) {
      const returnsToFrame = options.frameById.get(step.returnsToFrameId);
      lines.push(`- Návrat k: ${returnsToFrame?.label ?? step.returnsToFrameId}`);
    }
    lines.push(`- Rationale: ${step.rationale}`);
    if (subframes.length > 0) {
      lines.push(`- Podrámce: ${previewJoined(subframes.map((subframe) => subframe.label), 6)}`);
    }
    if (memberNodes.length > 0) {
      lines.push(`- Navázané myšlenky: ${previewJoined(memberNodes.map((node) => node.title), 8)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildLocalFramePage(options: {
  paths: ProjectPaths;
  frame: ThoughtDocumentFrame;
  targetPath: string;
  verticalIndexPath: string;
  documentById: Map<string, UnifiedDocument>;
  subframeById: Map<string, ThoughtDocumentSubframe>;
  localSubframePageById: Map<string, VerticalFramePageInfo>;
  pageByNodeId: Map<string, ThoughtPageInfo>;
  nodes: ConsolidatedThoughtNode[];
}): string {
  const document = options.documentById.get(options.frame.documentId);
  const memberNodes = options.nodes
    .filter((node) => (node.frameMemberships ?? []).some((membership) => membership.frameId === options.frame.id))
    .sort((left, right) => left.title.localeCompare(right.title));
  const lines: string[] = [
    `# ${options.frame.label}`,
    "",
    `> Lokální ${formatFrameKind("frame")} uvnitř jednoho ${formatSourceLocalContainerNoun(options.frame.sourceKind)}u.`,
    `> Navigace: ${markdownLink("Wiki", relativeLink(options.targetPath, path.join(options.paths.wikiDir, "index.md")))} · ${markdownLink("Vertikální mapa", relativeLink(options.targetPath, options.verticalIndexPath))}`,
    "",
    "## Přehled",
    "",
    options.frame.summary,
    "",
    "## Metadata rámce",
    "",
    "| Pole | Hodnota |",
    "| --- | --- |",
    `| Dokument | ${document ? markdownLink(document.title, relativeLink(options.targetPath, path.join(options.paths.wikiReferencesDir, referencePageFilename(document)))) : options.frame.documentId} |`,
    `| Scope | ${formatFrameScope(options.frame.scope)} |`,
    `| Rozsah | ${formatSequenceRange(options.frame.startSequenceIndex, options.frame.endSequenceIndex, options.frame.sourceKind)} |`,
    `| Podrámce | ${options.frame.subframeIds.length} |`,
    ""
  ];

  lines.push("## Podrámce", "");
  if (options.frame.subframeIds.length === 0) {
    lines.push("_Tento rámec nemá samostatné podrámce._", "");
  } else {
    for (const subframeId of options.frame.subframeIds) {
      const subframe = options.subframeById.get(subframeId);
      if (!subframe) {
        continue;
      }
      const subframePage = options.localSubframePageById.get(subframe.id);
      const label = subframePage
        ? markdownLink(subframe.label, relativeLink(options.targetPath, subframePage.targetPath))
        : subframe.label;
      lines.push(`- ${label} · ${formatSequenceRange(subframe.startSequenceIndex, subframe.endSequenceIndex, subframe.sourceKind)}`);
    }
    lines.push("");
  }

  lines.push("## Navázané myšlenky", "");
  if (memberNodes.length === 0) {
    lines.push("_Zatím bez navázaných konsolidovaných myšlenek._", "");
  } else {
    for (const node of memberNodes) {
      const page = options.pageByNodeId.get(node.id);
      if (!page) {
        continue;
      }
      lines.push(`- ${markdownLink(node.title, relativeLink(options.targetPath, page.targetPath))}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildLocalSubframePage(options: {
  paths: ProjectPaths;
  subframe: ThoughtDocumentSubframe;
  targetPath: string;
  verticalIndexPath: string;
  documentById: Map<string, UnifiedDocument>;
  frameById: Map<string, ThoughtDocumentFrame>;
  localFramePageById: Map<string, VerticalFramePageInfo>;
  pageByNodeId: Map<string, ThoughtPageInfo>;
  nodes: ConsolidatedThoughtNode[];
}): string {
  const document = options.documentById.get(options.subframe.documentId);
  const parentFrame = options.frameById.get(options.subframe.frameId);
  const parentFramePage = parentFrame ? options.localFramePageById.get(parentFrame.id) : undefined;
  const memberNodes = options.nodes
    .filter((node) => (node.frameMemberships ?? []).some((membership) => membership.subframeId === options.subframe.id))
    .sort((left, right) => left.title.localeCompare(right.title));
  const lines: string[] = [
    `# ${options.subframe.label}`,
    "",
    `> Lokální ${formatFrameKind("subframe")} uvnitř jednoho ${formatSourceLocalContainerNoun(options.subframe.sourceKind)}u.`,
    `> Navigace: ${markdownLink("Wiki", relativeLink(options.targetPath, path.join(options.paths.wikiDir, "index.md")))} · ${markdownLink("Vertikální mapa", relativeLink(options.targetPath, options.verticalIndexPath))}`,
    "",
    "## Přehled",
    "",
    options.subframe.summary,
    "",
    "## Metadata podrámce",
    "",
    "| Pole | Hodnota |",
    "| --- | --- |",
    `| Dokument | ${document ? markdownLink(document.title, relativeLink(options.targetPath, path.join(options.paths.wikiReferencesDir, referencePageFilename(document)))) : options.subframe.documentId} |`,
    `| Nadřazený rámec | ${parentFrame && parentFramePage ? markdownLink(parentFrame.label, relativeLink(options.targetPath, parentFramePage.targetPath)) : parentFrame?.label ?? options.subframe.frameId} |`,
    `| Rozsah | ${formatSequenceRange(options.subframe.startSequenceIndex, options.subframe.endSequenceIndex, options.subframe.sourceKind)} |`,
    ""
  ];

  lines.push("## Navázané myšlenky", "");
  if (memberNodes.length === 0) {
    lines.push("_Zatím bez navázaných konsolidovaných myšlenek._", "");
  } else {
    for (const node of memberNodes) {
      const page = options.pageByNodeId.get(node.id);
      if (!page) {
        continue;
      }
      lines.push(`- ${markdownLink(node.title, relativeLink(options.targetPath, page.targetPath))}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildVerticalFamilyPage(options: {
  paths: ProjectPaths;
  family: ThoughtFrameAlignmentFamily;
  targetPath: string;
  pageByNodeId: Map<string, ThoughtPageInfo>;
  verticalIndexPath: string;
  frameById: Map<string, ThoughtDocumentFrame>;
  subframeById: Map<string, ThoughtDocumentSubframe>;
  documentById: Map<string, UnifiedDocument>;
  localFramePageById: Map<string, VerticalFramePageInfo>;
  localSubframePageById: Map<string, VerticalFramePageInfo>;
}): string {
  const lines: string[] = [
    `# ${options.family.label}`,
    "",
    "> Sdílená rodina napříč více texty.",
    `> Navigace: ${markdownLink("Wiki", relativeLink(options.targetPath, path.join(options.paths.wikiDir, "index.md")))} · ${markdownLink("Vertikální mapa", relativeLink(options.targetPath, options.verticalIndexPath))}`,
    "",
    "## Přehled",
    "",
    `Rodina spojuje ${options.family.memberFrameIds.length} lokálních rámců napříč ${options.family.memberDocumentIds.length} texty. Je to první sdílená vertikální vrstva nad zdrojově lokální strukturou jednotlivých textů.`,
    "",
    "## Co tato rodina drží pohromadě",
    "",
    "Rodina ukazuje, že několik lokálních rámců z různých textů není jen vedle sebe, ale patří do jednoho vyššího tematického celku.",
    "",
    "## Přehled metadat",
    "",
    "| Pole | Hodnota |",
    "| --- | --- |",
    `| Dokumenty | ${options.family.memberDocumentIds.length} |`,
    `| Rámce | ${options.family.memberFrameIds.length} |`,
    `| Navázané myšlenky | ${options.family.supportingNodeCount} |`,
    `| Anchor tokeny | ${escapeTableCell(options.family.anchorTokens.join(", ") || "n/a")} |`,
    "",
    "## Lokální rámce v rodině",
    ""
  ];

  for (const frameId of options.family.memberFrameIds) {
    const frame = options.frameById.get(frameId);
    if (!frame) {
      continue;
    }
    const framePage = options.localFramePageById.get(frame.id);
    const frameLabel = framePage
      ? markdownLink(frame.label, relativeLink(options.targetPath, framePage.targetPath))
      : frame.label;
    const document = options.documentById.get(frame.documentId);
    lines.push(
      `- ${frameLabel} · ${document?.title ?? frame.documentId} · ${formatSequenceRange(frame.startSequenceIndex, frame.endSequenceIndex, frame.sourceKind)} · úroveň ${formatFrameScope(frame.scope)}`
    );
    for (const subframeId of frame.subframeIds) {
      if (!options.family.memberSubframeIds.includes(subframeId)) {
        continue;
      }
      const subframe = options.subframeById.get(subframeId);
      if (!subframe) {
        continue;
      }
      const subframePage = options.localSubframePageById.get(subframe.id);
      const subframeLabel = subframePage
        ? markdownLink(subframe.label, relativeLink(options.targetPath, subframePage.targetPath))
        : subframe.label;
      lines.push(`  - ${subframeLabel} · ${formatSequenceRange(subframe.startSequenceIndex, subframe.endSequenceIndex, subframe.sourceKind)}`);
    }
  }

  lines.push("", "## Členské myšlenky", "");

  if (options.family.memberNodeIds.length === 0) {
    lines.push("_Zatím bez členských consolidated nodes._", "");
  } else {
    for (const nodeId of options.family.memberNodeIds) {
      const thoughtPage = options.pageByNodeId.get(nodeId);
      if (!thoughtPage) {
        continue;
      }
      lines.push(`- ${markdownLink(thoughtPage.node.title, relativeLink(options.targetPath, thoughtPage.targetPath))}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildVerticalPatternPage(options: {
  paths: ProjectPaths;
  pattern: ThoughtHigherOrderPattern;
  targetPath: string;
  verticalIndexPath: string;
  familyPageById: Map<string, { targetPath: string; family: ThoughtFrameAlignmentFamily }>;
}): string {
  const lines: string[] = [
    `# ${options.pattern.label}`,
    "",
    "> Vyšší vzor nad několika sdílenými rodinami.",
    `> Navigace: ${markdownLink("Wiki", relativeLink(options.targetPath, path.join(options.paths.wikiDir, "index.md")))} · ${markdownLink("Vertikální mapa", relativeLink(options.targetPath, options.verticalIndexPath))}`,
    "",
    "## Přehled",
    "",
    `Vyšší vzor sdružuje ${options.pattern.familyIds.length} rodin napříč ${options.pattern.documentIds.length} dokumenty. Je to širší makro vrstva nad užšími sdílenými rodinami.`,
    "",
    "## Co tento vzor znamená",
    "",
    "Vyšší vzor je nejširší vertikální seskupení v tomto běhu. Nesnaží se nahradit konkrétní myšlenky, ale ukazuje, které užší rodiny patří pod jeden širší tematický blok.",
    "",
    "## Přehled metadat",
    "",
    "| Pole | Hodnota |",
    "| --- | --- |",
    `| Rodiny | ${options.pattern.familyIds.length} |`,
    `| Dokumenty | ${options.pattern.documentIds.length} |`,
    `| Myšlenky | ${options.pattern.nodeIds.length} |`,
    `| Anchor tokeny | ${escapeTableCell(options.pattern.anchorTokens.join(", ") || "n/a")} |`,
    "",
    "## Členské rodiny",
    ""
  ];

  for (const familyId of options.pattern.familyIds) {
    const familyPage = options.familyPageById.get(familyId);
    if (!familyPage) {
      continue;
    }
    lines.push(`- ${markdownLink(familyPage.family.label, relativeLink(options.targetPath, familyPage.targetPath))}`);
  }
  lines.push("");
  return lines.join("\n");
}

function buildVerticalIndexPage(options: {
  paths: ProjectPaths;
  targetPath: string;
  frameAlignment: ThoughtFrameAlignmentArtifact | null;
  localFrameCount: number;
  localSubframeCount: number;
  outlinePageByDocumentId: Map<string, VerticalOutlinePageInfo>;
  familyPageById: Map<string, { targetPath: string; family: ThoughtFrameAlignmentFamily }>;
  patternPageById: Map<string, { targetPath: string; pattern: ThoughtHigherOrderPattern }>;
}): string {
  const patterns = options.frameAlignment?.patterns ?? [];
  const families = options.frameAlignment?.families ?? [];
  const lines: string[] = [
    "# Vertikální mapa",
    "",
    "> Zdrojově ukotvená vertikální vrstva nad lokálními rámci textů a konsolidovanými myšlenkami.",
    `> Navigace: ${markdownLink("Wiki", relativeLink(options.targetPath, path.join(options.paths.wikiDir, "index.md")))}`,
    "",
    "## Přehled",
    "",
    "Tato stránka ukazuje vertikální osu wiki od lokálních rámců uvnitř textů až po širší sdílené rodiče napříč více texty.",
    "",
    "## Legenda",
    "",
    "1. Lokální outlines drží jeden zdroj jako jeden celek se svou vlastní spine.",
    "2. Hlavní rámce a podrámce vznikají uvnitř jednotlivých zdrojů.",
    "3. Sdílené rodiny spojují podobné writing-local rámce napříč texty.",
    "4. Vyšší vzory jsou nejširší vertikální vrstva nad několika rodinami.",
    "5. Konkrétní thought pages pak drží i horizontální vztahy napříč grafem.",
    "",
    "| Vrstva | Počet |",
    "| --- | ---: |",
    `| Lokální outlines zdrojů | ${options.outlinePageByDocumentId.size} |`,
    `| Hlavní rámce | ${options.localFrameCount} |`,
    `| Podrámce | ${options.localSubframeCount} |`,
    `| Sdílené rodiny napříč texty | ${options.frameAlignment?.familyCount ?? 0} |`,
    `| Vyšší vzory | ${options.frameAlignment?.patternCount ?? 0} |`,
    "",
    "## Lokální osnovy zdrojů",
    ""
  ];

  if (options.outlinePageByDocumentId.size === 0) {
    lines.push("_Zatím bez lokálních osnov zdrojů._", "");
  } else {
    lines.push("| Zdroj | Typ | Outline |");
    lines.push("| --- | --- | --- |");
    for (const page of Array.from(options.outlinePageByDocumentId.values()).sort((left, right) =>
      left.label.localeCompare(right.label)
    )) {
      lines.push(
        `| ${page.label} | ${formatSourceKind(page.sourceKind)} | ${markdownLink("otevřít outline", relativeLink(options.targetPath, page.targetPath))} |`
      );
    }
    lines.push("");
  }

  lines.push(
    "## Vyšší vzory",
    ""
  );

  if (patterns.length === 0) {
    lines.push("_Zatím bez vyšších vzorů._", "");
  } else {
    lines.push("| Vzor | Rodiny | Dokumenty | Myšlenky |");
    lines.push("| --- | ---: | ---: | ---: |");
    for (const pattern of patterns
      .slice()
      .sort((left, right) => {
        if (left.familyIds.length !== right.familyIds.length) {
          return right.familyIds.length - left.familyIds.length;
        }
        return left.label.localeCompare(right.label);
      })) {
      const page = options.patternPageById.get(pattern.id);
      const label = page
        ? markdownLink(pattern.label, relativeLink(options.targetPath, page.targetPath))
        : pattern.label;
      lines.push(`| ${label} | ${pattern.familyIds.length} | ${pattern.documentIds.length} | ${pattern.nodeIds.length} |`);
    }
    lines.push("");
  }

  lines.push("## Sdílené rodiny napříč texty", "");
  lines.push("| Rodina | Dokumenty | Rámce | Myšlenky |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const family of families
    .slice()
    .sort((left, right) => {
      if (left.memberDocumentIds.length !== right.memberDocumentIds.length) {
        return right.memberDocumentIds.length - left.memberDocumentIds.length;
      }
      if (left.supportingNodeCount !== right.supportingNodeCount) {
        return right.supportingNodeCount - left.supportingNodeCount;
      }
      return left.label.localeCompare(right.label);
    })) {
    const page = options.familyPageById.get(family.id);
    const label = page ? markdownLink(family.label, relativeLink(options.targetPath, page.targetPath)) : family.label;
    lines.push(`| ${label} | ${family.memberDocumentIds.length} | ${family.memberFrameIds.length} | ${family.supportingNodeCount} |`);
  }
  lines.push("");

  return lines.join("\n");
}

function buildValidationWikiArtifacts(
  inputs: ValidationWikiInputs,
  paths: ProjectPaths
): ValidationWikiArtifacts {
  const generatedAt = new Date().toISOString();
  const files: RenderedWikiFile[] = [];
  const documentById = new Map(inputs.corpus.documents.map((document) => [document.id, document]));
  const segmentBySourceRefKey = new Map<string, UnifiedSegment>(
    inputs.corpus.segments.map((segment) => [sourceRefKey(segment.sourceRef), segment])
  );
  const claimsById = new Map(inputs.compilation.claims.map((claim) => [claim.id, claim]));
  const statesById = new Map(inputs.compilation.nodeStates.map((state) => [state.id, state]));
  const worldlinesById = new Map(inputs.compilation.worldlines.map((worldline) => [worldline.id, worldline]));
  const identityBlocksByCanonicalKey = new Map(
    inputs.compilation.identityBlocks.map((identityBlock) => [identityBlock.canonicalKey, identityBlock])
  );
  const frameById = new Map((inputs.compilation.documentFrames?.frames ?? []).map((frame) => [frame.id, frame]));
  const subframeById = new Map(
    (inputs.compilation.documentFrames?.subframes ?? []).map((subframe) => [subframe.id, subframe])
  );
  const pageByNodeId = new Map<string, ThoughtPageInfo>();
  const pageBySourceNodeId = new Map<string, ThoughtPageInfo>();
  const outlinePageByDocumentId = new Map<string, VerticalOutlinePageInfo>();
  const localFramePageById = new Map<string, VerticalFramePageInfo>();
  const localSubframePageById = new Map<string, VerticalFramePageInfo>();
  const verticalFamilyPageById = new Map<string, { targetPath: string; family: ThoughtFrameAlignmentFamily }>();
  const verticalPatternPageById = new Map<string, { targetPath: string; pattern: ThoughtHigherOrderPattern }>();
  const alignmentFamiliesByNodeId = new Map<string, ThoughtFrameAlignmentFamily[]>();
  const alignmentPatternsByNodeId = new Map<string, ThoughtHigherOrderPattern[]>();
  const constellationPageById = new Map<string, MacroPageInfo<ThoughtMacroConstellation>>();
  const trajectoryPageById = new Map<string, MacroPageInfo<ThoughtMacroTrajectory>>();
  const macroMembershipsByNodeId = new Map<
    string,
    Array<{
      constellation: ThoughtMacroConstellation;
      member: ThoughtMacroConstellation["members"][number];
      targetPath: string;
    }>
  >();
  const macroTrajectoriesByNodeId = new Map<
    string,
    Array<{
      trajectory: ThoughtMacroTrajectory;
      targetPath: string;
      stageLabels: string[];
    }>
  >();
  const macroAssessmentByNodeId = new Map(
    (inputs.macroMap?.nodeAssessments ?? []).map((assessment) => [assessment.nodeId, assessment])
  );
  const atlasDir = path.join(paths.wikiDir, "atlas");
  const trajectoriesDir = path.join(paths.wikiDir, "trajectories");
  const verticalRootDir = path.join(paths.wikiDir, "vertical");
  const verticalDocumentsDir = path.join(verticalRootDir, "documents");
  const verticalFramesDir = path.join(verticalRootDir, "frames");
  const verticalSubframesDir = path.join(verticalRootDir, "subframes");
  const verticalFamiliesDir = path.join(verticalRootDir, "families");
  const verticalPatternsDir = path.join(verticalRootDir, "patterns");
  const verticalIndexPath = path.join(paths.wikiIndexesDir, "vertical_alignment.md");

  for (const node of inputs.consolidatedGraph.nodes) {
    const directory = TYPE_DESCRIPTIONS[node.nodeType].directory(paths);
    const targetPath = path.join(directory, thoughtPageFilename(node));
    const pageInfo = {
      node,
      targetPath,
      relativePath: wikiRelativePath(paths, targetPath)
    } satisfies ThoughtPageInfo;
    pageByNodeId.set(node.id, pageInfo);
    for (const memberNodeId of node.memberNodeIds) {
      pageBySourceNodeId.set(memberNodeId, pageInfo);
    }
  }

  if (inputs.macroMap) {
    for (const constellation of inputs.macroMap.constellations) {
      const targetPath = path.join(atlasDir, macroPageFilename(constellation));
      const page = {
        item: constellation,
        targetPath,
        relativePath: wikiRelativePath(paths, targetPath)
      } satisfies MacroPageInfo<ThoughtMacroConstellation>;
      constellationPageById.set(constellation.id, page);
      for (const member of constellation.members) {
        const bucket = macroMembershipsByNodeId.get(member.nodeId) ?? [];
        bucket.push({ constellation, member, targetPath });
        macroMembershipsByNodeId.set(member.nodeId, bucket);
      }
    }

    for (const trajectory of inputs.macroMap.trajectories) {
      const targetPath = path.join(trajectoriesDir, macroPageFilename(trajectory));
      const page = {
        item: trajectory,
        targetPath,
        relativePath: wikiRelativePath(paths, targetPath)
      } satisfies MacroPageInfo<ThoughtMacroTrajectory>;
      trajectoryPageById.set(trajectory.id, page);
      const stageLabelsByNodeId = new Map<string, string[]>();
      for (const stage of trajectory.stages) {
        for (const nodeId of stage.nodeIds) {
          const labels = stageLabelsByNodeId.get(nodeId) ?? [];
          labels.push(stage.label);
          stageLabelsByNodeId.set(nodeId, labels);
        }
      }
      const trajectoryNodeIds = new Set([
        ...stageLabelsByNodeId.keys(),
        ...trajectory.currentPositionNodeIds,
        ...trajectory.openTensionNodeIds
      ]);
      for (const nodeId of trajectoryNodeIds) {
        const bucket = macroTrajectoriesByNodeId.get(nodeId) ?? [];
        bucket.push({
          trajectory,
          targetPath,
          stageLabels: stageLabelsByNodeId.get(nodeId) ?? []
        });
        macroTrajectoriesByNodeId.set(nodeId, bucket);
      }
    }
  }

  for (const frame of frameById.values()) {
    const targetPath = path.join(verticalFramesDir, verticalFrameFilename(frame, "frame"));
    localFramePageById.set(frame.id, {
      id: frame.id,
      label: frame.label,
      targetPath,
      relativePath: wikiRelativePath(paths, targetPath),
      kind: "frame"
    });
  }

  for (const subframe of subframeById.values()) {
    const targetPath = path.join(verticalSubframesDir, verticalFrameFilename(subframe, "subframe"));
    localSubframePageById.set(subframe.id, {
      id: subframe.id,
      label: subframe.label,
      targetPath,
      relativePath: wikiRelativePath(paths, targetPath),
      kind: "subframe"
    });
  }

  for (const outline of inputs.compilation.documentFrames?.outlines ?? []) {
    const targetPath = path.join(verticalDocumentsDir, verticalOutlineFilename(outline));
    outlinePageByDocumentId.set(outline.documentId, {
      documentId: outline.documentId,
      label: outline.label,
      sourceKind: outline.sourceKind,
      targetPath,
      relativePath: wikiRelativePath(paths, targetPath)
    });
  }

  for (const outline of inputs.compilation.documentFrames?.outlines ?? []) {
    const page = outlinePageByDocumentId.get(outline.documentId);
    if (!page) {
      continue;
    }
    files.push({
      title: outline.label,
      kind: "index",
      targetPath: page.targetPath,
      relativePath: page.relativePath,
      summary: `Lokální outline zdroje ${outline.documentId}.`,
      contents: buildWritingOutlinePage({
        paths,
        outline,
        targetPath: page.targetPath,
        verticalIndexPath,
        documentById,
        frameById,
        subframeById,
        localFramePageById,
        nodes: inputs.consolidatedGraph.nodes
      })
    });
  }

  if (inputs.frameAlignment) {
    for (const family of inputs.frameAlignment.families) {
      verticalFamilyPageById.set(family.id, {
        targetPath: path.join(verticalFamiliesDir, verticalFamilyFilename(family)),
        family
      });
      for (const nodeId of family.memberNodeIds) {
        const bucket = alignmentFamiliesByNodeId.get(nodeId) ?? [];
        bucket.push(family);
        alignmentFamiliesByNodeId.set(nodeId, bucket);
      }
    }

    for (const pattern of inputs.frameAlignment.patterns) {
      verticalPatternPageById.set(pattern.id, {
        targetPath: path.join(verticalPatternsDir, verticalPatternFilename(pattern)),
        pattern
      });
      for (const nodeId of pattern.nodeIds) {
        const bucket = alignmentPatternsByNodeId.get(nodeId) ?? [];
        bucket.push(pattern);
        alignmentPatternsByNodeId.set(nodeId, bucket);
      }
    }
  }

  // Every normalized source gets a reference page. Vertical document pages
  // also exist for sources that produced no consolidated node, and must still
  // have a valid provenance target.
  const referencedDocumentIds = new Set(inputs.corpus.documents.map((document) => document.id));
  const referenceByDocumentId = new Map<string, ReferencePageInfo>();
  for (const documentId of Array.from(referencedDocumentIds)) {
    const document = documentById.get(documentId);
    if (!document) {
      continue;
    }
    const targetPath = path.join(paths.wikiReferencesDir, referencePageFilename(document));
    referenceByDocumentId.set(document.id, {
      document,
      targetPath,
      relativePath: wikiRelativePath(paths, targetPath)
    });
  }

  const edgesByNodeId = new Map<string, ConsolidatedThoughtEdge[]>();
  for (const edge of inputs.consolidatedGraph.edges) {
    const fromBucket = edgesByNodeId.get(edge.from) ?? [];
    fromBucket.push(edge);
    edgesByNodeId.set(edge.from, fromBucket);

    const toBucket = edgesByNodeId.get(edge.to) ?? [];
    toBucket.push(edge);
    edgesByNodeId.set(edge.to, toBucket);
  }

  const thoughtPageSummaryByNodeId = new Map<string, string>();

  for (const node of inputs.consolidatedGraph.nodes.sort((left, right) => left.title.localeCompare(right.title))) {
    const pageInfo = pageByNodeId.get(node.id);
    if (!pageInfo) {
      continue;
    }

    const identityMergeNotes = dedupeByKey(
      node.memberCanonicalKeys.flatMap((canonicalKey) => {
        const block = identityBlocksByCanonicalKey.get(canonicalKey);
        if (!block) {
          return [];
        }
        return block.mergeReasons.map((reason) => `${canonicalKey}: ${reason}`);
      }),
      (note) => note
    );
    const claims = node.memberClaimIds
      .map((claimId) => claimsById.get(claimId))
      .filter((claim): claim is ThoughtClaim => claim !== undefined);
    const states = node.memberStateIds
      .map((stateId) => statesById.get(stateId))
      .filter((state): state is ThoughtNodeState => state !== undefined);
    const pageSummary = buildThoughtPageSummaryFromEvidence({
      node,
      claims,
      states
    });
    thoughtPageSummaryByNodeId.set(node.id, pageSummary);

    files.push({
      title: node.title,
      kind: "thought",
      targetPath: pageInfo.targetPath,
      relativePath: pageInfo.relativePath,
      summary: pageSummary,
      nodeType: node.nodeType,
      nodeId: node.id,
      contents: buildThoughtPage({
        paths,
        node,
        targetPath: pageInfo.targetPath,
        claimsById,
        statesById,
        worldlinesById,
        pageByNodeId,
        referenceByDocumentId,
        documentById,
        segmentBySourceRefKey,
        edgesByNodeId,
        identityMergeNotes,
        pageSummary,
        localFramePageById,
        localSubframePageById,
        alignmentFamiliesByNodeId,
        alignmentPatternsByNodeId,
        verticalFamilyPageById: new Map(
          Array.from(verticalFamilyPageById.entries()).map(([id, value]) => [id, { targetPath: value.targetPath }])
        ),
        verticalPatternPageById: new Map(
          Array.from(verticalPatternPageById.entries()).map(([id, value]) => [id, { targetPath: value.targetPath }])
        ),
        macroMemberships: macroMembershipsByNodeId.get(node.id) ?? [],
        macroTrajectories: macroTrajectoriesByNodeId.get(node.id) ?? []
      })
    });
  }

  const nodesByDocumentId = new Map<string, ConsolidatedThoughtNode[]>();
  for (const node of inputs.consolidatedGraph.nodes) {
    for (const documentId of new Set(node.sourceRefs.map((sourceRef) => sourceRef.documentId))) {
      const bucket = nodesByDocumentId.get(documentId) ?? [];
      bucket.push(node);
      nodesByDocumentId.set(documentId, bucket);
    }
  }

  for (const referencePage of Array.from(referenceByDocumentId.values()).sort((left, right) =>
    left.document.title.localeCompare(right.document.title)
  )) {
    const segments = inputs.corpus.segments.filter(
      (segment) => segment.sourceRef.documentId === referencePage.document.id
    );
    const sourceRefsByLocator = new Map<string, UnifiedSourceRef[]>();
    for (const node of nodesByDocumentId.get(referencePage.document.id) ?? []) {
      for (const sourceRef of node.sourceRefs.filter(
        (candidate) => candidate.documentId === referencePage.document.id
      )) {
        const bucket = sourceRefsByLocator.get(sourceRef.locator) ?? [];
        bucket.push(sourceRef);
        sourceRefsByLocator.set(sourceRef.locator, bucket);
      }
    }

    const claimRefsByLocator = new Map<string, ThoughtClaim[]>();
    for (const claim of inputs.compilation.claims.filter(
      (candidate) => candidate.sourceRef.documentId === referencePage.document.id
    )) {
      const bucket = claimRefsByLocator.get(claim.sourceRef.locator) ?? [];
      bucket.push(claim);
      claimRefsByLocator.set(claim.sourceRef.locator, bucket);
    }

    files.push({
      title: referencePage.document.title,
      kind: "reference",
      targetPath: referencePage.targetPath,
      relativePath: referencePage.relativePath,
      summary: buildReferencePageSummary(
        referencePage.document,
        nodesByDocumentId.get(referencePage.document.id)?.length ?? 0
      ),
      documentId: referencePage.document.id,
      contents: buildReferencePage({
        paths,
        sourceDocumentPath: resolveSourceDocumentPath(
          inputs.sourcePaths,
          referencePage.document.sourcePath
        ),
        document: referencePage.document,
        targetPath: referencePage.targetPath,
        referencedNodes: nodesByDocumentId.get(referencePage.document.id) ?? [],
        outlinePageByDocumentId,
        pageByNodeId,
        pageBySourceNodeId,
        segments,
        sourceRefsByLocator,
        claimRefsByLocator
      })
    });
  }

  if (inputs.macroMap) {
    const atlasIndexPath = path.join(atlasDir, "index.md");
    files.push({
      title: "Konstelace atlasu",
      kind: "index",
      targetPath: atlasIndexPath,
      relativePath: wikiRelativePath(paths, atlasIndexPath),
      summary: "Přehled hlavních směrů, aktivních zkoumání a podpůrných oblastí osobního myšlení.",
      contents: buildAtlasIndexPage({
        macroMap: inputs.macroMap,
        targetPath: atlasIndexPath,
        constellationPageById
      })
    });

    for (const page of constellationPageById.values()) {
      const memberInventoryPath = page.targetPath.replace(/\.md$/, "-members.md");
      files.push({
        title: page.item.title,
        kind: "constellation",
        targetPath: page.targetPath,
        relativePath: page.relativePath,
        summary: page.item.summary,
        contents: buildConstellationPage({
          paths,
          constellation: page.item,
          targetPath: page.targetPath,
          memberInventoryPath,
          pageByNodeId,
          assessmentByNodeId: macroAssessmentByNodeId,
          trajectoryPageById,
          trajectories: inputs.macroMap.trajectories
        })
      });
      files.push({
        title: `Členové · ${page.item.title}`,
        kind: "index",
        targetPath: memberInventoryPath,
        relativePath: wikiRelativePath(paths, memberInventoryPath),
        summary: `Úplný auditní inventář ${page.item.memberNodeIds.length} členů konstelace ${page.item.title}.`,
        contents: buildConstellationMembersPage({
          constellation: page.item,
          targetPath: memberInventoryPath,
          constellationPath: page.targetPath,
          pageByNodeId,
          assessmentByNodeId: macroAssessmentByNodeId
        })
      });
    }

    const trajectoryIndexPath = path.join(trajectoriesDir, "index.md");
    files.push({
      title: "Vývojové trajektorie",
      kind: "index",
      targetPath: trajectoryIndexPath,
      relativePath: wikiRelativePath(paths, trajectoryIndexPath),
      summary: "Časové a argumentační posuny napříč konstelacemi myšlení.",
      contents: [
        "# Vývojové trajektorie",
        "",
        `> Navigace: ${markdownLink("Mapa myšlení", relativeLink(trajectoryIndexPath, path.join(paths.wikiDir, "index.md")))}`,
        "",
        "Trajektorie ukazují, jak se formulace a těžiště mění. Nejde o tematické seznamy, ale o čitelné cesty mezi dřívějšími a současnými pozicemi.",
        "",
        "| Trajektorie | Shrnutí | Fáze |",
        "| --- | --- | ---: |",
        ...Array.from(trajectoryPageById.values()).map((page) =>
          `| ${markdownLink(page.item.title, relativeLink(trajectoryIndexPath, page.targetPath))} | ${escapeTableCell(page.item.summary)} | ${page.item.stages.length} |`
        ),
        ""
      ].join("\n")
    });
    for (const page of trajectoryPageById.values()) {
      files.push({
        title: page.item.title,
        kind: "trajectory",
        targetPath: page.targetPath,
        relativePath: page.relativePath,
        summary: page.item.summary,
        contents: buildTrajectoryPage({
          paths,
          trajectory: page.item,
          targetPath: page.targetPath,
          constellationPageById,
          pageByNodeId
        })
      });
    }

    const zoomPages: Array<{
      filename: string;
      title: string;
      description: string;
      items: ThoughtMacroMapArtifact["currentPositions"];
    }> = [
      {
        filename: "current_positions.md",
        title: "Aktuální pozice",
        description: "Nejsilnější současné formulace napříč atlasem.",
        items: inputs.macroMap.currentPositions
      },
      {
        filename: "open_questions.md",
        title: "Otevřené otázky",
        description: "Otázky, které v mapě zůstávají produktivně neuzavřené.",
        items: inputs.macroMap.openQuestions
      },
      {
        filename: "open_tensions.md",
        title: "Otevřená napětí",
        description: "Rozpory a konkurenční formulace, které není vhodné předčasně slučovat.",
        items: inputs.macroMap.openTensions
      }
    ];
    for (const zoom of zoomPages) {
      const targetPath = path.join(atlasDir, zoom.filename);
      files.push({
        title: zoom.title,
        kind: "index",
        targetPath,
        relativePath: wikiRelativePath(paths, targetPath),
        summary: zoom.description,
        contents: buildMacroZoomPage({
          title: zoom.title,
          description: zoom.description,
          items: zoom.items,
          targetPath,
          paths,
          pageByNodeId,
          constellationPageById
        })
      });
    }
  }

  const masterThoughtIndexPath = path.join(paths.wikiThoughtsDir, "index.md");
  files.push({
    title: "Všechny myšlenky",
    kind: "index",
    targetPath: masterThoughtIndexPath,
    relativePath: wikiRelativePath(paths, masterThoughtIndexPath),
    summary: "Hlavní index všech konsolidovaných myšlenek.",
    contents: inputs.macroMap
      ? [
          "# Inventář myšlenek",
          "",
          "> Úplný uzlový inventář je auditní vrstva. Pro orientaci začni přes mapu myšlení a konstelace.",
          `> Navigace: ${markdownLink("Mapa myšlení", relativeLink(masterThoughtIndexPath, path.join(paths.wikiDir, "index.md")))}`,
          "",
          "## Podle typu",
          "",
          "| Typ | Počet |",
          "| --- | ---: |",
          ...(["thesis", "question", "theme", "tension", "thread"] as ThoughtNodeType[]).map((type) => {
            const targetPath = path.join(TYPE_DESCRIPTIONS[type].directory(paths), "index.md");
            const count = inputs.consolidatedGraph.nodes.filter((node) => node.nodeType === type).length;
            return `| ${markdownLink(TYPE_DESCRIPTIONS[type].plural, relativeLink(masterThoughtIndexPath, targetPath))} | ${count} |`;
          }),
          "",
          "## Naposledy aktualizované",
          "",
          ...sortNodesForRecency(inputs.consolidatedGraph.nodes).slice(0, 24).map((node) => {
            const page = pageByNodeId.get(node.id);
            return page
              ? `- ${formatDate(node.lastSeen)} · ${markdownLink(node.title, relativeLink(masterThoughtIndexPath, page.targetPath))}`
              : "";
          }).filter((line) => line.length > 0),
          ""
        ].join("\n")
      : [
          "# Všechny myšlenky",
          "",
          "> Hlavní index přes všechny konsolidované myšlenky.",
          `> Navigace: ${markdownLink("Wiki", relativeLink(masterThoughtIndexPath, path.join(paths.wikiDir, "index.md")))}`,
          "",
          ...(
            (["thesis", "question", "theme", "tension", "thread"] as ThoughtNodeType[]).flatMap((type) =>
              buildThoughtIndexSection(
                type,
                inputs.consolidatedGraph.nodes
                  .filter((node) => node.nodeType === type)
                  .sort((left, right) => left.title.localeCompare(right.title)),
                pageByNodeId,
                thoughtPageSummaryByNodeId,
                masterThoughtIndexPath
              ).split("\n")
            )
          )
        ].join("\n")
  });

  for (const type of ["thesis", "question", "theme", "tension", "thread"] as ThoughtNodeType[]) {
    const directory = TYPE_DESCRIPTIONS[type].directory(paths);
    const targetPath = path.join(directory, "index.md");
    const nodes = inputs.consolidatedGraph.nodes
      .filter((node) => node.nodeType === type)
      .sort((left, right) => left.title.localeCompare(right.title));

    const inventoryChunks = inputs.macroMap
      ? Array.from({ length: Math.ceil(nodes.length / INVENTORY_PAGE_SIZE) }, (_, index) =>
          nodes.slice(index * INVENTORY_PAGE_SIZE, (index + 1) * INVENTORY_PAGE_SIZE)
        )
      : [];
    const firstInventoryChunk = inventoryChunks[0] ?? [];
    files.push({
      title: TYPE_DESCRIPTIONS[type].plural,
      kind: "index",
      targetPath,
      relativePath: wikiRelativePath(paths, targetPath),
      summary: TYPE_DESCRIPTIONS[type].description,
      contents: [
        `# ${TYPE_DESCRIPTIONS[type].plural}`,
        "",
        TYPE_DESCRIPTIONS[type].description,
        "",
        `> Navigace: ${markdownLink("Wiki", relativeLink(targetPath, path.join(paths.wikiDir, "index.md")))} · ${markdownLink("Všechny myšlenky", relativeLink(targetPath, masterThoughtIndexPath))}`,
        "",
        ...(type === "theme" && nodes.length === 0 && inputs.frameAlignment
          ? [
              "> Tento běh nevytvořil žádné samostatné uzly typu `Téma`.",
              `> Tematická vertikála je v tomto běhu reprezentovaná hlavně přes ${markdownLink("Vertikální mapu", relativeLink(targetPath, verticalIndexPath))}, sdílené rodiny a vyšší vzory.`,
              ""
            ]
          : []),
        ...(inputs.macroMap
          ? [
              `Celkem ${nodes.length} myšlenek · strana 1 z ${inventoryChunks.length} · položky 1–${firstInventoryChunk.length}.`,
              "",
              "| Myšlenka | Shrnutí | Aktualizováno |",
              "| --- | --- | --- |",
              ...firstInventoryChunk.map((node) => {
                const page = pageByNodeId.get(node.id);
                return page
                  ? `| ${markdownLink(node.title, relativeLink(targetPath, page.targetPath))} | ${escapeTableCell(thoughtPageSummaryByNodeId.get(node.id) ?? node.summary)} | ${formatDate(node.lastSeen)} |`
                  : "";
              }).filter((line) => line.length > 0),
              "",
              ...(inventoryChunks.length > 1
                ? [
                    `**${markdownLink(`Další: strana 2 · položky ${INVENTORY_PAGE_SIZE + 1}–${Math.min(INVENTORY_PAGE_SIZE * 2, nodes.length)} →`, relativeLink(targetPath, path.join(directory, "page-002.md")))}**`
                  ]
                : [])
            ]
          : [
              "| Myšlenka | Shrnutí | Aktualizováno |",
              "| --- | --- | --- |",
              ...nodes.map((node) => {
                const page = pageByNodeId.get(node.id);
                if (!page) {
                  return "";
                }
                return `| ${markdownLink(node.title, relativeLink(targetPath, page.targetPath))} | ${escapeTableCell(thoughtPageSummaryByNodeId.get(node.id) ?? node.summary)} | ${formatDate(node.lastSeen)} |`;
              }).filter((line) => line.length > 0)
            ]),
        ""
      ].join("\n")
    });

    for (const [index, chunk] of inventoryChunks.entries()) {
      if (index === 0) {
        continue;
      }
      const pageTarget = path.join(directory, `page-${String(index + 1).padStart(3, "0")}.md`);
      const previousTarget = index === 1
        ? targetPath
        : path.join(directory, `page-${String(index).padStart(3, "0")}.md`);
      const nextTarget = index + 1 < inventoryChunks.length
        ? path.join(directory, `page-${String(index + 2).padStart(3, "0")}.md`)
        : null;
      const firstItemNumber = index * INVENTORY_PAGE_SIZE + 1;
      const lastItemNumber = firstItemNumber + chunk.length - 1;
      const paginationLinks = [
        markdownLink(
          `← Předchozí: strana ${index}`,
          relativeLink(pageTarget, previousTarget)
        ),
        ...(nextTarget
          ? [
              markdownLink(
                `Další: strana ${index + 2} →`,
                relativeLink(pageTarget, nextTarget)
              )
            ]
          : [])
      ].join(" · ");
      files.push({
        title: `${TYPE_DESCRIPTIONS[type].plural} · strana ${index + 1}`,
        kind: "index",
        targetPath: pageTarget,
        relativePath: wikiRelativePath(paths, pageTarget),
        summary: `Auditní inventář ${TYPE_DESCRIPTIONS[type].plural.toLowerCase()}, strana ${index + 1} z ${inventoryChunks.length}.`,
        contents: [
          `# ${TYPE_DESCRIPTIONS[type].plural} · strana ${index + 1}`,
          "",
          `> ${markdownLink(`Zpět na začátek ${TYPE_DESCRIPTIONS[type].plural.toLowerCase()}`, relativeLink(pageTarget, targetPath))}`,
          "",
          `Celkem ${nodes.length} myšlenek · strana ${index + 1} z ${inventoryChunks.length} · položky ${firstItemNumber}–${lastItemNumber}.`,
          "",
          `**${paginationLinks}**`,
          "",
          "| Myšlenka | Shrnutí | Aktualizováno |",
          "| --- | --- | --- |",
          ...chunk.map((node) => {
            const page = pageByNodeId.get(node.id);
            return page
              ? `| ${markdownLink(node.title, relativeLink(pageTarget, page.targetPath))} | ${escapeTableCell(thoughtPageSummaryByNodeId.get(node.id) ?? node.summary)} | ${formatDate(node.lastSeen)} |`
              : "";
          }).filter((line) => line.length > 0),
          "",
          `**${paginationLinks}**`,
          ""
        ].join("\n")
      });
    }
  }

  const chronologyIndexPath = path.join(paths.wikiChronologyDir, "index.md");
  const chronologyNodes = [...inputs.consolidatedGraph.nodes].sort((left, right) => {
    const comparison = compareDates(right.firstSeen, left.firstSeen);
    return comparison !== 0 ? comparison : left.title.localeCompare(right.title);
  });
  const chronologyChunks = inputs.macroMap
    ? Array.from({ length: Math.ceil(chronologyNodes.length / INVENTORY_PAGE_SIZE) }, (_, index) =>
        chronologyNodes.slice(index * INVENTORY_PAGE_SIZE, (index + 1) * INVENTORY_PAGE_SIZE)
      )
    : [];
  const firstChronologyChunk = chronologyChunks[0] ?? [];
  files.push({
    title: "Chronologie myšlenek",
    kind: "index",
    targetPath: chronologyIndexPath,
    relativePath: wikiRelativePath(paths, chronologyIndexPath),
    summary: "Chronologický index podle prvního výskytu konsolidovaných myšlenek.",
    contents: inputs.macroMap
      ? buildChronologyPage({
          paths,
          nodes: firstChronologyChunk,
          pageByNodeId,
          targetPath: chronologyIndexPath,
          summaryLines: [
            `Celkem ${chronologyNodes.length} myšlenek · strana 1 z ${chronologyChunks.length} · položky 1–${firstChronologyChunk.length}.`
          ],
          pagination: chronologyChunks.length > 1
            ? markdownLink(
                `Další: strana 2 · položky ${INVENTORY_PAGE_SIZE + 1}–${Math.min(INVENTORY_PAGE_SIZE * 2, chronologyNodes.length)} →`,
                relativeLink(chronologyIndexPath, path.join(paths.wikiChronologyDir, "page-002.md"))
              )
            : undefined
        })
      : buildChronologyPage({
          paths,
          nodes: inputs.consolidatedGraph.nodes,
          pageByNodeId,
          targetPath: chronologyIndexPath
        })
  });
  for (const [index, chunk] of chronologyChunks.entries()) {
    if (index === 0) {
      continue;
    }
    const pageTarget = path.join(paths.wikiChronologyDir, `page-${String(index + 1).padStart(3, "0")}.md`);
    const previousTarget = index === 1
      ? chronologyIndexPath
      : path.join(paths.wikiChronologyDir, `page-${String(index).padStart(3, "0")}.md`);
    const nextTarget = index + 1 < chronologyChunks.length
      ? path.join(paths.wikiChronologyDir, `page-${String(index + 2).padStart(3, "0")}.md`)
      : null;
    const firstItemNumber = index * INVENTORY_PAGE_SIZE + 1;
    const lastItemNumber = firstItemNumber + chunk.length - 1;
    const pagination = [
      markdownLink(`← Předchozí: strana ${index}`, relativeLink(pageTarget, previousTarget)),
      ...(nextTarget
        ? [markdownLink(`Další: strana ${index + 2} →`, relativeLink(pageTarget, nextTarget))]
        : [])
    ].join(" · ");
    files.push({
      title: `Chronologie · strana ${index + 1}`,
      kind: "index",
      targetPath: pageTarget,
      relativePath: wikiRelativePath(paths, pageTarget),
      summary: `Chronologický inventář, strana ${index + 1} z ${chronologyChunks.length}.`,
      contents: buildChronologyPage({
        paths,
        nodes: chunk,
        pageByNodeId,
        targetPath: pageTarget,
        summaryLines: [
          `Celkem ${chronologyNodes.length} myšlenek · strana ${index + 1} z ${chronologyChunks.length} · položky ${firstItemNumber}–${lastItemNumber}.`
        ],
        pagination
      })
    });
  }

  const referencesIndexPath = path.join(paths.wikiReferencesDir, "index.md");
  files.push({
    title: "Zdrojové reference",
    kind: "index",
    targetPath: referencesIndexPath,
    relativePath: wikiRelativePath(paths, referencesIndexPath),
    summary: "Dokumentový index zdrojové dohledatelnosti.",
    contents: buildReferencesIndexPage({
      paths,
      referencedDocuments: Array.from(referenceByDocumentId.values()).map((page) => page.document),
      referenceByDocumentId,
      nodesByDocumentId,
      targetPath: referencesIndexPath
    })
  });

  const diagnosticsIndexPath = path.join(paths.wikiIndexesDir, "graph.md");
  files.push({
    title: "Diagnostika grafu",
    kind: "index",
    targetPath: diagnosticsIndexPath,
    relativePath: wikiRelativePath(paths, diagnosticsIndexPath),
    summary: "Strukturální diagnostika topologie konsolidovaného grafu.",
    contents: buildGraphDiagnosticsPage({
      paths,
      compilation: inputs.compilation,
      consolidatedGraph: inputs.consolidatedGraph,
      pageByNodeId,
      targetPath: diagnosticsIndexPath
    })
  });

  for (const page of localFramePageById.values()) {
    const frame = frameById.get(page.id);
    if (!frame) {
      continue;
    }
    files.push({
      title: frame.label,
      kind: "index",
      targetPath: page.targetPath,
      relativePath: page.relativePath,
      summary: `Lokální hlavní rámec ve zdroji ${frame.documentId}.`,
      contents: buildLocalFramePage({
        paths,
        frame,
        targetPath: page.targetPath,
        verticalIndexPath,
        documentById,
        subframeById,
        localSubframePageById,
        pageByNodeId,
        nodes: inputs.consolidatedGraph.nodes
      })
    });
  }

  for (const page of localSubframePageById.values()) {
    const subframe = subframeById.get(page.id);
    if (!subframe) {
      continue;
    }
    files.push({
      title: subframe.label,
      kind: "index",
      targetPath: page.targetPath,
      relativePath: page.relativePath,
      summary: `Lokální podrámec ve zdroji ${subframe.documentId}.`,
      contents: buildLocalSubframePage({
        paths,
        subframe,
        targetPath: page.targetPath,
        verticalIndexPath,
        documentById,
        frameById,
        localFramePageById,
        pageByNodeId,
        nodes: inputs.consolidatedGraph.nodes
      })
    });
  }

  if (inputs.frameAlignment) {
    for (const { family, targetPath } of verticalFamilyPageById.values()) {
      files.push({
        title: family.label,
        kind: "index",
        targetPath,
        relativePath: wikiRelativePath(paths, targetPath),
        summary: `Sdílená rodina napříč ${family.memberDocumentIds.length} texty.`,
        contents: buildVerticalFamilyPage({
          paths,
          family,
          targetPath,
          pageByNodeId,
          verticalIndexPath,
          frameById,
          subframeById,
          documentById,
          localFramePageById,
          localSubframePageById
        })
      });
    }

    for (const { pattern, targetPath } of verticalPatternPageById.values()) {
      files.push({
        title: pattern.label,
        kind: "index",
        targetPath,
        relativePath: wikiRelativePath(paths, targetPath),
        summary: `Vyšší vzor nad ${pattern.familyIds.length} sdílenými rodinami.`,
        contents: buildVerticalPatternPage({
          paths,
          pattern,
          targetPath,
          verticalIndexPath,
          familyPageById: verticalFamilyPageById
        })
      });
    }

  }

  files.push({
    title: "Vertikální mapa",
    kind: "index",
    targetPath: verticalIndexPath,
    relativePath: wikiRelativePath(paths, verticalIndexPath),
    summary: "Index vertikální vrstvy: lokální rámce, sdílené rodiny a vyšší vzory.",
    contents: buildVerticalIndexPage({
      paths,
      targetPath: verticalIndexPath,
      frameAlignment: inputs.frameAlignment,
      localFrameCount: frameById.size,
      localSubframeCount: subframeById.size,
      outlinePageByDocumentId,
      familyPageById: verticalFamilyPageById,
      patternPageById: verticalPatternPageById
    })
  });

  const rootIndexPath = path.join(paths.wikiDir, "index.md");
  files.push({
    title: inputs.macroMap ? inputs.macroMap.atlas.title : "Validační wiki",
    kind: "index",
    targetPath: rootIndexPath,
    relativePath: wikiRelativePath(paths, rootIndexPath),
    summary: inputs.macroMap
      ? inputs.macroMap.atlas.summary
      : "Hlavní vstup do vygenerované validační wiki.",
    contents: inputs.macroMap
      ? buildMacroHomePage({
          paths,
          macroMap: inputs.macroMap,
          consolidatedGraph: inputs.consolidatedGraph,
          targetPath: rootIndexPath,
          constellationPageById,
          trajectoryPageById,
          pageByNodeId,
          pageCount: files.length + 1
        })
      : buildGlobalIndexPage({
          paths,
          corpus: inputs.corpus,
          compilation: inputs.compilation,
          consolidatedGraph: inputs.consolidatedGraph,
          pageCount: files.length + 1,
          pageByNodeId,
          indexPath: rootIndexPath,
          hasFrameAlignment: inputs.frameAlignment !== null
        })
  });

  const manifest: ValidationWikiManifest = {
    generatedAt,
    sourceRunId: inputs.consolidatedGraph.sourceRunId,
    sourceCorpusPath: inputs.sourceCorpusPath,
    sourceGraphPath: inputs.consolidatedGraph.sourceGraphPath,
    pageCount: files.length,
    thoughtPageCount: files.filter((file) => file.kind === "thought").length,
    referencePageCount: files.filter((file) => file.kind === "reference").length,
    indexPageCount: files.filter((file) => file.kind === "index").length,
    pages: files
      .map((file) => ({
        title: file.title,
        path: file.relativePath,
        kind: file.kind,
        summary: file.summary,
        nodeType: file.nodeType,
        nodeId: file.nodeId,
        documentId: file.documentId
      }))
      .sort((left, right) => left.path.localeCompare(right.path))
  };

  const searchIndex: ValidationWikiSearchEntry[] = files
    .map((file) => {
      const node = file.nodeId ? pageByNodeId.get(file.nodeId)?.node : undefined;
      const document = file.documentId ? documentById.get(file.documentId) : undefined;
      return {
        id: file.relativePath,
        title: file.title,
        path: file.relativePath,
        kind: file.kind,
        summary: file.summary,
        nodeType: file.nodeType,
        nodeStatus: node?.status,
        documentId: file.documentId,
        aliases: node?.aliases,
        keywords: buildSearchKeywords([
          file.title,
          file.summary,
          node?.canonicalKey,
          node?.aliases.join(" "),
          document?.title,
          document?.slug
        ])
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    files,
    manifest,
    searchIndex
  };
}

/**
 * Render a markdown-first validation wiki from the current consolidated graph.
 *
 * This intentionally follows the donor-repo pattern of topic indexes plus
 * interlinked pages, but keeps the local graph/compiler metadata visible so
 * the generated wiki can be used as a debugging surface instead of a polished app.
 */
export function renderValidationWiki(
  paths: ProjectPaths,
  options?: {
    sourceOutputDir?: string;
    targetOutputDir?: string;
    macroMapPath?: string;
    progress?: ProgressWriter;
  }
): ValidationWikiRenderSummary {
  const progress = new ThrottledProgressReporter(options?.progress);
  const sourcePaths = options?.sourceOutputDir
    ? withOutputDir(paths, options.sourceOutputDir)
    : paths;
  const targetPaths = options?.targetOutputDir
    ? withOutputDir(paths, options.targetOutputDir)
    : paths;
  const defaultMacroMapPath = path.join(targetPaths.compiledDir, "thought_macro_map.json");
  const macroMapPath = options?.macroMapPath
    ? path.resolve(paths.root, options.macroMapPath)
    : existsSync(defaultMacroMapPath)
      ? defaultMacroMapPath
      : undefined;
  progress.phase("wiki", "loading consolidated graph and source corpus");
  const inputs = loadValidationWikiInputs(sourcePaths, macroMapPath);
  progress.phase(
    "wiki",
    `loaded ${inputs.consolidatedGraph.nodeCount} consolidated nodes / ${inputs.corpus.stats.documentCount} documents`
  );
  progress.phase("wiki", "building markdown validation pages");
  const artifacts = buildValidationWikiArtifacts(inputs, targetPaths);
  progress.phase("wiki", `writing ${artifacts.files.length} wiki files`);

  rmSync(targetPaths.wikiDir, { recursive: true, force: true });

  for (const file of artifacts.files) {
    mkdirSync(path.dirname(file.targetPath), { recursive: true });
    writeFileSync(file.targetPath, `${file.contents}\n`, "utf8");
  }

  const manifestPath = path.join(targetPaths.wikiIndexesDir, "wiki_manifest.json");
  const searchIndexPath = path.join(targetPaths.wikiIndexesDir, "search_index.json");
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(artifacts.manifest, null, 2)}\n`, "utf8");
  writeFileSync(searchIndexPath, `${JSON.stringify(artifacts.searchIndex, null, 2)}\n`, "utf8");

  const indexPath = path.join(targetPaths.wikiDir, "index.md");
  progress.phase("wiki", "done");
  return {
    generatedAt: artifacts.manifest.generatedAt,
    sourceRunId: artifacts.manifest.sourceRunId,
    sourceCorpusPath: artifacts.manifest.sourceCorpusPath,
    consolidatedNodeCount: inputs.consolidatedGraph.nodeCount,
    consolidatedEdgeCount: inputs.consolidatedGraph.edgeCount,
    thoughtPageCount: artifacts.manifest.thoughtPageCount,
    referencePageCount: artifacts.manifest.referencePageCount,
    indexPageCount: artifacts.manifest.indexPageCount,
    pageCount: artifacts.manifest.pageCount,
    indexPath,
    manifestPath,
    searchIndexPath
  };
}
