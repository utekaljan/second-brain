import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type {
  ConsolidatedThoughtEdge,
  ConsolidatedThoughtGraph,
  ConsolidatedThoughtNode,
  ThoughtNodeStatus,
  ThoughtNodeType,
  ThoughtRelationType
} from "../compiler/types.js";
import type { ThoughtMacroMapArtifact, ThoughtMacroConstellation } from "../structure/macro_map.js";
import { withOutputDir, type ProjectPaths } from "../system/paths.js";
import type { SourceKind, UnifiedCorpus, UnifiedSegment, UnifiedSourceRef } from "../types/domain.js";
import { ThrottledProgressReporter, type ProgressWriter } from "../utils/progress.js";

type UploadBudget = {
  maxMarkdownFiles: number;
  targetMaxBytesPerFile: number;
  hardMaxBytesPerFile: number;
};

type KnowledgeFileRole =
  | "atlas"
  | "trajectories"
  | "constellation"
  | "unmapped"
  | "source-evidence";

type KnowledgeFileInfo = {
  filename: string;
  title: string;
  bytes: number;
  role: KnowledgeFileRole;
  sectionCount: number;
  estimatedTokens: number;
  areaId?: string;
};

type MacroExportOptions = {
  budget?: Partial<UploadBudget>;
  sourceOutputDir?: string;
  targetOutputDir?: string;
  macroMapPath?: string;
  progress?: ProgressWriter;
};

export type MacroGptExportSummary = {
  generatedAt: string;
  sourceRunId: string;
  sourceGraphPath: string;
  outputDir: string;
  markdownFileCount: number;
  totalBytes: number;
  budget: UploadBudget;
  manifestPath: string;
  markdownManifestPath: string;
  systemPromptChars: number;
  files: KnowledgeFileInfo[];
  retrievalAuditPath: string;
  retrievalPassRate: number;
};

type NodeMacroContext = {
  constellation: ThoughtMacroConstellation;
  role: "core" | "supporting" | "context";
  currentPosition: boolean;
  openQuestion: boolean;
  tension: boolean;
};

type EvidenceRecord = {
  id: string;
  key: string;
  sourceKind: SourceKind;
  documentId: string;
  documentTitle: string;
  locator: string;
  text: string;
  nodeIds: string[];
  nodeTitles: string[];
};

type RetrievalChunk = {
  id: string;
  filename: string;
  title: string;
  text: string;
  primaryNodeId: string | null;
  nodeIds: string[];
  constellationIds: string[];
};

type IndexedRetrievalChunk = {
  chunk: RetrievalChunk;
  frequencies: Map<string, number>;
};

type RetrievalCase = {
  id: string;
  question: string;
  expectedFilenames: string[];
  expectedNodeIds: string[];
};

type RetrievalResult = RetrievalCase & {
  passed: boolean;
  rank: number | null;
  topResults: Array<{
    rank: number;
    filename: string;
    chunkId: string;
    title: string;
    score: number;
    primaryNodeId: string | null;
    nodeIds: string[];
  }>;
};

const DEFAULT_BUDGET: UploadBudget = {
  maxMarkdownFiles: 20,
  targetMaxBytesPerFile: 8_000_000,
  hardMaxBytesPerFile: 11_500_000
};

const HARD_ESTIMATED_TOKEN_LIMIT = 1_900_000;
// Evidence pages need headroom for platform-side tokenization differences and future small additions.
const SOURCE_EVIDENCE_TARGET_ESTIMATED_TOKEN_LIMIT = Math.floor(HARD_ESTIMATED_TOKEN_LIMIT * 0.75);
const INLINE_EVIDENCE_LIMIT = 2;
const NEIGHBOR_LIMIT = 7;

const MACRO_ROLE_PRIORITY: Record<NodeMacroContext["role"], number> = {
  core: 0,
  supporting: 1,
  context: 2
};

const SOURCE_AUTHORITY_PRIORITY: Record<ThoughtMacroMapArtifact["nodeAssessments"][number]["sourceAuthority"], number> = {
  authored: 0,
  mixed: 1,
  conversation: 2,
  chat: 3,
  unknown: 4
};

const TYPE_LABELS: Record<ThoughtNodeType, string> = {
  thesis: "teze",
  question: "otázka",
  theme: "téma",
  tension: "tenze",
  thread: "vývojové vlákno"
};

const STATUS_LABELS: Record<ThoughtNodeStatus, string> = {
  active: "aktivní",
  tentative: "pracovní",
  unresolved: "neuzavřené",
  revised: "revidované"
};

const RELATION_LABELS: Record<ThoughtRelationType, string> = {
  co_occurs: "společně se objevuje s",
  semantic_related: "významově souvisí s",
  supports: "podporuje nebo rozvíjí",
  tensions_with: "je v tenzi s",
  revises: "reviduje",
  supersedes: "nahrazuje",
  context_split: "má oddělený kontext od"
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

const SOURCE_KIND_PRIORITY: Record<SourceKind, number> = {
  writing: 0,
  conversation: 1,
  chat: 2
};

const CZECH_STOP_WORDS = new Set([
  "a", "aby", "ale", "ani", "co", "do", "je", "jak", "jako", "jsou", "k", "ke", "kdy", "ktere",
  "kterou", "ma", "me", "mi", "na", "nad", "nebo", "o", "od", "po", "pod", "pro", "se", "si", "s",
  "ta", "tak", "to", "u", "ve", "v", "z", "za", "ze", "the", "of", "and", "is", "in", "for"
]);

const INSTRUCTIONS_TEXT = [
  "PUBLIC DEMO PLACEHOLDER",
  "The original Custom GPT system prompt is intentionally omitted from this public demo.",
  "This is a non-functional placeholder. Configure and review your own instructions before use. No account, user, or Gizmo identifier is included."
].join("\n\n");

function readJson<T>(target: string): T {
  return JSON.parse(readFileSync(target, "utf8")) as T;
}

function resolveRepoPath(root: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
}

function normalizeBudget(overrides?: Partial<UploadBudget>): UploadBudget {
  const budget = { ...DEFAULT_BUDGET, ...overrides };
  if (budget.maxMarkdownFiles < 1 || budget.targetMaxBytesPerFile < 1 || budget.hardMaxBytesPerFile < 1) {
    throw new Error("GPT export limits must be positive.");
  }
  if (budget.targetMaxBytesPerFile > budget.hardMaxBytesPerFile) {
    throw new Error("GPT export target byte limit cannot exceed the hard limit.");
  }
  return budget;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function searchTokens(value: string): string[] {
  return normalizeText(value)
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 3 && !CZECH_STOP_WORDS.has(token));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, maxChars: number): string {
  const compact = compactWhitespace(value);
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatDate(value: string | null): string {
  return value ? value.slice(0, 10) : "neznámé";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("cs-CZ").format(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

// A conservative language-independent guard. The platform uses its own tokenizer,
// so bytes and this estimate are both checked instead of pretending to know the exact count.
function estimateTokens(value: string): number {
  return Math.ceil(value.length / 3);
}

function slug(value: string): string {
  const result = normalizeText(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return result || "x";
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

function cleanEvidence(value: string): string {
  return value
    .replace(/\[(?:real_time_user_audio_video_asset_pointer|audio_video_asset_pointer|audio_transcription)\]/gi, " ")
    .replace(/\[([^\]\r\n]+)\]\(([^)\r\n]*?\.md(?:#[^)\r\n]*)?)\)/gi, (link, label: string, target: string) =>
      /^(?:https?:)?\/\//i.test(target.trim()) ? link : label
    )
    .split(/\r?\n/)
    .map((line) => compactWhitespace(line.replace(/\s+([,.;!?])/g, "$1")))
    .filter((line) => line.length > 0)
    .filter((line) => !/^www\.[^\s]+$/i.test(line))
    .filter((line) => !/^(?:chatgpt|chatgp)\.(?:cz|com)$/i.test(line))
    .filter((line) => !/(?:děkuj(?:i|eme)|thank you|subscribe|subskrybovat|pozornost)$/i.test(line) || line.length > 140)
    .join("\n\n");
}

function expandedEvidence(segment: UnifiedSegment, segmentsByDocumentId: Map<string, UnifiedSegment[]>): string {
  const base = cleanEvidence(segment.text || segment.textPreview);
  if (base.length >= 320) return base;
  const siblings = segmentsByDocumentId.get(segment.documentId) ?? [];
  const index = siblings.findIndex((candidate) => candidate.id === segment.id);
  if (index < 0) return base;
  const selected = new Map<string, UnifiedSegment>([[segment.id, segment]]);
  let length = base.length;
  for (let distance = 1; distance <= 3 && length < 700; distance += 1) {
    for (const candidate of [siblings[index - distance], siblings[index + distance]]) {
      if (!candidate || candidate.signalKind !== segment.signalKind || candidate.authorKind !== segment.authorKind) continue;
      selected.set(candidate.id, candidate);
      length += candidate.text.length;
    }
  }
  return [...selected.values()]
    .sort((left, right) => left.sequenceIndex - right.sequenceIndex)
    .map((candidate) => cleanEvidence(candidate.text))
    .filter(Boolean)
    .join("\n\n");
}

function prepareDir(target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    rmSync(path.join(target, entry.name), { recursive: true, force: true });
  }
}

function writeKnowledgeFile(
  outputDir: string,
  filename: string,
  title: string,
  role: KnowledgeFileRole,
  sectionCount: number,
  contents: string,
  budget: UploadBudget,
  areaId?: string
): KnowledgeFileInfo {
  const normalized = contents.endsWith("\n") ? contents : `${contents}\n`;
  const bytes = byteLength(normalized);
  const estimatedTokens = estimateTokens(normalized);
  if (bytes > budget.hardMaxBytesPerFile) {
    throw new Error(`${filename} has ${formatNumber(bytes)} bytes, above ${formatNumber(budget.hardMaxBytesPerFile)}.`);
  }
  if (estimatedTokens > HARD_ESTIMATED_TOKEN_LIMIT) {
    throw new Error(`${filename} has a conservative estimate of ${formatNumber(estimatedTokens)} tokens.`);
  }
  writeFileSync(path.join(outputDir, filename), normalized, "utf8");
  return { filename, title, bytes, role, sectionCount, estimatedTokens, areaId };
}

function buildMacroContexts(macroMap: ThoughtMacroMapArtifact): Map<string, NodeMacroContext[]> {
  const result = new Map<string, NodeMacroContext[]>();
  for (const constellation of macroMap.constellations) {
    for (const member of constellation.members) {
      const bucket = result.get(member.nodeId) ?? [];
      bucket.push({ constellation, ...member });
      result.set(member.nodeId, bucket);
    }
  }
  return result;
}

function buildNeighborMap(graph: ConsolidatedThoughtGraph): Map<string, Array<{ edge: ConsolidatedThoughtEdge; targetId: string }>> {
  const result = new Map<string, Array<{ edge: ConsolidatedThoughtEdge; targetId: string }>>();
  for (const edge of graph.edges) {
    const left = result.get(edge.from) ?? [];
    left.push({ edge, targetId: edge.to });
    result.set(edge.from, left);
    const right = result.get(edge.to) ?? [];
    right.push({ edge, targetId: edge.from });
    result.set(edge.to, right);
  }
  for (const [nodeId, entries] of result) {
    const sorted = entries.sort((a, b) =>
      RELATION_PRIORITY[b.edge.type] - RELATION_PRIORITY[a.edge.type] || b.edge.weight - a.edge.weight
    );
    const strongestByTarget = new Map<string, { edge: ConsolidatedThoughtEdge; targetId: string }>();
    for (const entry of sorted) {
      if (!strongestByTarget.has(entry.targetId)) strongestByTarget.set(entry.targetId, entry);
    }
    result.set(nodeId, [...strongestByTarget.values()]);
  }
  return result;
}

function buildEvidence(
  graph: ConsolidatedThoughtGraph,
  corpus: UnifiedCorpus
): { records: EvidenceRecord[]; bySourceKey: Map<string, EvidenceRecord> } {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodeIdsBySourceKey = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    for (const sourceRef of node.sourceRefs) {
      const key = sourceRefKey(sourceRef);
      const bucket = nodeIdsBySourceKey.get(key) ?? new Set<string>();
      bucket.add(node.id);
      nodeIdsBySourceKey.set(key, bucket);
    }
  }
  const segmentsBySourceKey = new Map(corpus.segments.map((segment) => [sourceRefKey(segment.sourceRef), segment]));
  const segmentsByDocumentId = new Map<string, UnifiedSegment[]>();
  for (const segment of corpus.segments) {
    const bucket = segmentsByDocumentId.get(segment.documentId) ?? [];
    bucket.push(segment);
    segmentsByDocumentId.set(segment.documentId, bucket);
  }
  for (const segments of segmentsByDocumentId.values()) {
    segments.sort((left, right) => left.sequenceIndex - right.sequenceIndex);
  }

  const records: EvidenceRecord[] = [];
  const bySourceKey = new Map<string, EvidenceRecord>();
  const counters = new Map<string, number>();
  for (const [key, nodeIdSet] of [...nodeIdsBySourceKey.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const segment = segmentsBySourceKey.get(key);
    if (!segment) continue;
    const text = expandedEvidence(segment, segmentsByDocumentId);
    if (!text) continue;
    const documentCounter = (counters.get(segment.documentId) ?? 0) + 1;
    counters.set(segment.documentId, documentCounter);
    const nodeIds = [...nodeIdSet].sort();
    const record: EvidenceRecord = {
      id: `evidence:${slug(segment.documentId)}:${String(documentCounter).padStart(4, "0")}`,
      key,
      sourceKind: segment.sourceKind,
      documentId: segment.documentId,
      documentTitle: segment.sourceRef.documentTitle,
      locator: segment.sourceRef.locator,
      text,
      nodeIds,
      nodeTitles: nodeIds.map((nodeId) => nodesById.get(nodeId)?.title ?? nodeId)
    };
    records.push(record);
    bySourceKey.set(key, record);
  }
  return { records, bySourceKey };
}

function selectEvidence(node: ConsolidatedThoughtNode, evidenceBySourceKey: Map<string, EvidenceRecord>): EvidenceRecord[] {
  const candidates = unique(node.sourceRefs.map(sourceRefKey))
    .map((key) => evidenceBySourceKey.get(key))
    .filter((record): record is EvidenceRecord => record !== undefined)
    .sort((left, right) =>
      SOURCE_KIND_PRIORITY[left.sourceKind] - SOURCE_KIND_PRIORITY[right.sourceKind] ||
      right.text.length - left.text.length ||
      left.documentTitle.localeCompare(right.documentTitle)
    );
  const selected: EvidenceRecord[] = [];
  const documents = new Set<string>();
  for (const candidate of candidates) {
    if (documents.has(candidate.documentId) && selected.length + 1 < INLINE_EVIDENCE_LIMIT) continue;
    selected.push(candidate);
    documents.add(candidate.documentId);
    if (selected.length >= INLINE_EVIDENCE_LIMIT) break;
  }
  return selected;
}

function nodeTrajectoryLines(nodeId: string, macroMap: ThoughtMacroMapArtifact): string[] {
  const lines: string[] = [];
  for (const trajectory of macroMap.trajectories) {
    for (let index = 0; index < trajectory.stages.length; index += 1) {
      const stage = trajectory.stages[index]!;
      if (!stage.nodeIds.includes(nodeId)) continue;
      lines.push(`${trajectory.title} -> etapa ${index + 1}: ${stage.label}`);
    }
    if (trajectory.currentPositionNodeIds.includes(nodeId)) {
      lines.push(`${trajectory.title} -> současná pozice`);
    }
    if (trajectory.openTensionNodeIds.includes(nodeId)) {
      lines.push(`${trajectory.title} -> otevřená tenze`);
    }
  }
  return unique(lines);
}

function renderNodeDossier(options: {
  node: ConsolidatedThoughtNode;
  macroContexts: NodeMacroContext[];
  macroMap: ThoughtMacroMapArtifact;
  assessment: ThoughtMacroMapArtifact["nodeAssessments"][number] | undefined;
  graphNodesById: Map<string, ConsolidatedThoughtNode>;
  neighbors: Array<{ edge: ConsolidatedThoughtEdge; targetId: string }>;
  evidenceBySourceKey: Map<string, EvidenceRecord>;
}): string {
  const { node, macroContexts, macroMap, assessment, graphNodesById, neighbors, evidenceBySourceKey } = options;
  const constellationLines = macroContexts.length > 0
    ? macroContexts.map((context) => {
        const flags = [
          `role ${context.role}`,
          context.currentPosition ? "současná pozice" : null,
          context.openQuestion ? "otevřená otázka" : null,
          context.tension ? "tenze" : null
        ].filter(Boolean).join(", ");
        return `- ${context.constellation.title} (${flags})`;
      })
    : ["- Mimo hlavní makromapu: detail je zachován v úplném inventáři."];
  const trajectoryLines = nodeTrajectoryLines(node.id, macroMap);
  const aliases = unique([node.canonicalKey, ...node.aliases, ...node.memberCanonicalKeys])
    .filter((alias) => normalizeText(alias) !== normalizeText(node.title))
    .slice(0, 12);
  const relationLines = neighbors.slice(0, NEIGHBOR_LIMIT).map(({ edge, targetId }) => {
    const target = graphNodesById.get(targetId);
    return `- ${RELATION_LABELS[edge.type]}: ${target?.title ?? targetId} (${targetId})${target ? ` — ${clip(target.summary, 180)}` : ""}`;
  });
  const evidence = selectEvidence(node, evidenceBySourceKey);
  const evidenceLines = evidence.map((record) =>
    `- ${record.id} · ${record.sourceKind} · ${record.documentTitle} · ${record.locator}`
  );
  const sourceTitles = unique(node.sourceRefs.map((sourceRef) => sourceRef.documentTitle)).slice(0, 16);
  const authority = assessment
    ? `${assessment.sourceAuthority}; salience ${assessment.salienceScore}/100`
    : "bez makro hodnocení";

  return [
    `## MYŠLENKA | ${node.title}`,
    `ID: ${node.id}`,
    `Vyhledávací formulace: ${unique([node.title, ...aliases]).join(" | ")}`,
    `Typ a stav: ${TYPE_LABELS[node.nodeType]} · ${STATUS_LABELS[node.status]}`,
    `Autorita a význam: ${authority}`,
    `Čas: ${formatDate(node.firstSeen)} až ${formatDate(node.lastSeen)}`,
    "",
    "### Jádro myšlenky",
    node.summary,
    "",
    "### Postavení v mapě",
    ...constellationLines,
    trajectoryLines.length > 0 ? "" : null,
    trajectoryLines.length > 0 ? "Vývojové trajektorie:" : null,
    ...trajectoryLines.map((line) => `- ${line}`),
    relationLines.length > 0 ? "" : null,
    relationLines.length > 0 ? "### Nejbližší myšlenkové vazby" : null,
    ...relationLines,
    evidenceLines.length > 0 ? "" : null,
    evidenceLines.length > 0 ? "### Zdrojová evidence" : null,
    ...evidenceLines,
    sourceTitles.length > 0 ? "" : null,
    sourceTitles.length > 0 ? `Další zdrojové kontexty: ${sourceTitles.join(" | ")}` : null
  ].filter((line): line is string => line !== null).join("\n");
}

function renderCompactNode(nodeId: string, nodesById: Map<string, ConsolidatedThoughtNode>): string {
  const node = nodesById.get(nodeId);
  return node ? `- ${node.title} (${node.id}) — ${clip(node.summary, 220)}` : `- ${nodeId}`;
}

function renderAtlas(
  macroMap: ThoughtMacroMapArtifact,
  nodesById: Map<string, ConsolidatedThoughtNode>,
  filenameByConstellationId: Map<string, string>
): string {
  const entrypointSet = new Set(macroMap.atlas.entrypointConstellationIds);
  const sections = macroMap.atlas.constellationIds.map((constellationId) => {
    const constellation = macroMap.constellations.find((candidate) => candidate.id === constellationId);
    if (!constellation) return "";
    const keyNodes = unique([
      ...constellation.evidenceHighlights.map((item) => item.nodeId),
      ...constellation.members.filter((member) => member.currentPosition).map((member) => member.nodeId),
      ...constellation.members.filter((member) => member.openQuestion).map((member) => member.nodeId)
    ]).slice(0, 10);
    return [
      `## KONSTELACE | ${constellation.title}`,
      `ID: ${constellation.id}`,
      `Soubor detailů: ${filenameByConstellationId.get(constellation.id) ?? "neuveden"}`,
      `Role v atlasu: ${constellation.atlasRole}${entrypointSet.has(constellation.id) ? " · hlavní vstup" : ""}`,
      "",
      constellation.summary,
      "",
      `Proč tato oblast drží pohromadě: ${constellation.rationale}`,
      `Směr dalšího vývoje: ${constellation.trajectoryHint}`,
      "",
      "Klíčové vstupy:",
      ...keyNodes.map((nodeId) => renderCompactNode(nodeId, nodesById))
    ].join("\n");
  });

  return [
    `# ${macroMap.atlas.title}`,
    "",
    "Tento soubor je globální mapa a směrovač dotazů. Pro konkrétní stanovisko pokračuj do bloku MYŠLENKA v uvedeném konstelačním souboru.",
    "",
    macroMap.atlas.summary,
    "",
    "## Jak klást dotazy této mapě",
    "",
    "- Široké téma: najdi relevantní KONSTELACI a její klíčové vstupy.",
    "- Vývoj názoru: použij soubor TRAJEKTORIE A SOUČASNÉ POZICE.",
    "- Konkrétní teze nebo formulace: hledej blok MYŠLENKA podle názvu, aliasu nebo ID.",
    "- Spor či nejistota: hledej otevřené otázky a tenze, nikoli jen aktivní teze.",
    "- Přesná citace nebo původ: hledej EVIDENCE ID v SOURCE EVIDENCE.",
    "",
    ...sections
  ].join("\n\n");
}

function renderTrajectories(macroMap: ThoughtMacroMapArtifact, nodesById: Map<string, ConsolidatedThoughtNode>): string {
  const constellationTitles = new Map(macroMap.constellations.map((item) => [item.id, item.title]));
  const sections = macroMap.trajectories.map((trajectory) => [
    `## TRAJEKTORIE | ${trajectory.title}`,
    `ID: ${trajectory.id}`,
    `Konstelace: ${trajectory.constellationIds.map((id) => constellationTitles.get(id) ?? id).join(" | ")}`,
    "",
    trajectory.summary,
    "",
    ...trajectory.stages.flatMap((stage, index) => [
      `### Etapa ${index + 1} | ${stage.label}`,
      `${stage.summary} Čas: ${formatDate(stage.startDate)} až ${formatDate(stage.endDate)}.`,
      ...stage.nodeIds.slice(0, 14).map((nodeId) => renderCompactNode(nodeId, nodesById)),
      ""
    ]),
    "### Současná pozice",
    ...trajectory.currentPositionNodeIds.map((nodeId) => renderCompactNode(nodeId, nodesById)),
    "",
    "### Otevřené tenze",
    ...trajectory.openTensionNodeIds.map((nodeId) => renderCompactNode(nodeId, nodesById)),
    "",
    `Jistota trajektorie: ${trajectory.confidence}. Nejistota: ${trajectory.uncertainty}`
  ].join("\n"));

  return [
    "# Trajektorie a současné pozice v mapě myšlení",
    "",
    "Trajektorie zachycují změnu, návaznost a současné vyústění. Nejsou to tematické seznamy.",
    "",
    ...sections,
    "",
    "## Globální současné pozice",
    ...macroMap.atlas.currentPositionNodeIds.map((nodeId) => renderCompactNode(nodeId, nodesById)),
    "",
    "## Globální otevřené otázky",
    ...macroMap.atlas.openQuestionNodeIds.map((nodeId) => renderCompactNode(nodeId, nodesById)),
    "",
    "## Globální otevřené tenze",
    ...macroMap.atlas.openTensionNodeIds.map((nodeId) => renderCompactNode(nodeId, nodesById))
  ].join("\n");
}

function renderConstellationHeader(constellation: ThoughtMacroConstellation): string {
  return [
    `# KONSTELACE | ${constellation.title}`,
    `ID: ${constellation.id}`,
    `Role v atlasu: ${constellation.atlasRole}`,
    `Časový rozsah: ${formatDate(constellation.firstSeen)} až ${formatDate(constellation.lastSeen)}`,
    `Autorita: ${constellation.sourceAuthority} · význam ${constellation.salienceScore}/100 · jistota ${constellation.confidence}`,
    "",
    constellation.summary,
    "",
    `Proč drží pohromadě: ${constellation.rationale}`,
    `Vývojový směr: ${constellation.trajectoryHint}`,
    `Známá nejistota: ${constellation.uncertainty}`,
    "",
    "Následují samostatné bloky MYŠLENKA. Každý blok obsahuje dost kontextu pro přímé nalezení bez předchozího čtení atlasu."
  ].join("\n");
}

type SourceEvidencePage = {
  records: EvidenceRecord[];
  contents: string;
};

function sourceEvidenceIntro(): string[] {
  return [
    "# Source evidence pro mapu myšlení",
    "",
    "Toto je dohledávací evidenční vrstva. Interpretaci stanoviska začínej v blocích MYŠLENKA; sem choď pro delší původní pasáž a kontrolu kontextu.",
    ""
  ];
}

function sourceEvidenceRecordLines(
  record: EvidenceRecord,
  previousKind: SourceKind | null,
  previousDocumentId: string | null
): string[] {
  const lines: string[] = [];
  if (record.sourceKind !== previousKind) {
    lines.push(`# ZDROJOVÁ VRSTVA | ${record.sourceKind}`);
    previousDocumentId = null;
  }
  if (record.documentId !== previousDocumentId) {
    lines.push(`## DOKUMENT | ${record.documentTitle}`, `ID dokumentu: ${record.documentId}`);
  }
  lines.push(
    `### EVIDENCE | ${record.id}`,
    `Dokument: ${record.documentTitle} (${record.documentId})`,
    `Locator: ${record.locator}`,
    `Původní zdrojová opora pro: ${record.nodeTitles.slice(0, 8).map((title, index) => `${title} (${record.nodeIds[index]})`).join(" | ")}`,
    "",
    clip(record.text, 700),
    ""
  );
  return lines;
}

function renderSourceEvidencePages(records: EvidenceRecord[], budget: UploadBudget): SourceEvidencePage[] {
  const pages: SourceEvidencePage[] = [];
  let pageRecords: EvidenceRecord[] = [];
  let lines = sourceEvidenceIntro();
  let previousKind: SourceKind | null = null;
  let previousDocumentId: string | null = null;

  const flush = (): void => {
    if (pageRecords.length === 0) return;
    pages.push({ records: pageRecords, contents: lines.join("\n") });
    pageRecords = [];
    lines = sourceEvidenceIntro();
    previousKind = null;
    previousDocumentId = null;
  };

  for (const record of records) {
    let recordLines = sourceEvidenceRecordLines(record, previousKind, previousDocumentId);
    let candidate = [...lines, ...recordLines].join("\n");
    if (
      pageRecords.length > 0 &&
      (byteLength(candidate) > budget.targetMaxBytesPerFile ||
        estimateTokens(candidate) > SOURCE_EVIDENCE_TARGET_ESTIMATED_TOKEN_LIMIT)
    ) {
      flush();
      recordLines = sourceEvidenceRecordLines(record, null, null);
      candidate = [...lines, ...recordLines].join("\n");
    }
    if (byteLength(candidate) > budget.hardMaxBytesPerFile || estimateTokens(candidate) > HARD_ESTIMATED_TOKEN_LIMIT) {
      throw new Error(`Source evidence ${record.id} cannot fit into one Knowledge file.`);
    }
    lines.push(...recordLines);
    pageRecords.push(record);
    previousKind = record.sourceKind;
    previousDocumentId = record.documentId;
  }
  flush();
  return pages;
}

function chunkTextForRetrieval(filename: string, contents: string): RetrievalChunk[] {
  const boundary = filename === "01_ATLAS_AND_QUERY_ROUTES.md"
    ? /^## KONSTELACE \| (.+)$/gm
    : filename === "02_TRAJECTORIES_AND_CURRENT_POSITIONS.md"
      ? /^## ((?:TRAJEKTORIE \| |Globální ).+)$/gm
      : filename.startsWith("90_SOURCE_EVIDENCE")
        ? /^### EVIDENCE \| (.+)$/gm
        : /^## MYŠLENKA \| (.+)$/gm;
  const matches = [...contents.matchAll(boundary)];
  if (matches.length === 0) {
    return [{ id: `${filename}:all`, filename, title: filename, text: contents, primaryNodeId: null, nodeIds: [], constellationIds: [] }];
  }
  const chunks: RetrievalChunk[] = [];
  if ((matches[0]?.index ?? 0) > 0) {
    chunks.push({
      id: `${filename}:intro`,
      filename,
      title: filename,
      text: contents.slice(0, matches[0]!.index),
      primaryNodeId: null,
      nodeIds: [],
      constellationIds: []
    });
  }
  chunks.push(...matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? contents.length;
    const text = contents.slice(start, end);
    const primaryNodeId = text.match(/^ID: (consolidated:[^\n]+)/m)?.[1] ?? null;
    return {
      id: `${filename}:${index + 1}`,
      filename,
      title: match[1] ?? filename,
      text,
      primaryNodeId,
      nodeIds: [...text.matchAll(/consolidated:[a-z0-9:-]+/g)].map((item) => item[0]),
      constellationIds: [...text.matchAll(/macro:[a-z0-9:-]+/g)].map((item) => item[0])
    };
  }));
  return chunks;
}

function buildRetrievalIndex(chunks: RetrievalChunk[]): {
  indexedChunks: IndexedRetrievalChunk[];
  documentFrequency: Map<string, number>;
} {
  const documentFrequency = new Map<string, number>();
  const indexedChunks = chunks.map((chunk) => {
    const frequencies = new Map<string, number>();
    for (const token of searchTokens(`${chunk.title} ${chunk.text}`)) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    for (const token of frequencies.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
    return { chunk, frequencies };
  });
  return { indexedChunks, documentFrequency };
}

function scoreChunks(
  question: string,
  indexedChunks: IndexedRetrievalChunk[],
  documentFrequency: Map<string, number>
): Array<{ chunk: RetrievalChunk; score: number }> {
  const queryTokens = unique(searchTokens(question));
  const normalizedQuestion = normalizeText(question);
  return indexedChunks.map(({ chunk, frequencies }) => {
    let score = 0;
    for (const token of queryTokens) {
      const tf = Math.min(frequencies.get(token) ?? 0, 8);
      if (tf === 0) continue;
      const idf = Math.log((indexedChunks.length + 1) / ((documentFrequency.get(token) ?? 0) + 1)) + 1;
      score += (1 + Math.log(tf)) * idf;
    }
    if (normalizeText(chunk.title).includes(normalizedQuestion) || normalizedQuestion.includes(normalizeText(chunk.title))) {
      score += 18;
    }
    return { chunk, score };
  }).sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id));
}

function buildRetrievalCases(
  macroMap: ThoughtMacroMapArtifact,
  nodesById: Map<string, ConsolidatedThoughtNode>,
  filenameByConstellationId: Map<string, string>,
  evidenceRecords: EvidenceRecord[],
  filenameByEvidenceId: Map<string, string>
): RetrievalCase[] {
  const cases: RetrievalCase[] = [];
  for (const constellationId of macroMap.atlas.entrypointConstellationIds) {
    const constellation = macroMap.constellations.find((item) => item.id === constellationId);
    const filename = filenameByConstellationId.get(constellationId);
    if (!constellation || !filename) continue;
    cases.push({
      id: `constellation:${constellationId}`,
      question: `Jaké hlavní myšlenky obsahuje téma ${constellation.title}?`,
      expectedFilenames: ["01_ATLAS_AND_QUERY_ROUTES.md", filename],
      expectedNodeIds: []
    });
  }
  for (const trajectory of macroMap.trajectories) {
    cases.push({
      id: `trajectory:${trajectory.id}`,
      question: `Jak se vyvíjela linie ${trajectory.title}?`,
      expectedFilenames: ["02_TRAJECTORIES_AND_CURRENT_POSITIONS.md"],
      expectedNodeIds: []
    });
  }
  for (const item of [...macroMap.currentPositions, ...macroMap.openTensions].slice(0, 16)) {
    const node = nodesById.get(item.nodeId);
    if (!node) continue;
    cases.push({
      id: `node:${node.id}`,
      question: node.aliases[0]
        ? `Co podklady uvádějí k formulaci ${node.aliases[0]}?`
        : `Co podklady uvádějí k formulaci ${node.title}?`,
      expectedFilenames: item.constellationIds.map((id) => filenameByConstellationId.get(id)).filter((x): x is string => Boolean(x)),
      expectedNodeIds: [node.id]
    });
  }
  for (const evidence of evidenceRecords.filter((item) => item.sourceKind === "writing").slice(0, 4)) {
    cases.push({
      id: `source:${evidence.id}`,
      question: `Najdi původní oporu z textu ${evidence.documentTitle} k myšlence ${evidence.nodeTitles[0] ?? ""}.`,
      expectedFilenames: [filenameByEvidenceId.get(evidence.id) ?? "90_SOURCE_EVIDENCE.md"],
      expectedNodeIds: evidence.nodeIds.slice(0, 1)
    });
  }
  return cases;
}

function runRetrievalAudit(cases: RetrievalCase[], chunks: RetrievalChunk[]): { results: RetrievalResult[]; passRate: number; meanReciprocalRank: number } {
  const { indexedChunks, documentFrequency } = buildRetrievalIndex(chunks);
  const results = cases.map((testCase) => {
    const ranked = scoreChunks(testCase.question, indexedChunks, documentFrequency).slice(0, 8);
    const matchingIndex = ranked.findIndex(({ chunk }) =>
      testCase.expectedFilenames.includes(chunk.filename) &&
      (testCase.expectedNodeIds.length === 0 || testCase.expectedNodeIds.some((id) =>
        chunk.filename.startsWith("90_SOURCE_EVIDENCE") ? chunk.nodeIds.includes(id) : chunk.primaryNodeId === id
      ))
    );
    return {
      ...testCase,
      passed: matchingIndex >= 0 && matchingIndex < 5,
      rank: matchingIndex >= 0 ? matchingIndex + 1 : null,
      topResults: ranked.map(({ chunk, score }, index) => ({
        rank: index + 1,
        filename: chunk.filename,
        chunkId: chunk.id,
        title: chunk.title,
        score: Number(score.toFixed(3)),
        primaryNodeId: chunk.primaryNodeId,
        nodeIds: chunk.nodeIds
      }))
    };
  });
  const passed = results.filter((result) => result.passed).length;
  const reciprocalRank = results.reduce((sum, result) => sum + (result.rank ? 1 / result.rank : 0), 0);
  return {
    results,
    passRate: results.length > 0 ? passed / results.length : 1,
    meanReciprocalRank: results.length > 0 ? reciprocalRank / results.length : 1
  };
}

function buildPreviewQuestions(
  macroMap: ThoughtMacroMapArtifact,
  nodesById: Map<string, ConsolidatedThoughtNode>
): string[] {
  const questions: string[] = [];
  for (const constellationId of macroMap.atlas.entrypointConstellationIds.slice(0, 2)) {
    const constellation = macroMap.constellations.find((item) => item.id === constellationId);
    if (constellation) {
      questions.push(`Jaké jsou hlavní myšlenky v oblasti „${constellation.title}“ a jak spolu souvisejí?`);
    }
  }
  for (const trajectoryId of macroMap.atlas.trajectoryIds.slice(0, 2)) {
    const trajectory = macroMap.trajectories.find((item) => item.id === trajectoryId);
    if (trajectory) {
      questions.push(`Jak se vyvíjela linie „${trajectory.title}“ a která pozice je v podkladech nejnovější?`);
    }
  }
  const openQuestionId = macroMap.atlas.openQuestionNodeIds[0] ?? macroMap.openQuestions[0]?.nodeId;
  const openQuestion = openQuestionId ? nodesById.get(openQuestionId) : undefined;
  if (openQuestion) {
    questions.push(`Co zůstává otevřené u myšlenky „${openQuestion.title}“?`);
  }
  const currentPositionId = macroMap.atlas.currentPositionNodeIds[0] ?? macroMap.currentPositions[0]?.nodeId;
  const currentPosition = currentPositionId ? nodesById.get(currentPositionId) : undefined;
  if (currentPosition) {
    questions.push(`Jaké zdroje a napětí podpírají současnou pozici „${currentPosition.title}“?`);
  }
  if (questions.length === 0) {
    questions.push(`Jaké jsou hlavní směry v atlasu „${macroMap.atlas.title}“?`);
  }
  return unique(questions).slice(0, 5);
}

function setupInstructions(
  files: KnowledgeFileInfo[],
  macroMap: ThoughtMacroMapArtifact,
  nodesById: Map<string, ConsolidatedThoughtNode>
): string {
  const previewQuestions = buildPreviewQuestions(macroMap, nodesById);
  return [
    "CUSTOM GPT SETUP - tento soubor nevkládej do Knowledge",
    "",
    "Do pole Instructions vlož následující text:",
    "",
    INSTRUCTIONS_TEXT,
    "",
    "Do Knowledge nahraj pouze tyto Markdown soubory:",
    ...files.map((file) => `- ${file.filename}`),
    "",
    "Doporučené testy v Preview (odvozené z aktuálního atlasu):",
    ...previewQuestions.map((question) => `- ${question}`)
  ].join("\n");
}

/**
 * Render a macro-map-first Custom GPT knowledge pack without invoking any model.
 */
export function renderMacroGptMarkdownExport(
  basePaths: ProjectPaths,
  options: MacroExportOptions
): MacroGptExportSummary {
  const progress = new ThrottledProgressReporter(options.progress ?? (() => undefined));
  const budget = normalizeBudget(options.budget);
  const sourcePaths = options.sourceOutputDir ? withOutputDir(basePaths, options.sourceOutputDir) : basePaths;
  const targetPaths = options.targetOutputDir ? withOutputDir(basePaths, options.targetOutputDir) : sourcePaths;
  const macroMapPath = options.macroMapPath
    ? resolveRepoPath(basePaths.root, options.macroMapPath)
    : path.join(targetPaths.compiledDir, "thought_macro_map.json");
  const graphPath = path.join(sourcePaths.compiledDir, "consolidated_thought_graph.json");
  const corpusPath = path.join(sourcePaths.normalizedUnifiedDir, "corpus.json");

  for (const required of [macroMapPath, graphPath, corpusPath]) {
    if (!existsSync(required)) throw new Error(`Missing GPT export input: ${required}`);
  }

  progress.phase("export-gpt", "loading graph, corpus, and macro map");
  const graph = readJson<ConsolidatedThoughtGraph>(graphPath);
  const corpus = readJson<UnifiedCorpus>(corpusPath);
  const macroMap = readJson<ThoughtMacroMapArtifact>(macroMapPath);
  if (macroMap.sourceNodeCount !== graph.nodeCount) {
    throw new Error(`Macro map covers ${macroMap.sourceNodeCount} nodes but graph contains ${graph.nodeCount}.`);
  }
  const graphNodeIds = new Set(graph.nodes.map((node) => node.id));
  const unknownMacroNode = macroMap.constellations.flatMap((item) => item.memberNodeIds).find((id) => !graphNodeIds.has(id));
  if (unknownMacroNode) throw new Error(`Macro map references a node absent from the source graph: ${unknownMacroNode}`);

  const outputDir = targetPaths.exportsGptDir;
  prepareDir(outputDir);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const assessmentsByNodeId = new Map(macroMap.nodeAssessments.map((item) => [item.nodeId, item]));
  const contextsByNodeId = buildMacroContexts(macroMap);
  const neighborsByNodeId = buildNeighborMap(graph);
  const evidence = buildEvidence(graph, corpus);

  const filenameByConstellationId = new Map<string, string>();
  macroMap.constellations.forEach((constellation, index) => {
    filenameByConstellationId.set(
      constellation.id,
      `${String(index + 10).padStart(2, "0")}_CONSTELLATION_${slug(constellation.title).toUpperCase()}.md`
    );
  });

  const files: KnowledgeFileInfo[] = [];
  const retrievalChunks: RetrievalChunk[] = [];
  function writeAndIndex(filename: string, title: string, role: KnowledgeFileRole, count: number, contents: string, areaId?: string): void {
    files.push(writeKnowledgeFile(outputDir, filename, title, role, count, contents, budget, areaId));
    retrievalChunks.push(...chunkTextForRetrieval(filename, contents));
  }

  progress.phase("export-gpt", "rendering atlas and trajectories");
  writeAndIndex(
    "01_ATLAS_AND_QUERY_ROUTES.md",
    macroMap.atlas.title,
    "atlas",
    macroMap.constellations.length,
    renderAtlas(macroMap, nodesById, filenameByConstellationId)
  );
  writeAndIndex(
    "02_TRAJECTORIES_AND_CURRENT_POSITIONS.md",
    "Trajektorie a současné pozice",
    "trajectories",
    macroMap.trajectories.length,
    renderTrajectories(macroMap, nodesById)
  );

  progress.phase("export-gpt", "rendering constellation dossiers");
  for (const constellation of macroMap.constellations) {
    const filename = filenameByConstellationId.get(constellation.id)!;
    const membershipByNodeId = new Map(constellation.members.map((member) => [member.nodeId, member]));
    const members = constellation.memberNodeIds
      .map((nodeId) => nodesById.get(nodeId))
      .filter((node): node is ConsolidatedThoughtNode => node !== undefined)
      .sort((left, right) => {
        const leftMembership = membershipByNodeId.get(left.id);
        const rightMembership = membershipByNodeId.get(right.id);
        const leftAssessment = assessmentsByNodeId.get(left.id);
        const rightAssessment = assessmentsByNodeId.get(right.id);
        return (
          (leftMembership ? MACRO_ROLE_PRIORITY[leftMembership.role] : Number.MAX_SAFE_INTEGER) -
            (rightMembership ? MACRO_ROLE_PRIORITY[rightMembership.role] : Number.MAX_SAFE_INTEGER) ||
          Number(rightMembership?.currentPosition ?? false) - Number(leftMembership?.currentPosition ?? false) ||
          (leftAssessment ? SOURCE_AUTHORITY_PRIORITY[leftAssessment.sourceAuthority] : Number.MAX_SAFE_INTEGER) -
            (rightAssessment ? SOURCE_AUTHORITY_PRIORITY[rightAssessment.sourceAuthority] : Number.MAX_SAFE_INTEGER) ||
          (rightAssessment?.salienceScore ?? 0) - (leftAssessment?.salienceScore ?? 0) ||
          left.title.localeCompare(right.title)
        );
      });
    const dossiers = members.map((node) => renderNodeDossier({
      node,
      macroContexts: contextsByNodeId.get(node.id) ?? [],
      macroMap,
      assessment: assessmentsByNodeId.get(node.id),
      graphNodesById: nodesById,
      neighbors: neighborsByNodeId.get(node.id) ?? [],
      evidenceBySourceKey: evidence.bySourceKey
    }));
    writeAndIndex(
      filename,
      constellation.title,
      "constellation",
      members.length,
      [renderConstellationHeader(constellation), ...dossiers].join("\n\n---\n\n"),
      constellation.id
    );
  }

  progress.phase("export-gpt", "rendering complete residual inventory");
  const unmappedNodes = macroMap.quality.unmappedNodeIds
    .map((nodeId) => nodesById.get(nodeId))
    .filter((node): node is ConsolidatedThoughtNode => node !== undefined)
    .sort((left, right) =>
      (assessmentsByNodeId.get(right.id)?.salienceScore ?? 0) - (assessmentsByNodeId.get(left.id)?.salienceScore ?? 0) ||
      left.title.localeCompare(right.title)
    );
  const unmappedContents = [
    "# Myšlenky mimo hlavní makromapu",
    "",
    "Úplný zbytkový inventář. Tyto uzly nebyly násilně přiřazeny do konstelace, ale zůstávají dohledatelné jako samonosné bloky MYŠLENKA.",
    "",
    ...unmappedNodes.map((node) => renderNodeDossier({
      node,
      macroContexts: [],
      macroMap,
      assessment: assessmentsByNodeId.get(node.id),
      graphNodesById: nodesById,
      neighbors: neighborsByNodeId.get(node.id) ?? [],
      evidenceBySourceKey: evidence.bySourceKey
    }))
  ].join("\n\n---\n\n");
  writeAndIndex("80_UNMAPPED_THOUGHTS.md", "Myšlenky mimo hlavní makromapu", "unmapped", unmappedNodes.length, unmappedContents);

  progress.phase("export-gpt", "rendering source evidence");
  const sourcePages = renderSourceEvidencePages(evidence.records, budget);
  const filenameByEvidenceId = new Map<string, string>();
  sourcePages.forEach((page, index) => {
    const filename = sourcePages.length === 1
      ? "90_SOURCE_EVIDENCE.md"
      : `90_SOURCE_EVIDENCE_${String(index + 1).padStart(2, "0")}.md`;
    page.records.forEach((record) => filenameByEvidenceId.set(record.id, filename));
    writeAndIndex(
      filename,
      sourcePages.length === 1 ? "Source evidence" : `Source evidence ${index + 1}/${sourcePages.length}`,
      "source-evidence",
      page.records.length,
      page.contents
    );
  });

  if (files.length > budget.maxMarkdownFiles) {
    throw new Error(`GPT export produced ${files.length} Knowledge files; the configured maximum is ${budget.maxMarkdownFiles}.`);
  }

  progress.phase("export-gpt", "running deterministic retrieval audit");
  const retrievalCases = buildRetrievalCases(
    macroMap,
    nodesById,
    filenameByConstellationId,
    evidence.records,
    filenameByEvidenceId
  );
  const retrievalAudit = runRetrievalAudit(retrievalCases, retrievalChunks);
  const retrievalAuditPath = path.join(outputDir, "retrieval-audit.json");
  writeFileSync(retrievalAuditPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    method: "deterministic lexical chunk retrieval approximation; not the Custom GPT production index",
    caseCount: retrievalCases.length,
    passedCount: retrievalAudit.results.filter((item) => item.passed).length,
    passRate: retrievalAudit.passRate,
    meanReciprocalRank: retrievalAudit.meanReciprocalRank,
    results: retrievalAudit.results
  }, null, 2)}\n`, "utf8");

  const generatedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 2,
    generatedAt,
    architecture: "macro-map-first-rag-pack",
    sourceRunId: graph.sourceRunId,
    sourceGraphPath: graphPath,
    sourceCorpusPath: corpusPath,
    sourceMacroMapPath: macroMapPath,
    sourceNodeCount: graph.nodeCount,
    mappedNodeCount: graph.nodeCount - unmappedNodes.length,
    unmappedNodeCount: unmappedNodes.length,
    constellationCount: macroMap.constellations.length,
    trajectoryCount: macroMap.trajectories.length,
    knowledgeFileCount: files.length,
    markdownFileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    uploadBudget: budget,
    estimatedTokenLimitPerFile: HARD_ESTIMATED_TOKEN_LIMIT,
    retrievalAudit: {
      path: retrievalAuditPath,
      caseCount: retrievalCases.length,
      passRate: retrievalAudit.passRate,
      meanReciprocalRank: retrievalAudit.meanReciprocalRank
    },
    files
  };
  const manifestPath = path.join(outputDir, "export-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(
    path.join(outputDir, "00_CUSTOM_GPT_SETUP.txt"),
    `${setupInstructions(files, macroMap, nodesById)}\n`,
    "utf8"
  );

  progress.phase("export-gpt", "macro-map knowledge pack written");
  return {
    generatedAt,
    sourceRunId: graph.sourceRunId,
    sourceGraphPath: graphPath,
    outputDir,
    markdownFileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    budget,
    manifestPath,
    markdownManifestPath: "",
    systemPromptChars: INSTRUCTIONS_TEXT.length,
    files,
    retrievalAuditPath,
    retrievalPassRate: retrievalAudit.passRate
  };
}
