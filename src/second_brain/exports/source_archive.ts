import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import type {
  ConsolidatedThoughtEdge,
  ConsolidatedThoughtGraph,
  ConsolidatedThoughtNode,
  ThoughtRelationType
} from "../compiler/types.js";
import type {
  MacroNodeAssessment,
  ThoughtMacroConstellation,
  ThoughtMacroMapArtifact
} from "../structure/macro_map.js";
import { type ProjectPaths, withOutputDir } from "../system/paths.js";
import type {
  SourceKind,
  UnifiedCorpus,
  UnifiedDocument,
  UnifiedSegment,
  UnifiedSourceRef
} from "../types/domain.js";

export type SourceArchiveBudget = {
  requiredMarkdownFiles: 2;
  targetMaxBytesPerFile: number;
  hardMaxBytesPerFile: number;
  targetMaxEstimatedTokensPerFile: number;
  hardMaxEstimatedTokensPerFile: number;
};

export type SourceArchiveFileInfo = {
  filename: string;
  role: "semantic-map" | "source-texts";
  bytes: number;
  characters: number;
  estimatedTokens: number;
  tokenHeadroomShare: number;
  sha256: string;
};

export type SourceArchiveSummary = {
  outputDir: string;
  corpusPath: string;
  graphPath: string;
  macroMapPath: string;
  markdownFileCount: 2;
  documentCount: number;
  sourceSegmentCount: number;
  archivedTextItemCount: number;
  semanticNodeCount: number;
  semanticEdgeCount: number;
  constellationCount: number;
  trajectoryCount: number;
  graphAnchoredSourceSegmentCount: number;
  semanticToSourceReferenceCount: number;
  sourceToSemanticReferenceCount: number;
  sourceTextCharacters: number;
  sourceTextBytes: number;
  sourceTextSha256: string;
  instructionsPath: string;
  instructionsCharacters: number;
  instructionsSha256: string;
  files: SourceArchiveFileInfo[];
  uploadBudget: SourceArchiveBudget;
};

export type RenderSourceArchiveOptions = {
  sourceOutputDir?: string;
  targetOutputDir?: string;
  budget?: Partial<Omit<SourceArchiveBudget, "requiredMarkdownFiles">>;
};

type IndexedSegment = {
  segment: UnifiedSegment;
  sourceId: string;
  nodeIds: string[];
};

type DocumentSourceIndex = {
  document: UnifiedDocument;
  segments: IndexedSegment[];
  constellationIds: string[];
};

type MacroContext = {
  constellation: ThoughtMacroConstellation;
  role: ThoughtMacroConstellation["members"][number]["role"];
  currentPosition: boolean;
  openQuestion: boolean;
  tension: boolean;
};

const DEFAULT_BUDGET: SourceArchiveBudget = {
  requiredMarkdownFiles: 2,
  targetMaxBytesPerFile: 10_350_000,
  hardMaxBytesPerFile: 11_500_000,
  targetMaxEstimatedTokensPerFile: 1_710_000,
  hardMaxEstimatedTokensPerFile: 1_900_000
};

const ARCHIVE_SCHEMA_VERSION = "linked-source-archive-v3";
const SEMANTIC_FILENAME = "A_SEMANTIC_MAP.md";
const SOURCE_FILENAME = "B_SOURCE_TEXTS.md";
const INSTRUCTIONS_FILENAME = "C_CUSTOM_GPT_INSTRUCTIONS.txt";
const GENERATED_FILE_PATTERN = /^(?:(?:SOURCE_ARCHIVE(?:_PART_\d+)?|01_SEMANTIC_MAP|02_SOURCE_TEXTS|A_SEMANTIC_MAP|B_SOURCE_TEXTS)\.md|C_CUSTOM_GPT_INSTRUCTIONS\.txt)$/;
const DATA_INSTRUCTIONS_TEXT = [
  "PUBLIC DEMO PLACEHOLDER",
  "The original Custom GPT system prompt is intentionally omitted from this public demo.",
  "This is a non-functional placeholder. Configure and review your own instructions before use. No account, user, or Gizmo identifier is included."
].join("\n\n");
const MACRO_ROLE_PRIORITY: Record<MacroContext["role"], number> = {
  core: 0,
  supporting: 1,
  context: 2
};
const RELATION_PRIORITY: Record<ThoughtRelationType, number> = {
  supports: 7,
  revises: 6,
  tensions_with: 5,
  supersedes: 4,
  semantic_related: 3,
  context_split: 2,
  co_occurs: 1
};
const RELATION_LABELS: Record<ThoughtRelationType, { outgoing: string; incoming: string }> = {
  supports: { outgoing: "podporuje", incoming: "podporováno" },
  revises: { outgoing: "reviduje", incoming: "revidováno" },
  tensions_with: { outgoing: "tenze", incoming: "tenze" },
  supersedes: { outgoing: "nahrazuje", incoming: "nahrazeno" },
  semantic_related: { outgoing: "souvisí", incoming: "souvisí" },
  context_split: { outgoing: "jiný-kontext", incoming: "jiný-kontext" },
  co_occurs: { outgoing: "spolu", incoming: "spolu" }
};

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

// This is intentionally identical to the conservative estimator used by the
// full GPT exporter; the platform tokenizer itself remains opaque.
function estimateTokens(value: string): number {
  return Math.ceil(value.length / 3);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compactHeading(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim() || "Bez názvu";
}

function formatDate(value: string | null): string {
  return value ? value.slice(0, 10) : "?";
}

function sourceKindLabel(sourceKind: SourceKind): string {
  if (sourceKind === "writing") return "AUTORSKÝ TEXT";
  if (sourceKind === "conversation") return "KONVERZACE";
  return "CHAT";
}

function compactNodeId(nodeId: string): string {
  const stablePart = nodeId.split(":")[1];
  return `N${stablePart && stablePart.length >= 10 ? stablePart.slice(0, 12) : sha256(nodeId).slice(0, 12)}`;
}

function compactConstellationId(constellationId: string): string {
  const stablePart = constellationId.split(":")[1];
  return `C${stablePart && stablePart.length >= 8 ? stablePart.slice(0, 10) : sha256(constellationId).slice(0, 10)}`;
}

function compactTrajectoryId(trajectoryId: string): string {
  const stablePart = trajectoryId.split(":")[1];
  return `T${stablePart && stablePart.length >= 8 ? stablePart.slice(0, 10) : sha256(trajectoryId).slice(0, 10)}`;
}

function compactDocumentId(documentId: string): string {
  return `D${sha256(documentId).slice(0, 10)}`;
}

function compactSourceId(segmentId: string): string {
  return `S${sha256(segmentId).slice(0, 11)}`;
}

function assertUniqueCompactIds(values: Array<[string, string]>, label: string): void {
  const originalsByCompact = new Map<string, string>();
  for (const [compact, original] of values) {
    const prior = originalsByCompact.get(compact);
    if (prior && prior !== original) {
      throw new Error(`${label} compact ID collision: ${compact} maps to both ${prior} and ${original}.`);
    }
    originalsByCompact.set(compact, original);
  }
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

function isPrimarySelfSegment(segment: UnifiedSegment): boolean {
  return segment.signalKind === "primary" && segment.authorKind === "self";
}

function buildMacroContexts(macroMap: ThoughtMacroMapArtifact): Map<string, MacroContext[]> {
  const contexts = new Map<string, MacroContext[]>();
  for (const constellation of macroMap.constellations) {
    for (const member of constellation.members) {
      const bucket = contexts.get(member.nodeId) ?? [];
      bucket.push({ constellation, ...member });
      contexts.set(member.nodeId, bucket);
    }
  }
  return contexts;
}

function buildNeighborMap(
  graph: ConsolidatedThoughtGraph
): Map<string, Array<{ edge: ConsolidatedThoughtEdge; targetId: string; outgoing: boolean }>> {
  const result = new Map<string, Array<{ edge: ConsolidatedThoughtEdge; targetId: string; outgoing: boolean }>>();
  for (const edge of graph.edges) {
    const from = result.get(edge.from) ?? [];
    from.push({ edge, targetId: edge.to, outgoing: true });
    result.set(edge.from, from);
    const to = result.get(edge.to) ?? [];
    to.push({ edge, targetId: edge.from, outgoing: false });
    result.set(edge.to, to);
  }
  for (const [nodeId, entries] of result) {
    entries.sort((left, right) =>
      RELATION_PRIORITY[right.edge.type] - RELATION_PRIORITY[left.edge.type] ||
      right.edge.weight - left.edge.weight ||
      left.targetId.localeCompare(right.targetId)
    );
    const strongestByTarget = new Map<string, typeof entries[number]>();
    for (const entry of entries) {
      if (!strongestByTarget.has(entry.targetId)) strongestByTarget.set(entry.targetId, entry);
    }
    result.set(nodeId, [...strongestByTarget.values()]);
  }
  return result;
}

function buildSourceIndex(
  corpus: UnifiedCorpus,
  graph: ConsolidatedThoughtGraph,
  macroContexts: Map<string, MacroContext[]>
): {
  documents: DocumentSourceIndex[];
  sourceIdByKey: Map<string, string>;
  nodeIdsBySourceKey: Map<string, string[]>;
  anchoredSegmentCount: number;
} {
  const nodeIdsBySourceKey = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    for (const sourceRef of node.sourceRefs) {
      const key = sourceRefKey(sourceRef);
      const bucket = nodeIdsBySourceKey.get(key) ?? new Set<string>();
      bucket.add(node.id);
      nodeIdsBySourceKey.set(key, bucket);
    }
  }

  const sourceIdByKey = new Map<string, string>();
  const segmentsByDocument = new Map<string, IndexedSegment[]>();
  for (const segment of corpus.segments.filter(isPrimarySelfSegment)) {
    const key = sourceRefKey(segment.sourceRef);
    const sourceId = compactSourceId(segment.id);
    sourceIdByKey.set(key, sourceId);
    const nodeIds = [...(nodeIdsBySourceKey.get(key) ?? [])].sort();
    const bucket = segmentsByDocument.get(segment.documentId) ?? [];
    bucket.push({ segment, sourceId, nodeIds });
    segmentsByDocument.set(segment.documentId, bucket);
  }

  const documents = corpus.documents.flatMap((document): DocumentSourceIndex[] => {
    const segments = [...(segmentsByDocument.get(document.id) ?? [])].sort(
      (left, right) => left.segment.sequenceIndex - right.segment.sequenceIndex ||
        left.segment.id.localeCompare(right.segment.id)
    );
    if (segments.length === 0) return [];
    const constellationCounts = new Map<string, number>();
    for (const nodeId of new Set(segments.flatMap((item) => item.nodeIds))) {
      for (const context of macroContexts.get(nodeId) ?? []) {
        constellationCounts.set(
          context.constellation.id,
          (constellationCounts.get(context.constellation.id) ?? 0) + 1
        );
      }
    }
    const constellationIds = [...constellationCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 5)
      .map(([constellationId]) => constellationId);
    return [{ document, segments, constellationIds }];
  });

  return {
    documents,
    sourceIdByKey,
    nodeIdsBySourceKey: new Map(
      [...nodeIdsBySourceKey.entries()].map(([key, nodeIds]) => [key, [...nodeIds].sort()])
    ),
    anchoredSegmentCount: [...sourceIdByKey.keys()].filter((key) => nodeIdsBySourceKey.has(key)).length
  };
}

function renderAtlas(
  macroMap: ThoughtMacroMapArtifact,
  nodesById: Map<string, ConsolidatedThoughtNode>
): string {
  const constellationById = new Map(macroMap.constellations.map((item) => [item.id, item]));
  const lines = [
    "# KOMPAKTNÍ SÉMANTICKÁ MAPA",
    "",
    `Tento soubor je navigační a interpretační vrstva nad úplnými vlastními texty v \`${SOURCE_FILENAME}\`. Začni atlasem nebo konstelací, pokračuj do bloku MYŠLENKA a pro přesné původní znění sleduj ID \`S…\`. Nevydávej automaticky každou pracovní hypotézu, otázku nebo tenzi za definitivní postoj.`,
    "",
    `## ATLAS | ${macroMap.atlas.title}`,
    "",
    macroMap.atlas.summary,
    ""
  ];

  for (const constellationId of macroMap.atlas.constellationIds) {
    const constellation = constellationById.get(constellationId);
    if (!constellation) continue;
    const keyNodeIds = [...new Set([
      ...constellation.evidenceHighlights.map((item) => item.nodeId),
      ...constellation.members.filter((member) => member.currentPosition).map((member) => member.nodeId),
      ...constellation.members.filter((member) => member.openQuestion).map((member) => member.nodeId)
    ])].slice(0, 8);
    lines.push(
      `### ${compactConstellationId(constellation.id)} | ${constellation.title}`,
      constellation.summary,
      `Drží pohromadě: ${constellation.rationale}`,
      `Směr: ${constellation.trajectoryHint}`,
      `Klíčové myšlenky: ${keyNodeIds.map((nodeId) => `${compactNodeId(nodeId)} ${nodesById.get(nodeId)?.title ?? ""}`.trim()).join(" | ")}`,
      ""
    );
  }

  lines.push("## TRAJEKTORIE", "");
  for (const trajectory of macroMap.trajectories) {
    lines.push(
      `### ${compactTrajectoryId(trajectory.id)} | ${trajectory.title}`,
      trajectory.summary,
      ...trajectory.stages.map((stage, index) =>
        `Etapa ${index + 1} (${formatDate(stage.startDate)}–${formatDate(stage.endDate)}): ${stage.label} — ${stage.summary} [${stage.nodeIds.map(compactNodeId).join(", ")}]`
      ),
      `Současná pozice: ${trajectory.currentPositionNodeIds.map(compactNodeId).join(", ") || "—"}`,
      `Otevřené tenze: ${trajectory.openTensionNodeIds.map(compactNodeId).join(", ") || "—"}`,
      ""
    );
  }
  return lines.join("\n");
}

function macroContextLabel(context: MacroContext): string {
  const role = context.role === "core" ? "jádro" : context.role === "supporting" ? "podpora" : "kontext";
  const flags = `${context.currentPosition ? "*" : ""}${context.openQuestion ? "?" : ""}${context.tension ? "!" : ""}`;
  return `${compactConstellationId(context.constellation.id)}/${role}${flags}`;
}

function renderNode(
  node: ConsolidatedThoughtNode,
  contexts: MacroContext[],
  assessment: MacroNodeAssessment | undefined,
  neighbors: Array<{ edge: ConsolidatedThoughtEdge; targetId: string; outgoing: boolean }>,
  sourceIdByKey: Map<string, string>
): string {
  const sourceIds = [...new Set(node.sourceRefs.map((sourceRef) => sourceIdByKey.get(sourceRefKey(sourceRef))).filter(
    (sourceId): sourceId is string => sourceId !== undefined
  ))];
  const relationLabels = neighbors.slice(0, 3).map(({ edge, targetId, outgoing }) =>
    `${outgoing ? RELATION_LABELS[edge.type].outgoing : RELATION_LABELS[edge.type].incoming}>${compactNodeId(targetId)}`
  );
  const meta = [
    `${node.nodeType}/${node.status}`,
    assessment?.sourceAuthority ?? null,
    assessment ? `${assessment.salienceScore}/100` : null,
    `${formatDate(node.firstSeen)}–${formatDate(node.lastSeen)}`
  ].filter((item): item is string => item !== null).join(" | ");
  const searchFormulations = assessment && assessment.salienceScore >= 35
    ? [...new Set(node.aliases)]
      .filter((alias) => alias.replace(/\s+/g, " ").trim().toLowerCase() !== node.title.toLowerCase())
      .slice(0, 12)
    : [];
  return [
    `### ${compactNodeId(node.id)} | ${compactHeading(node.title)}`,
    node.summary,
    searchFormulations.length > 0 ? `Další formulace: ${searchFormulations.join(" | ")}` : null,
    `Meta: ${meta}`,
    contexts.length > 0 ? `Oblasti: ${contexts.map(macroContextLabel).join(", ")}` : "Oblasti: mimo hlavní atlas",
    relationLabels.length > 0 ? `Vazby: ${relationLabels.join("; ")}` : null,
    sourceIds.length > 0 ? `Zdroje: ${sourceIds.join(", ")}` : "Zdroje: bez přímé kotvy v archivovaných primárních segmentech",
    ""
  ].filter((line): line is string => line !== null).join("\n");
}

function renderSemanticMap(
  graph: ConsolidatedThoughtGraph,
  macroMap: ThoughtMacroMapArtifact,
  sourceIdByKey: Map<string, string>
): string {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const assessmentsByNodeId = new Map(macroMap.nodeAssessments.map((item) => [item.nodeId, item]));
  const contextsByNodeId = buildMacroContexts(macroMap);
  const neighborsByNodeId = buildNeighborMap(graph);
  const atlasOrder = new Map(macroMap.atlas.constellationIds.map((id, index) => [id, index]));
  const constellationById = new Map(macroMap.constellations.map((item) => [item.id, item]));
  const assignedConstellationByNodeId = new Map<string, string | null>();

  for (const node of graph.nodes) {
    const contexts = [...(contextsByNodeId.get(node.id) ?? [])].sort((left, right) =>
      MACRO_ROLE_PRIORITY[left.role] - MACRO_ROLE_PRIORITY[right.role] ||
      (atlasOrder.get(left.constellation.id) ?? Number.MAX_SAFE_INTEGER) -
        (atlasOrder.get(right.constellation.id) ?? Number.MAX_SAFE_INTEGER)
    );
    assignedConstellationByNodeId.set(node.id, contexts[0]?.constellation.id ?? null);
  }

  const groups = [...macroMap.atlas.constellationIds, null] as Array<string | null>;
  const sections = groups.flatMap((constellationId): string[] => {
    const nodes = graph.nodes.filter((node) => assignedConstellationByNodeId.get(node.id) === constellationId);
    if (nodes.length === 0) return [];
    nodes.sort((left, right) =>
      (assessmentsByNodeId.get(right.id)?.salienceScore ?? 0) -
        (assessmentsByNodeId.get(left.id)?.salienceScore ?? 0) ||
      left.title.localeCompare(right.title)
    );
    const constellation = constellationId ? constellationById.get(constellationId) : null;
    const heading = constellation
      ? `## MYŠLENKY V OBLASTI | ${compactConstellationId(constellation.id)} | ${constellation.title}`
      : "## MYŠLENKY MIMO HLAVNÍ ATLAS";
    return [[
      heading,
      "",
      ...nodes.map((node) => renderNode(
        node,
        contextsByNodeId.get(node.id) ?? [],
        assessmentsByNodeId.get(node.id),
        neighborsByNodeId.get(node.id) ?? [],
        sourceIdByKey
      ))
    ].join("\n")];
  });

  return [
    renderAtlas(macroMap, nodesById),
    "## LEGENDA KOMPAKTNÍHO GRAFU",
    "",
    "`N…` = konsolidovaná myšlenka, `C…` = konstelace, `S…` = přesný zdrojový segment ve druhém souboru. U oblastí znamená `*` současnou pozici, `?` otevřenou otázku a `!` tenzi. Vazby zachovávají nejsilnější tři grafové hrany; úplné shrnutí uzlu zůstává vždy přítomné.",
    "",
    ...sections
  ].join("\n\n");
}

function renderDocumentSources(
  indexed: DocumentSourceIndex,
  macroMap: ThoughtMacroMapArtifact
): string {
  const constellationTitles = new Map(macroMap.constellations.map((item) => [item.id, item.title]));
  const { document, segments } = indexed;
  const lines = [
    `## ${compactDocumentId(document.id)} | ${sourceKindLabel(document.sourceKind)} | ${compactHeading(document.title)} | ${formatDate(document.time)}`,
    indexed.constellationIds.length > 0
      ? `Oblasti: ${indexed.constellationIds.map((id) => `${compactConstellationId(id)} ${constellationTitles.get(id) ?? ""}`.trim()).join(" | ")}`
      : "Oblasti: bez přímého zařazení do hlavního atlasu",
    ""
  ];

  if (document.sourceKind === "writing") {
    const originalParagraphs = document.primaryText
      .replace(/\r\n/g, "\n")
      .split(/\n\s*\n+/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
    const segmentParagraphs = segments.map((item) => item.segment.text);
    let omittedTitle: string | null = null;
    if (
      originalParagraphs.length === segmentParagraphs.length + 1 &&
      originalParagraphs[0]?.replace(/\s+/g, " ").trim() === document.title.replace(/\s+/g, " ").trim()
    ) {
      omittedTitle = originalParagraphs[0]!;
      originalParagraphs.shift();
    }
    if (JSON.stringify(originalParagraphs) !== JSON.stringify(segmentParagraphs)) {
      throw new Error(`Writing ${document.id} cannot be losslessly aligned to its normalized paragraphs.`);
    }
    lines.push("### ÚPLNÝ PŮVODNÍ TEXT", "");
    if (omittedTitle) lines.push(omittedTitle, "");
    for (const item of segments) {
      lines.push(
        `### ${item.sourceId} | ${item.segment.sourceRef.locator}${item.nodeIds.length > 0 ? ` | ${item.nodeIds.map(compactNodeId).join(", ")}` : ""}`,
        "",
        item.segment.text,
        ""
      );
    }
    return lines.join("\n");
  }

  let previousDate: string | null = null;
  for (const item of segments) {
    const itemDate = formatDate(item.segment.time);
    if (itemDate !== previousDate) {
      lines.push(`### DATUM | ${itemDate}`, "");
      previousDate = itemDate;
    }
    lines.push(...[
      `#### ${item.sourceId}`,
      item.nodeIds.length > 0 ? `Myšlenky: ${item.nodeIds.map(compactNodeId).join(", ")}` : null,
      "",
      item.segment.text,
      ""
    ].filter((line): line is string => line !== null));
  }
  return lines.join("\n");
}

function renderSourceTexts(
  corpus: UnifiedCorpus,
  sourceIndex: ReturnType<typeof buildSourceIndex>,
  macroMap: ThoughtMacroMapArtifact
): string {
  const intro = [
    "# ÚPLNÉ PŮVODNÍ TEXTY A PROMLUVY",
    "",
    `Toto je úplná zdrojová vrstva k \`${SEMANTIC_FILENAME}\`. Vlastní autorské texty jsou zachovány celé; u konverzací a chatů jsou zachovány přesné normalizované vlastní vstupy. Odpovědi asistenta a zprávy jiných lidí zde nejsou. ID \`S…\` propojuje konkrétní vstup s bloky \`N…\` v sémantické mapě.`,
    "",
    `Pokrytí: ${sourceIndex.documents.length} dokumentů; ${corpus.segments.filter(isPrimarySelfSegment).length} primárních vlastních segmentů; ${sourceIndex.anchoredSegmentCount} segmentů má přímou grafovou kotvu.`
  ].join("\n");
  const documents = sourceIndex.documents
    .map((document) => renderDocumentSources(document, macroMap))
    .join("\n\n---\n\n");
  return `${intro}\n\n${documents}`;
}

function resolveBudget(
  overrides: Partial<Omit<SourceArchiveBudget, "requiredMarkdownFiles">> | undefined
): SourceArchiveBudget {
  const budget = { ...DEFAULT_BUDGET, ...overrides };
  if (
    budget.targetMaxBytesPerFile < 1 ||
    budget.hardMaxBytesPerFile < 1 ||
    budget.targetMaxEstimatedTokensPerFile < 1 ||
    budget.hardMaxEstimatedTokensPerFile < 1
  ) {
    throw new Error("Linked source archive limits must be positive.");
  }
  if (
    budget.targetMaxBytesPerFile > budget.hardMaxBytesPerFile ||
    budget.targetMaxEstimatedTokensPerFile > budget.hardMaxEstimatedTokensPerFile
  ) {
    throw new Error("Linked source archive target limits cannot exceed hard limits.");
  }
  return budget;
}

function cleanupGeneratedFiles(outputDir: string): void {
  try {
    for (const filename of readdirSync(outputDir)) {
      if (GENERATED_FILE_PATTERN.test(filename) || filename === "export-manifest.json") {
        unlinkSync(path.join(outputDir, filename));
      }
    }
  } catch {
    // The first export has no directory to clean.
  }
}

function fileInfo(
  filename: string,
  role: SourceArchiveFileInfo["role"],
  contents: string,
  budget: SourceArchiveBudget
): SourceArchiveFileInfo {
  const bytes = byteLength(contents);
  const estimatedTokens = estimateTokens(contents);
  if (bytes > budget.hardMaxBytesPerFile || estimatedTokens > budget.hardMaxEstimatedTokensPerFile) {
    throw new Error(
      `${filename} exceeds a hard upload limit: ${bytes} bytes / ${estimatedTokens} estimated tokens.`
    );
  }
  if (bytes > budget.targetMaxBytesPerFile || estimatedTokens > budget.targetMaxEstimatedTokensPerFile) {
    throw new Error(
      `${filename} does not preserve the required reserve: ${bytes} bytes / ${estimatedTokens} estimated tokens; target is ${budget.targetMaxBytesPerFile} bytes / ${budget.targetMaxEstimatedTokensPerFile} tokens.`
    );
  }
  return {
    filename,
    role,
    bytes,
    characters: contents.length,
    estimatedTokens,
    tokenHeadroomShare: Number((1 - estimatedTokens / budget.hardMaxEstimatedTokensPerFile).toFixed(4)),
    sha256: sha256(contents)
  };
}

/**
 * Render a two-file offline Knowledge pack from already completed second-brain
 * artifacts. This is a deterministic projection only: it never calls an LLM.
 */
export function renderSourceArchive(
  paths: ProjectPaths,
  options: RenderSourceArchiveOptions = {}
): SourceArchiveSummary {
  const sourcePaths = options.sourceOutputDir ? withOutputDir(paths, options.sourceOutputDir) : paths;
  const targetPaths = options.targetOutputDir ? withOutputDir(paths, options.targetOutputDir) : paths;
  const corpusPath = path.join(sourcePaths.normalizedUnifiedDir, "corpus.json");
  const graphPath = path.join(sourcePaths.compiledDir, "consolidated_thought_graph.json");
  const macroMapPath = path.join(sourcePaths.compiledDir, "thought_macro_map.json");
  const outputDir = path.join(targetPaths.exportsDir, "source_archive");
  const budget = resolveBudget(options.budget);
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as UnifiedCorpus;
  const graph = JSON.parse(readFileSync(graphPath, "utf8")) as ConsolidatedThoughtGraph;
  const macroMap = JSON.parse(readFileSync(macroMapPath, "utf8")) as ThoughtMacroMapArtifact;

  if (macroMap.sourceNodeCount !== graph.nodeCount) {
    throw new Error(
      `Macro map and consolidated graph are incompatible: ${macroMap.sourceNodeCount} vs ${graph.nodeCount} nodes.`
    );
  }

  assertUniqueCompactIds(graph.nodes.map((node) => [compactNodeId(node.id), node.id]), "Node");
  assertUniqueCompactIds(
    macroMap.constellations.map((item) => [compactConstellationId(item.id), item.id]),
    "Constellation"
  );
  const primarySegments = corpus.segments.filter(isPrimarySelfSegment);
  assertUniqueCompactIds(primarySegments.map((segment) => [compactSourceId(segment.id), segment.id]), "Source");

  const macroContexts = buildMacroContexts(macroMap);
  const sourceIndex = buildSourceIndex(corpus, graph, macroContexts);
  const semanticMap = `${renderSemanticMap(graph, macroMap, sourceIndex.sourceIdByKey).trimEnd()}\n`;
  const sourceTexts = `${renderSourceTexts(corpus, sourceIndex, macroMap).trimEnd()}\n`;
  const expectedNodeIds = graph.nodes.map((node) => compactNodeId(node.id)).sort();
  const renderedNodeIds = [...semanticMap.matchAll(/^### (N[0-9a-f]{10,12}) \|/gm)]
    .map((match) => match[1]!)
    .sort();
  if (JSON.stringify(expectedNodeIds) !== JSON.stringify(renderedNodeIds)) {
    throw new Error("Linked source archive completeness check failed for consolidated nodes.");
  }

  const semanticSourceReferences = [...semanticMap.matchAll(/S[0-9a-f]{11}/g)].map((match) => match[0]);
  const renderedSourceIds = [...sourceTexts.matchAll(/^#{3,4} (S[0-9a-f]{11})(?: |$)/gm)]
    .map((match) => match[1]!)
    .sort();
  const sourceNodeReferences = [...sourceTexts.matchAll(/N[0-9a-f]{10,12}/g)].map((match) => match[0]);
  const semanticInfo = fileInfo(SEMANTIC_FILENAME, "semantic-map", semanticMap, budget);
  const sourceInfo = fileInfo(SOURCE_FILENAME, "source-texts", sourceTexts, budget);
  const files = [semanticInfo, sourceInfo];
  const instructions = `${DATA_INSTRUCTIONS_TEXT}\n`;
  const instructionsPath = path.join(outputDir, INSTRUCTIONS_FILENAME);

  const archivedTextItems = sourceIndex.documents.flatMap(({ document, segments }) =>
    document.sourceKind === "writing"
      ? [[document.id, document.primaryText] as const]
      : segments.map((item) => [item.segment.id, item.segment.text] as const)
  );
  const expectedSourceIds = primarySegments.map((segment) => compactSourceId(segment.id)).sort();
  if (JSON.stringify(expectedSourceIds) !== JSON.stringify(renderedSourceIds)) {
    throw new Error("Linked source archive completeness check failed for primary source segments.");
  }
  const sourceIdSet = new Set(renderedSourceIds);
  const nodeIdSet = new Set(renderedNodeIds);
  if (semanticSourceReferences.some((sourceId) => !sourceIdSet.has(sourceId))) {
    throw new Error("Linked source archive contains a semantic-to-source reference without a target.");
  }
  if (sourceNodeReferences.some((nodeId) => !nodeIdSet.has(nodeId))) {
    throw new Error("Linked source archive contains a source-to-semantic reference without a target.");
  }

  mkdirSync(outputDir, { recursive: true });
  cleanupGeneratedFiles(outputDir);
  writeFileSync(path.join(outputDir, semanticInfo.filename), semanticMap, "utf8");
  writeFileSync(path.join(outputDir, sourceInfo.filename), sourceTexts, "utf8");
  writeFileSync(instructionsPath, instructions, "utf8");

  const sourceTextPayload = JSON.stringify(archivedTextItems);
  const summary: SourceArchiveSummary = {
    outputDir,
    corpusPath,
    graphPath,
    macroMapPath,
    markdownFileCount: 2,
    documentCount: sourceIndex.documents.length,
    sourceSegmentCount: primarySegments.length,
    archivedTextItemCount: archivedTextItems.length,
    semanticNodeCount: graph.nodeCount,
    semanticEdgeCount: graph.edgeCount,
    constellationCount: macroMap.constellations.length,
    trajectoryCount: macroMap.trajectories.length,
    graphAnchoredSourceSegmentCount: sourceIndex.anchoredSegmentCount,
    semanticToSourceReferenceCount: semanticSourceReferences.length,
    sourceToSemanticReferenceCount: sourceNodeReferences.length,
    sourceTextCharacters: archivedTextItems.reduce((sum, [, text]) => sum + text.length, 0),
    sourceTextBytes: archivedTextItems.reduce((sum, [, text]) => sum + byteLength(text), 0),
    sourceTextSha256: sha256(sourceTextPayload),
    instructionsPath,
    instructionsCharacters: DATA_INSTRUCTIONS_TEXT.length,
    instructionsSha256: sha256(instructions),
    files,
    uploadBudget: budget
  };

  writeFileSync(
    path.join(outputDir, "export-manifest.json"),
    `${JSON.stringify({
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      corpusGeneratedAt: corpus.generatedAt,
      graphGeneratedAt: graph.generatedAt,
      macroMapGeneratedAt: macroMap.generatedAt,
      architecture: {
        callsLlm: false,
        semanticFile: semanticInfo.filename,
        sourceFile: sourceInfo.filename,
        instructionsFile: INSTRUCTIONS_FILENAME,
        instructionsUsage: "paste into the Custom GPT Instructions field; do not upload as Knowledge",
        semanticToSourceLink: "N node blocks list S source IDs",
        sourceToSemanticLink: "S source blocks list N node IDs",
        fullWritingBodiesIncluded: true,
        primarySelfConversationAndChatSegmentsIncluded: true,
        assistantAndOtherContextIncluded: false
      },
      completeness: {
        allConsolidatedNodesRenderedExactlyOnce: true,
        allPrimarySourceSegmentsIndexedExactlyOnce: true,
        allSemanticToSourceReferencesResolve: true,
        allSourceToSemanticReferencesResolve: true,
        archivedTextItemsSha256: summary.sourceTextSha256,
        compactNodeIdsSha256: sha256(JSON.stringify(graph.nodes.map((node) => compactNodeId(node.id)).sort())),
        compactSourceIdsSha256: sha256(JSON.stringify(expectedSourceIds))
      },
      ...summary
    }, null, 2)}\n`,
    "utf8"
  );
  return summary;
}
