import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexCliClient, type CodexReasoningEffort } from "../codex/client.js";
import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import type {
  ConsolidatedThoughtGraph,
  ConsolidatedThoughtNode,
  ThoughtFrameAlignmentArtifact
} from "../compiler/types.js";
import type { ProjectPaths } from "../system/paths.js";
import { ThrottledProgressReporter, type ProgressWriter } from "../utils/progress.js";
import { slugify } from "../utils/text.js";
import { hashStableSet } from "../utils/stable_hash.js";
import {
  computeConsolidatedGraphSemanticHash,
  computeFrameAlignmentSemanticHash
} from "./artifact_identity.js";
import {
  assessMacroNodes,
  attachTrajectories,
  buildMacroMapArtifact,
  buildMacroMapReport,
  buildTrajectoryPrompt,
  repairMacroMapCoverage,
  requiresMacroMapCoverage,
  validateMacroMapProposal,
  validateMacroTrajectories,
  type MacroAtlasRole,
  type MacroMapProposal,
  type MacroNodeAssessment,
  type MacroNodeRole,
  type MacroTrajectoryProposal,
  type ThoughtMacroMapArtifact,
  type ThoughtMacroMapSummary
} from "./macro_map.js";

const DEFAULTS = SECOND_BRAIN_DEFAULTS.thoughtMacroMap;
const SEMANTIC_WORKER_CONFIG = {
  "features.shell_tool": false,
  "features.multi_agent": false,
  "features.memories": false,
  "features.apps": false,
  "features.hooks": false,
  web_search: "disabled"
} as const;

export type MacroAtlasProposal = {
  atlasTitle: string;
  atlasSummary: string;
  constellations: Array<{
    key: string;
    title: string;
    summary: string;
    rationale: string;
    trajectoryHint: string;
    atlasRole: MacroAtlasRole;
    confidence: number;
    uncertainty: string;
    seedNodeIds: string[];
  }>;
};

export type MacroAtlasDisplayOverrides = {
  atlasTitle?: string;
  atlasSummary?: string;
  constellations: Record<string, Partial<Pick<
    MacroAtlasProposal["constellations"][number],
    "title" | "summary" | "rationale" | "trajectoryHint" | "uncertainty"
  >>>;
};

type MacroMembership = {
  constellationKey: string;
  role: MacroNodeRole;
  currentPosition: boolean;
  openQuestion: boolean;
  tension: boolean;
};

export type MacroMembershipItem = {
  nodeId: string;
  memberships: MacroMembership[];
  omissionReason: "mapped" | "local_detail" | "off_topic" | "weak_evidence";
  rationale: string;
};

type MacroMembershipBatchOutput = {
  batchId: string;
  items: MacroMembershipItem[];
};

type ScaledMacroMapRunStatus = "in_progress" | "paused_manual" | "failed" | "completed";

type ScaledMacroMapRunState = {
  schemaVersion: 1 | 2;
  contractVersion: string;
  runId: string;
  createdAt: string;
  updatedAt: string;
  status: ScaledMacroMapRunStatus;
  iterationLabel: string;
  model: string | null;
  reasoningEffort: CodexReasoningEffort;
  sourceOutputDir: string;
  targetOutputDir: string;
  sourceGraphHash: string;
  sourceAlignmentHash: string | null;
  sourceGraphSemanticHash?: string;
  sourceAlignmentSemanticHash?: string | null;
  atlasHash?: string | null;
  trajectoryInputHash?: string | null;
  reusedMembershipItemCount?: number;
  generatedMembershipItemCount?: number;
  atlasReused?: boolean;
  trajectoryReused?: boolean;
  membershipPlanNodeIds?: string[];
  membershipPlanGraphSemanticHash?: string;
  membershipPlanAtlasHash?: string;
  membershipBatchSize: number;
  atlasCompleted: boolean;
  membershipBatchCount: number;
  completedMembershipBatchIds: string[];
  coverageBatchCount: number;
  completedCoverageBatchIds: string[];
  trajectoryCompleted: boolean;
  failureMessage: string | null;
};

export type ScaledThoughtMacroMapSummary = ThoughtMacroMapSummary & {
  status: ScaledMacroMapRunStatus;
  runId: string;
  sourceNodeCount: number;
  representativeNodeCount: number;
  membershipBatchCount: number;
  completedMembershipBatchCount: number;
  coverageBatchCount: number;
  atlasReused: boolean;
  reusedMembershipItemCount: number;
  generatedMembershipItemCount: number;
  trajectoryReused: boolean;
};

type ScaledMacroMapOptions = {
  paths: ProjectPaths;
  client?: Pick<CodexCliClient, "execSemanticBatch">;
  model?: string;
  reasoningEffort: CodexReasoningEffort;
  iterationLabel: string;
  sourceOutputDir?: string;
  targetOutputDir?: string;
  membershipBatchSize?: number;
  maxMembershipBatches?: number | null;
  forceNewRun?: boolean;
  replayCompleted?: boolean;
  refreshTrajectories?: boolean;
  atlasDisplayOverridesPath?: string;
  refinedTrajectoryPath?: string;
  progress?: ProgressWriter;
};

type PrepareScaledMacroMapReuseOptions = Pick<
  ScaledMacroMapOptions,
  "paths" | "model" | "reasoningEffort" | "sourceOutputDir" | "targetOutputDir" | "progress"
>;

type MacroMembershipCacheEntry = {
  cacheKey: string;
  nodeId: string;
  nodeInputHash: string;
  atlasHash: string;
  contractVersion: string;
  model: string | null;
  reasoningEffort: CodexReasoningEffort;
  item: MacroMembershipItem;
  sourceRunId: string;
  updatedAt: string;
};

type MacroMembershipCache = {
  version: 1;
  generatedAt: string;
  entries: Record<string, MacroMembershipCacheEntry>;
};

type ReusableAtlasRun = {
  runDir: string;
  state: ScaledMacroMapRunState;
  atlas: MacroAtlasProposal;
  atlasHash: string;
  topologyDriftShare: number;
};

const ATLAS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["atlasTitle", "atlasSummary", "constellations"],
  properties: {
    atlasTitle: { type: "string" },
    atlasSummary: { type: "string" },
    constellations: {
      type: "array",
      minItems: DEFAULTS.minConstellationCount,
      maxItems: DEFAULTS.maxConstellationCount,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "key",
          "title",
          "summary",
          "rationale",
          "trajectoryHint",
          "atlasRole",
          "confidence",
          "uncertainty",
          "seedNodeIds"
        ],
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          rationale: { type: "string" },
          trajectoryHint: { type: "string" },
          atlasRole: {
            type: "string",
            enum: ["core_direction", "active_exploration", "supporting_context"]
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          uncertainty: { type: "string" },
          seedNodeIds: {
            type: "array",
            minItems: 3,
            maxItems: 12,
            items: { type: "string" }
          }
        }
      }
    }
  }
} as const;

const MEMBERSHIP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["batchId", "items"],
  properties: {
    batchId: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["nodeId", "memberships", "omissionReason", "rationale"],
        properties: {
          nodeId: { type: "string" },
          memberships: {
            type: "array",
            maxItems: DEFAULTS.maxMembershipsPerNode,
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "constellationKey",
                "role",
                "currentPosition",
                "openQuestion",
                "tension"
              ],
              properties: {
                constellationKey: { type: "string" },
                role: { type: "string", enum: ["core", "supporting", "context"] },
                currentPosition: { type: "boolean" },
                openQuestion: { type: "boolean" },
                tension: { type: "boolean" }
              }
            }
          },
          omissionReason: {
            type: "string",
            enum: ["mapped", "local_detail", "off_topic", "weak_evidence"]
          },
          rationale: { type: "string" }
        }
      }
    }
  }
} as const;

const TRAJECTORY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["trajectories"],
  properties: {
    trajectories: {
      type: "array",
      minItems: 2,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "key",
          "title",
          "summary",
          "constellationIds",
          "stages",
          "currentPositionNodeIds",
          "openTensionNodeIds",
          "confidence",
          "uncertainty"
        ],
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          constellationIds: { type: "array", minItems: 1, items: { type: "string" } },
          stages: {
            type: "array",
            minItems: 2,
            maxItems: 6,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "summary", "nodeIds", "startDate", "endDate"],
              properties: {
                label: { type: "string" },
                summary: { type: "string" },
                nodeIds: { type: "array", minItems: 1, items: { type: "string" } },
                startDate: { type: ["string", "null"] },
                endDate: { type: ["string", "null"] }
              }
            }
          },
          currentPositionNodeIds: { type: "array", minItems: 1, items: { type: "string" } },
          openTensionNodeIds: { type: "array", items: { type: "string" } },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          uncertainty: { type: "string" }
        }
      }
    }
  }
} as const;

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function writeJson(filePath: string, value: unknown): string {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

/** Retry only semantic contract failures; transport timeouts are handled by the client. */
function executeValidatedSemanticBatch<T>(options: {
  client: Pick<CodexCliClient, "execSemanticBatch">;
  prompt: string;
  outputSchemaPath: string;
  workingDir: string;
  targetOutputDir: string;
  model?: string;
  reasoningEffort: CodexReasoningEffort;
  rawPath: string;
  validate: (raw: T) => T;
  onRetry?: (message: string) => void;
}): T {
  for (let attempt = 1; attempt <= DEFAULTS.semanticValidationAttempts; attempt += 1) {
    const response = options.client.execSemanticBatch<T>({
      prompt: options.prompt,
      outputSchemaPath: options.outputSchemaPath,
      workingDir: options.workingDir,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      extraWritableDirs: [options.targetOutputDir],
      configOverrides: SEMANTIC_WORKER_CONFIG,
      sandboxMode: "read-only"
    });
    const rawPath = attempt === 1
      ? options.rawPath
      : options.rawPath.replace(/\.raw\.json$/, `.attempt-${attempt}.raw.json`);
    writeJson(rawPath, response.parsed);
    try {
      return options.validate(response.parsed);
    } catch (error) {
      if (attempt >= DEFAULTS.semanticValidationAttempts) throw error;
      const message = error instanceof Error ? error.message : String(error);
      options.onRetry?.(`validation attempt ${attempt} failed: ${message}`);
    }
  }
  throw new Error("Semantic validation attempts exhausted.");
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function resolveRepoPath(root: string, value: string | undefined, fallback: string): string {
  return path.resolve(root, value ?? fallback);
}

function nodeDocumentIds(node: ConsolidatedThoughtNode): string[] {
  return uniqueSorted(node.sourceRefs.map((ref) => ref.documentId));
}

function sourceAuthorityPriority(authority: MacroNodeAssessment["sourceAuthority"]): number {
  if (authority === "mixed") return 0;
  if (authority === "authored") return 1;
  if (authority === "conversation") return 2;
  if (authority === "chat") return 3;
  return 4;
}

/**
 * Build a bounded but source-diverse atlas input. All authored evidence stays
 * visible; conversation slots are allocated across documents before remaining
 * capacity is filled by salience, preventing one long thread from taking over.
 */
export function selectMacroAtlasRepresentatives(options: {
  graph: ConsolidatedThoughtGraph;
  assessments: MacroNodeAssessment[];
  limit?: number;
  perDocument?: number;
  minimumDocumentNodeCount?: number;
}): MacroNodeAssessment[] {
  const limit = options.limit ?? DEFAULTS.atlasRepresentativeLimit;
  const perDocument = options.perDocument ?? DEFAULTS.atlasRepresentativesPerDocument;
  const minimumDocumentNodeCount =
    options.minimumDocumentNodeCount ?? DEFAULTS.atlasMinimumDocumentNodeCount;
  const selected = new Set<string>();
  const authored = options.assessments.filter((item) =>
    item.sourceAuthority === "authored" || item.sourceAuthority === "mixed"
  );
  if (authored.length > limit) {
    throw new Error(
      `Atlas representative limit ${limit} is smaller than ${authored.length} authored nodes.`
    );
  }
  authored.forEach((item) => selected.add(item.nodeId));
  options.assessments
    .filter((item) => item.salienceScore >= DEFAULTS.highSalienceThreshold)
    .sort((left, right) =>
      right.salienceScore - left.salienceScore || left.nodeId.localeCompare(right.nodeId)
    )
    .forEach((item) => {
      if (selected.size < limit) selected.add(item.nodeId);
    });

  const assessmentsByDocument = new Map<string, MacroNodeAssessment[]>();
  for (const assessment of options.assessments) {
    for (const documentId of assessment.documentIds) {
      assessmentsByDocument.set(documentId, [
        ...(assessmentsByDocument.get(documentId) ?? []),
        assessment
      ]);
    }
  }
  const qualifiedDocuments = Array.from(assessmentsByDocument.entries())
    .filter(([, items]) => items.length >= minimumDocumentNodeCount)
    .map(([documentId, items]) => ({
      documentId,
      items: items.slice().sort((left, right) =>
        right.salienceScore - left.salienceScore || left.nodeId.localeCompare(right.nodeId)
      )
    }))
    .sort((left, right) =>
      (right.items[0]?.salienceScore ?? 0) - (left.items[0]?.salienceScore ?? 0) ||
      left.documentId.localeCompare(right.documentId)
    );

  for (let rank = 0; rank < perDocument && selected.size < limit; rank += 1) {
    for (const document of qualifiedDocuments) {
      const assessment = document.items[rank];
      if (assessment) selected.add(assessment.nodeId);
      if (selected.size >= limit) break;
    }
  }
  // Keep allocating by document after the guaranteed minimum. A global fill
  // here would let one very long conversation dominate the remaining slots.
  let rank = perDocument;
  let addedAtRank = true;
  while (selected.size < limit && addedAtRank) {
    addedAtRank = false;
    for (const document of qualifiedDocuments) {
      const assessment = document.items[rank];
      if (assessment && !selected.has(assessment.nodeId)) {
        selected.add(assessment.nodeId);
        addedAtRank = true;
      }
      if (selected.size >= limit) break;
    }
    rank += 1;
  }
  for (const assessment of options.assessments) {
    if (selected.size >= limit) break;
    selected.add(assessment.nodeId);
  }

  const selectedAssessments = options.assessments.filter((item) => selected.has(item.nodeId));
  return selectedAssessments.sort((left, right) => {
    const authorityDelta = sourceAuthorityPriority(left.sourceAuthority) -
      sourceAuthorityPriority(right.sourceAuthority);
    if (authorityDelta !== 0) return authorityDelta;
    return right.salienceScore - left.salienceScore || left.nodeId.localeCompare(right.nodeId);
  });
}

function compactNode(
  node: ConsolidatedThoughtNode,
  assessment: MacroNodeAssessment,
  nodeById: Map<string, ConsolidatedThoughtNode>,
  summaryLimit: number
): Record<string, unknown> {
  return {
    id: node.id,
    title: node.title,
    summary: node.summary.slice(0, summaryLimit),
    type: node.nodeType,
    status: node.status,
    firstSeen: node.firstSeen,
    lastSeen: node.lastSeen,
    salience: assessment.salienceScore,
    sourceAuthority: assessment.sourceAuthority,
    documents: assessment.documentIds,
    frameLabels: uniqueSorted((node.frameMemberships ?? []).map((item) => item.frameLabel)).slice(0, 4),
    relatedTitles: node.relatedNodeIds
      .slice(0, 5)
      .map((nodeId) => nodeById.get(nodeId)?.title)
      .filter((title): title is string => Boolean(title))
  };
}

function stableNodeIdentity(nodeId: string): string {
  const parts = nodeId.split(":");
  return parts[0] === "consolidated" && parts.length >= 2
    ? parts.slice(0, 2).join(":")
    : nodeId;
}

function macroAtlasHash(atlas: MacroAtlasProposal): string {
  return hashStableSet({
    contractVersion: DEFAULTS.contractVersion,
    atlasTitle: atlas.atlasTitle,
    atlasSummary: atlas.atlasSummary,
    constellations: atlas.constellations.map((item) => ({
      key: item.key,
      title: item.title,
      summary: item.summary,
      rationale: item.rationale,
      trajectoryHint: item.trajectoryHint,
      atlasRole: item.atlasRole,
      confidence: item.confidence,
      uncertainty: item.uncertainty,
      seedNodeIds: item.seedNodeIds.map(stableNodeIdentity)
    }))
  });
}

function macroTrajectoryEvidenceHash(artifact: ThoughtMacroMapArtifact): string {
  const memberNodeIds = new Set(
    artifact.constellations.flatMap((constellation) => constellation.memberNodeIds)
  );
  return hashStableSet({
    contractVersion: artifact.contractVersion,
    constellations: artifact.constellations.map((constellation) => ({
      id: constellation.id,
      title: constellation.title,
      summary: constellation.summary,
      trajectoryHint: constellation.trajectoryHint,
      atlasRole: constellation.atlasRole,
      firstSeen: constellation.firstSeen,
      lastSeen: constellation.lastSeen,
      members: constellation.members
    })),
    nodeAssessments: artifact.nodeAssessments.filter((item) => memberNodeIds.has(item.nodeId))
  });
}

/**
 * Membership reuse follows durable node meaning, not global rank noise.
 * Salience is intentionally omitted: coverage repair is recomputed separately,
 * while title/summary, authority, documents, frames, and neighbors invalidate a
 * membership when its actual semantic placement changed.
 */
function macroMembershipNodeInputHash(options: {
  node: ConsolidatedThoughtNode;
  assessment: MacroNodeAssessment;
  nodeById: Map<string, ConsolidatedThoughtNode>;
}): string {
  const compact = compactNode(options.node, options.assessment, options.nodeById, 650);
  const { salience: _salience, id: _id, ...semantic } = compact;
  return hashStableSet({ id: stableNodeIdentity(options.node.id), ...semantic });
}

function macroMembershipCacheKey(options: {
  nodeId: string;
  nodeInputHash: string;
  atlasHash: string;
  model: string | null;
  reasoningEffort: CodexReasoningEffort;
}): string {
  return hashStableSet({
    type: "macro-membership",
    contractVersion: DEFAULTS.contractVersion,
    ...options,
    nodeId: stableNodeIdentity(options.nodeId)
  });
}

function buildAtlasPrompt(options: {
  graph: ConsolidatedThoughtGraph;
  alignment: ThoughtFrameAlignmentArtifact | null;
  assessments: MacroNodeAssessment[];
  representatives: MacroNodeAssessment[];
}): string {
  const nodeById = new Map(options.graph.nodes.map((node) => [node.id, node]));
  const representativeIds = new Set(options.representatives.map((item) => item.nodeId));
  const documentOverview = new Map<string, {
    id: string;
    title: string;
    sourceKind: string;
    nodeIds: Set<string>;
    representativeTitles: string[];
  }>();
  for (const node of options.graph.nodes) {
    for (const ref of node.sourceRefs) {
      const entry = documentOverview.get(ref.documentId) ?? {
        id: ref.documentId,
        title: ref.documentTitle,
        sourceKind: ref.sourceKind,
        nodeIds: new Set<string>(),
        representativeTitles: []
      };
      entry.nodeIds.add(node.id);
      if (representativeIds.has(node.id) && entry.representativeTitles.length < 4) {
        entry.representativeTitles.push(node.title);
      }
      documentOverview.set(ref.documentId, entry);
    }
  }
  const nodes = options.representatives.map((assessment) =>
    compactNode(nodeById.get(assessment.nodeId)!, assessment, nodeById, 450)
  );
  const documents = Array.from(documentOverview.values())
    .map((item) => ({
      id: item.id,
      title: item.title,
      sourceKind: item.sourceKind,
      nodeCount: item.nodeIds.size,
      representativeTitles: item.representativeTitles
    }))
    .sort((left, right) => right.nodeCount - left.nodeCount || left.id.localeCompare(right.id));
  const frameFamilies = (options.alignment?.families ?? []).map((family) => ({
    id: family.id,
    label: family.label,
    documents: family.memberDocumentIds,
    nodeIds: family.memberNodeIds.slice(0, 12)
  }));

  return [
    "Navrhuješ globální atlas osobního myšlení nad velkým již konsolidovaným grafem.",
    "Výstup musí být česky a přesně odpovídat JSON schematu.",
    "Všechny potřebné podklady jsou v tomto promptu. Nepoužívej nástroje, shell, soubory, memory ani web; rovnou vrať pouze výsledný JSON.",
    "",
    "Toto je pouze návrh konstelací. Všechny uzly budou přiřazeny v pozdějších dávkách.",
    `Navrhni ${DEFAULTS.minConstellationCount}-${DEFAULTS.maxConstellationCount} stabilních, vzájemně odlišitelných konstelací.`,
    "Každá konstelace musí mít 3-12 seedNodeIds z reprezentativních uzlů níže.",
    "",
    "PRAVIDLA",
    "- Osnovou jsou autorovy vlastní otázky, teze, revize a opakované linie, ne názvy knih ani objem konverzací.",
    "- Autorské texty mají nejvyšší autoritu. Jeden dlouhý rozhovor nesmí vytvořit většinu atlasu jen počtem uzlů.",
    "- core_direction vyžaduje autorské nebo vícedokumentové ukotvení; active_exploration je soudržné rozvíjené myšlení; supporting_context je technická, čtenářská nebo pomocná mapa.",
    "- Nevytvářej konstelaci pro náhodné provozní, zdravotní, nákupní, programátorské nebo společenské dotazy bez vazby na opakované myšlení.",
    "- Konstelace je navigační rodič, ne nový claim. Zachovej důležité rozdíly a možné vývojové trajektorie.",
    "- key musí být krátký stabilní ASCII-friendly popis; seedNodeIds používej přesně beze změny.",
    "",
    "ROZSAH",
    JSON.stringify({
      sourceNodeCount: options.graph.nodeCount,
      representativeNodeCount: options.representatives.length,
      authoredNodeCount: options.assessments.filter((item) =>
        item.sourceAuthority === "authored" || item.sourceAuthority === "mixed"
      ).length,
      highSalienceNodeCount: options.assessments.filter((item) =>
        item.salienceScore >= DEFAULTS.highSalienceThreshold
      ).length,
      documents,
      frameFamilies,
      representativeNodes: nodes
    })
  ].join("\n");
}

function normalizeExactNodeId(
  nodeId: string,
  validNodeIds: Set<string>,
  validIdsBySuffix: Map<string, string[]>
): string {
  if (validNodeIds.has(nodeId)) return nodeId;
  const suffix = nodeId.split(":").slice(2).join(":");
  const candidates = validIdsBySuffix.get(suffix) ?? [];
  return candidates.length === 1 ? candidates[0]! : nodeId;
}

function buildValidIdsBySuffix(validNodeIds: Set<string>): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const nodeId of validNodeIds) {
    const suffix = nodeId.split(":").slice(2).join(":");
    result.set(suffix, [...(result.get(suffix) ?? []), nodeId]);
  }
  return result;
}

function buildValidIdsByStablePrefix(validNodeIds: Set<string>): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const nodeId of validNodeIds) {
    const stablePrefix = nodeId.split(":").slice(0, 2).join(":");
    result.set(stablePrefix, [...(result.get(stablePrefix) ?? []), nodeId]);
  }
  return result;
}

export function validateAtlasProposal(
  raw: MacroAtlasProposal,
  representativeNodeIds: Set<string>,
  validNodeIds: Set<string>
): MacroAtlasProposal {
  if (
    raw.constellations.length < DEFAULTS.minConstellationCount ||
    raw.constellations.length > DEFAULTS.maxConstellationCount
  ) {
    throw new Error(
      `Atlas must contain ${DEFAULTS.minConstellationCount}-${DEFAULTS.maxConstellationCount} constellations.`
    );
  }
  const validIdsBySuffix = buildValidIdsBySuffix(validNodeIds);
  const validIdsByStablePrefix = buildValidIdsByStablePrefix(validNodeIds);
  const keys = new Set<string>();
  return {
    ...raw,
    constellations: raw.constellations.map((constellation) => {
      if (keys.has(constellation.key)) throw new Error(`Duplicate atlas key ${constellation.key}.`);
      keys.add(constellation.key);
      const seedNodeIds = uniqueSorted(
        constellation.seedNodeIds.map((nodeId) => {
          if (validNodeIds.has(nodeId)) return nodeId;
          const stablePrefix = nodeId.split(":").slice(0, 2).join(":");
          const stableCandidates = validIdsByStablePrefix.get(stablePrefix) ?? [];
          return stableCandidates.length === 1
            ? stableCandidates[0]!
            : normalizeExactNodeId(nodeId, validNodeIds, validIdsBySuffix);
        })
      );
      if (seedNodeIds.length < 3 || seedNodeIds.length > 12) {
        throw new Error(`${constellation.key} must contain 3-12 unique seed nodes.`);
      }
      for (const nodeId of seedNodeIds) {
        if (!representativeNodeIds.has(nodeId)) {
          throw new Error(`${constellation.key} references non-representative seed ${nodeId}.`);
        }
      }
      return { ...constellation, seedNodeIds };
    })
  };
}

/** Apply prose-only curation while keeping keys, evidence, and memberships immutable. */
export function applyAtlasDisplayOverrides(
  atlas: MacroAtlasProposal,
  overrides: MacroAtlasDisplayOverrides
): MacroAtlasProposal {
  const validKeys = new Set(atlas.constellations.map((item) => item.key));
  for (const key of Object.keys(overrides.constellations)) {
    if (!validKeys.has(key)) throw new Error(`Atlas display override references unknown key ${key}.`);
  }
  const requireText = (value: string | undefined, label: string): string | undefined => {
    if (value === undefined) return undefined;
    if (value.trim().length === 0) throw new Error(`${label} must not be empty.`);
    return value;
  };
  return {
    ...atlas,
    atlasTitle: requireText(overrides.atlasTitle, "atlasTitle") ?? atlas.atlasTitle,
    atlasSummary: requireText(overrides.atlasSummary, "atlasSummary") ?? atlas.atlasSummary,
    constellations: atlas.constellations.map((constellation) => {
      const override = overrides.constellations[constellation.key];
      if (!override) return constellation;
      return {
        ...constellation,
        title: requireText(override.title, `${constellation.key}.title`) ?? constellation.title,
        summary: requireText(override.summary, `${constellation.key}.summary`) ?? constellation.summary,
        rationale: requireText(override.rationale, `${constellation.key}.rationale`) ?? constellation.rationale,
        trajectoryHint: requireText(
          override.trajectoryHint,
          `${constellation.key}.trajectoryHint`
        ) ?? constellation.trajectoryHint,
        uncertainty: requireText(
          override.uncertainty,
          `${constellation.key}.uncertainty`
        ) ?? constellation.uncertainty
      };
    })
  };
}

function buildMembershipPrompt(options: {
  batchId: string;
  nodes: ConsolidatedThoughtNode[];
  assessmentById: Map<string, MacroNodeAssessment>;
  nodeById: Map<string, ConsolidatedThoughtNode>;
  atlas: MacroAtlasProposal;
  coverageRepair: boolean;
}): string {
  const constellations = options.atlas.constellations.map((item) => ({
    key: item.key,
    title: item.title,
    summary: item.summary,
    atlasRole: item.atlasRole,
    seedNodeIds: item.seedNodeIds
  }));
  const nodes = options.nodes.map((node) => compactNode(
    node,
    options.assessmentById.get(node.id)!,
    options.nodeById,
    650
  ));
  const coverageInstruction = options.coverageRepair
    ? "Toto je coverage repair pro high-salience nebo autorské uzly. Každý osobní thought node přiřaď alespoň do jedné konstelace; omission použij jen pro skutečně cizí/provozní obsah."
    : "Nenuť každý uzel do mapy. Lokální příklad, náhodný dotaz, cizí fakt nebo slabý detail může zůstat unmapped s přesným omissionReason.";

  return [
    `Přiřaď dávku uzlů do již schváleného makro atlasu. Batch ID je ${options.batchId}.`,
    "Výstup musí být česky a přesně odpovídat JSON schematu.",
    "Všechny potřebné podklady jsou v tomto promptu. Nepoužívej nástroje, shell, soubory, memory ani web; rovnou vrať pouze výsledný JSON.",
    coverageInstruction,
    "",
    "PRAVIDLA",
    `- Vrať právě ${options.nodes.length} items, jednou pro každý node, ve stejném pořadí a s přesným nodeId.`,
    `- Uzel může mít 0-${DEFAULTS.maxMembershipsPerNode} memberships. Překryv použij jen při skutečné odlišné makro funkci.`,
    "- core znamená nosný uzel definující konstelaci; používej střídmě. supporting je argument, důsledek nebo rozvinutí; context je příklad či lokální detail.",
    "- currentPosition označuje nejlepší současnou formulaci, nikoli automaticky nejnovější datum.",
    "- openQuestion a tension jsou významové facety, ne pouhé kopie nodeType bez vztahu ke konstelaci.",
    "- Pokud memberships není prázdné, omissionReason musí být mapped. Pokud je prázdné, omissionReason nesmí být mapped.",
    "- Používej pouze constellationKey z atlasu.",
    "",
    "ATLAS",
    JSON.stringify({ constellations }),
    "",
    "NODES",
    JSON.stringify({ batchId: options.batchId, nodes })
  ].join("\n");
}

export function validateMembershipBatch(options: {
  raw: MacroMembershipBatchOutput;
  batchId: string;
  expectedNodeIds: string[];
  constellationKeys: Set<string>;
}): MacroMembershipBatchOutput {
  if (options.raw.batchId !== options.batchId) {
    throw new Error(`Membership batch returned ${options.raw.batchId}; expected ${options.batchId}.`);
  }
  if (options.raw.items.length !== options.expectedNodeIds.length) {
    throw new Error(
      `${options.batchId} returned ${options.raw.items.length} items for ${options.expectedNodeIds.length} nodes.`
    );
  }
  const expectedByStablePrefix = new Map<string, string[]>();
  for (const nodeId of options.expectedNodeIds) {
    const stablePrefix = nodeId.split(":").slice(0, 2).join(":");
    expectedByStablePrefix.set(stablePrefix, [
      ...(expectedByStablePrefix.get(stablePrefix) ?? []),
      nodeId
    ]);
  }
  const normalizedItems = options.raw.items.map((item) => {
    if (options.expectedNodeIds.includes(item.nodeId)) return item;
    const stablePrefix = item.nodeId.split(":").slice(0, 2).join(":");
    const candidates = expectedByStablePrefix.get(stablePrefix) ?? [];
    return candidates.length === 1 ? { ...item, nodeId: candidates[0]! } : item;
  });
  const itemByNodeId = new Map(normalizedItems.map((item) => [item.nodeId, item]));
  if (itemByNodeId.size !== normalizedItems.length) {
    throw new Error(`${options.batchId} contains duplicate node ids.`);
  }
  const items = options.expectedNodeIds.map((nodeId) => {
    const item = itemByNodeId.get(nodeId);
    if (!item) throw new Error(`${options.batchId} is missing node ${nodeId}.`);
    if (item.memberships.length > DEFAULTS.maxMembershipsPerNode) {
      throw new Error(`${options.batchId}/${nodeId} exceeds membership limit.`);
    }
    const keys = item.memberships.map((membership) => membership.constellationKey);
    if (new Set(keys).size !== keys.length) {
      throw new Error(`${options.batchId}/${nodeId} repeats a constellation.`);
    }
    for (const key of keys) {
      if (!options.constellationKeys.has(key)) {
        throw new Error(`${options.batchId}/${nodeId} references unknown constellation ${key}.`);
      }
    }
    if (item.memberships.length > 0 && item.omissionReason !== "mapped") {
      throw new Error(`${options.batchId}/${nodeId} is mapped but has omission ${item.omissionReason}.`);
    }
    if (item.memberships.length === 0 && item.omissionReason === "mapped") {
      throw new Error(`${options.batchId}/${nodeId} is unmapped but has omissionReason=mapped.`);
    }
    return item;
  });
  return { batchId: options.batchId, items };
}

function membershipSort(
  left: ConsolidatedThoughtNode,
  right: ConsolidatedThoughtNode
): number {
  const leftDocument = nodeDocumentIds(left)[0] ?? "~";
  const rightDocument = nodeDocumentIds(right)[0] ?? "~";
  const documentDelta = leftDocument.localeCompare(rightDocument);
  if (documentDelta !== 0) return documentDelta;
  const dateDelta = (left.firstSeen ?? "9999").localeCompare(right.firstSeen ?? "9999");
  return dateDelta !== 0 ? dateDelta : left.id.localeCompare(right.id);
}

function buildMembershipBatches(nodes: ConsolidatedThoughtNode[], batchSize: number): ConsolidatedThoughtNode[][] {
  const ordered = nodes.slice().sort(membershipSort);
  const batches: ConsolidatedThoughtNode[][] = [];
  for (let index = 0; index < ordered.length; index += batchSize) {
    batches.push(ordered.slice(index, index + batchSize));
  }
  return batches;
}

function membershipBatchId(prefix: "membership" | "coverage", index: number): string {
  return `${prefix}-batch-${String(index + 1).padStart(4, "0")}`;
}

function statePath(runDir: string): string {
  return path.join(runDir, "run.json");
}

function membershipCachePath(targetStateDir: string): string {
  return path.join(targetStateDir, DEFAULTS.stateDirname, "membership_cache.json");
}

function loadMembershipCache(targetStateDir: string): MacroMembershipCache {
  const target = membershipCachePath(targetStateDir);
  if (!existsSync(target)) {
    return { version: 1, generatedAt: new Date(0).toISOString(), entries: {} };
  }
  const parsed = readJson<MacroMembershipCache>(target);
  return parsed.version === 1 && parsed.entries
    ? parsed
    : { version: 1, generatedAt: new Date(0).toISOString(), entries: {} };
}

function writeMembershipCache(targetStateDir: string, cache: MacroMembershipCache): void {
  cache.generatedAt = new Date().toISOString();
  writeJson(membershipCachePath(targetStateDir), cache);
}

function upsertMembershipCacheItems(options: {
  cache: MacroMembershipCache;
  items: MacroMembershipItem[];
  nodeById: Map<string, ConsolidatedThoughtNode>;
  assessmentById: Map<string, MacroNodeAssessment>;
  atlasHash: string;
  model: string | null;
  reasoningEffort: CodexReasoningEffort;
  sourceRunId: string;
  overwrite?: boolean;
}): number {
  let written = 0;
  const now = new Date().toISOString();
  for (const item of options.items) {
    const node = options.nodeById.get(item.nodeId);
    const assessment = options.assessmentById.get(item.nodeId);
    if (!node || !assessment) continue;
    const nodeInputHash = macroMembershipNodeInputHash({
      node,
      assessment,
      nodeById: options.nodeById
    });
    const cacheKey = macroMembershipCacheKey({
      nodeId: item.nodeId,
      nodeInputHash,
      atlasHash: options.atlasHash,
      model: options.model,
      reasoningEffort: options.reasoningEffort
    });
    const existing = options.cache.entries[cacheKey];
    if (!options.overwrite && existing) continue;
    // Coverage batches may intentionally replace an earlier membership item,
    // but repeating master must not rewrite/count an identical repair forever.
    if (existing && JSON.stringify(existing.item) === JSON.stringify(item)) continue;
    options.cache.entries[cacheKey] = {
      cacheKey,
      nodeId: item.nodeId,
      nodeInputHash,
      atlasHash: options.atlasHash,
      contractVersion: DEFAULTS.contractVersion,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      item,
      sourceRunId: options.sourceRunId,
      updatedAt: now
    };
    written += 1;
  }
  return written;
}

function cachedMembershipForNode(options: {
  cache: MacroMembershipCache;
  node: ConsolidatedThoughtNode;
  assessment: MacroNodeAssessment;
  nodeById: Map<string, ConsolidatedThoughtNode>;
  atlasHash: string;
  model: string | null;
  reasoningEffort: CodexReasoningEffort;
}): MacroMembershipItem | null {
  const nodeInputHash = macroMembershipNodeInputHash(options);
  const cacheKey = macroMembershipCacheKey({
    nodeId: options.node.id,
    nodeInputHash,
    atlasHash: options.atlasHash,
    model: options.model,
    reasoningEffort: options.reasoningEffort
  });
  const cached = options.cache.entries[cacheKey]?.item;
  return cached ? { ...cached, nodeId: options.node.id } : null;
}

function writeRunState(runDir: string, state: ScaledMacroMapRunState): void {
  state.updatedAt = new Date().toISOString();
  writeJson(statePath(runDir), state);
}

function isCompatibleRun(state: ScaledMacroMapRunState, expected: {
  graphHash: string;
  alignmentHash: string | null;
  graphSemanticHash: string;
  alignmentSemanticHash: string | null;
  model: string | null;
  reasoningEffort: CodexReasoningEffort;
  sourceOutputDir: string;
  targetOutputDir: string;
  membershipBatchSize: number;
}): boolean {
  const graphMatches = state.sourceGraphSemanticHash
    ? state.sourceGraphSemanticHash === expected.graphSemanticHash
    : state.sourceGraphHash === expected.graphHash;
  const alignmentMatches = state.sourceAlignmentSemanticHash !== undefined
    ? state.sourceAlignmentSemanticHash === expected.alignmentSemanticHash
    : state.sourceAlignmentHash === expected.alignmentHash;
  return state.contractVersion === DEFAULTS.contractVersion &&
    graphMatches &&
    alignmentMatches &&
    state.model === expected.model &&
    state.reasoningEffort === expected.reasoningEffort &&
    state.membershipBatchSize === expected.membershipBatchSize;
}

function findCompatibleRun(runsDir: string, expected: Parameters<typeof isCompatibleRun>[1]): {
  runDir: string;
  state: ScaledMacroMapRunState;
} | null {
  if (!existsSync(runsDir)) return null;
  const candidates = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDir, entry.name))
    .filter((runDir) => existsSync(statePath(runDir)))
    .map((runDir) => ({ runDir, state: readJson<ScaledMacroMapRunState>(statePath(runDir)) }))
    .filter(({ state }) => isCompatibleRun(state, expected))
    .sort((left, right) => right.state.updatedAt.localeCompare(left.state.updatedAt));
  return candidates[0] ?? null;
}

function findReplayableCompletedRun(
  runsDir: string,
  expected: Parameters<typeof isCompatibleRun>[1]
): { runDir: string; state: ScaledMacroMapRunState } | null {
  if (!existsSync(runsDir)) return null;
  const candidates = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDir, entry.name))
    .filter((runDir) => existsSync(statePath(runDir)))
    .map((runDir) => ({ runDir, state: readJson<ScaledMacroMapRunState>(statePath(runDir)) }))
    .filter(({ state }) =>
      state.status === "completed" &&
      state.sourceGraphHash === expected.graphHash &&
      state.sourceAlignmentHash === expected.alignmentHash &&
      state.model === expected.model &&
      state.reasoningEffort === expected.reasoningEffort &&
      state.membershipBatchSize === expected.membershipBatchSize
    )
    .sort((left, right) => right.state.updatedAt.localeCompare(left.state.updatedAt));
  return candidates[0] ?? null;
}

function listMacroRuns(runsDir: string): Array<{
  runDir: string;
  state: ScaledMacroMapRunState;
}> {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDir, entry.name))
    .filter((runDir) => existsSync(statePath(runDir)))
    .map((runDir) => ({ runDir, state: readJson<ScaledMacroMapRunState>(statePath(runDir)) }))
    .sort((left, right) => right.state.updatedAt.localeCompare(left.state.updatedAt));
}

function migrateLegacyMembershipBatches(options: {
  runsDir: string;
  graphHash: string;
  graphSemanticHash: string;
  nodeById: Map<string, ConsolidatedThoughtNode>;
  assessmentById: Map<string, MacroNodeAssessment>;
  model: string | null;
  reasoningEffort: CodexReasoningEffort;
  cache: MacroMembershipCache;
}): number {
  let migrated = 0;
  for (const { runDir, state } of listMacroRuns(options.runsDir)) {
    const sameSource = state.sourceGraphHash === options.graphHash ||
      state.sourceGraphSemanticHash === options.graphSemanticHash;
    if (
      !sameSource ||
      state.contractVersion !== DEFAULTS.contractVersion ||
      state.model !== options.model ||
      state.reasoningEffort !== options.reasoningEffort
    ) {
      continue;
    }
    const atlasPath = path.join(runDir, "atlas.json");
    if (!existsSync(atlasPath)) continue;
    const atlas = readJson<MacroAtlasProposal>(atlasPath);
    const atlasHash = macroAtlasHash(atlas);
    const constellationKeys = new Set(atlas.constellations.map((item) => item.key));

    const migrateDir = (dirname: "membership" | "coverage", overwrite: boolean): void => {
      const sourceDir = path.join(runDir, dirname);
      if (!existsSync(sourceDir)) return;
      const files = readdirSync(sourceDir)
        .filter((filename) => new RegExp(`^${dirname}-batch-\\d{4}\\.json$`).test(filename))
        .sort((left, right) => left.localeCompare(right));
      for (const filename of files) {
        const raw = readJson<MacroMembershipBatchOutput>(path.join(sourceDir, filename));
        for (const rawItem of raw.items) {
          if (!options.nodeById.has(rawItem.nodeId)) continue;
          try {
            const validated = validateMembershipBatch({
              raw: { batchId: "migration", items: [rawItem] },
              batchId: "migration",
              expectedNodeIds: [rawItem.nodeId],
              constellationKeys
            });
            migrated += upsertMembershipCacheItems({
              cache: options.cache,
              items: validated.items,
              nodeById: options.nodeById,
              assessmentById: options.assessmentById,
              atlasHash,
              model: options.model,
              reasoningEffort: options.reasoningEffort,
              sourceRunId: state.runId,
              overwrite
            });
          } catch {
            // Legacy raw evidence remains on disk; only validated compatible
            // items are promoted into the durable item cache.
          }
        }
      }
    };

    migrateDir("membership", false);
    migrateDir("coverage", true);
  }
  return migrated;
}

/**
 * Promote exact-source legacy membership batches before an upstream phase can
 * replace the currently accepted graph. This is intentionally cache-only: it
 * never proposes an atlas, classifies a node, or rewrites the macro artifact.
 */
export function prepareScaledMacroMapIncrementalReuse(
  options: PrepareScaledMacroMapReuseOptions
): number {
  const sourceOutputDir = resolveRepoPath(
    options.paths.root,
    options.sourceOutputDir,
    options.paths.outputDir
  );
  const targetOutputDir = resolveRepoPath(
    options.paths.root,
    options.targetOutputDir,
    options.paths.outputDir
  );
  const graphPath = path.join(
    sourceOutputDir,
    "compiled",
    SECOND_BRAIN_DEFAULTS.thoughtConsolidation.compiledGraphFilename
  );
  if (!existsSync(graphPath)) return 0;

  const graphText = readFileSync(graphPath, "utf8");
  const graph = JSON.parse(graphText) as ConsolidatedThoughtGraph;
  const graphHash = hashText(graphText);
  const graphSemanticHash = computeConsolidatedGraphSemanticHash(graph);
  const assessments = assessMacroNodes(graph);
  const assessmentById = new Map(assessments.map((item) => [item.nodeId, item]));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const targetStateDir = path.join(targetOutputDir, "state");
  const runsDir = path.join(targetStateDir, DEFAULTS.stateDirname, "runs");
  const membershipCache = loadMembershipCache(targetStateDir);
  const migrated = migrateLegacyMembershipBatches({
    runsDir,
    graphHash,
    graphSemanticHash,
    nodeById,
    assessmentById,
    model: options.model ?? null,
    reasoningEffort: options.reasoningEffort,
    cache: membershipCache
  });
  if (migrated > 0) {
    writeMembershipCache(targetStateDir, membershipCache);
    new ThrottledProgressReporter(options.progress).phase(
      "macro:membership",
      `prepared ${migrated} validated legacy items for incremental reuse`
    );
  }
  return migrated;
}

function findReusableAtlasRun(options: {
  runsDir: string;
  currentNodeIds: Set<string>;
  cache: MacroMembershipCache;
  model: string | null;
  reasoningEffort: CodexReasoningEffort;
  sourceOutputDir: string;
  targetOutputDir: string;
}): ReusableAtlasRun | null {
  for (const candidate of listMacroRuns(options.runsDir)) {
    const { state, runDir } = candidate;
    if (
      !state.atlasCompleted ||
      state.contractVersion !== DEFAULTS.contractVersion ||
      state.model !== options.model ||
      state.reasoningEffort !== options.reasoningEffort
    ) {
      continue;
    }
    const atlasPath = path.join(runDir, "atlas.json");
    if (!existsSync(atlasPath)) continue;
    const savedAtlas = readJson<MacroAtlasProposal>(atlasPath);
    const currentIdsByStableIdentity = new Map<string, string[]>();
    for (const nodeId of options.currentNodeIds) {
      const stableId = stableNodeIdentity(nodeId);
      currentIdsByStableIdentity.set(stableId, [
        ...(currentIdsByStableIdentity.get(stableId) ?? []),
        nodeId
      ]);
    }
    let unresolvedSeed = false;
    const atlas: MacroAtlasProposal = {
      ...savedAtlas,
      constellations: savedAtlas.constellations.map((constellation) => ({
        ...constellation,
        seedNodeIds: constellation.seedNodeIds.map((nodeId) => {
          if (options.currentNodeIds.has(nodeId)) return nodeId;
          const candidates = currentIdsByStableIdentity.get(stableNodeIdentity(nodeId)) ?? [];
          if (candidates.length === 1) return candidates[0]!;
          unresolvedSeed = true;
          return nodeId;
        })
      }))
    };
    if (unresolvedSeed) continue;
    const atlasHash = macroAtlasHash(atlas);
    const previousNodeIds = new Set(
      Object.values(options.cache.entries)
        .filter((entry) => entry.atlasHash === atlasHash)
        .map((entry) => stableNodeIdentity(entry.nodeId))
    );
    if (previousNodeIds.size === 0) continue;
    const overlapCount = Array.from(options.currentNodeIds).filter((nodeId) =>
      previousNodeIds.has(stableNodeIdentity(nodeId))
    ).length;
    const topologyDriftShare = 1 - overlapCount /
      Math.max(1, options.currentNodeIds.size, previousNodeIds.size);
    return { runDir, state, atlas, atlasHash, topologyDriftShare };
  }
  return null;
}

function createRunState(options: {
  runId: string;
  iterationLabel: string;
  model: string | null;
  reasoningEffort: CodexReasoningEffort;
  sourceOutputDir: string;
  targetOutputDir: string;
  graphHash: string;
  alignmentHash: string | null;
  graphSemanticHash: string;
  alignmentSemanticHash: string | null;
  membershipBatchSize: number;
}): ScaledMacroMapRunState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    contractVersion: DEFAULTS.contractVersion,
    runId: options.runId,
    createdAt: now,
    updatedAt: now,
    status: "in_progress",
    iterationLabel: options.iterationLabel,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    sourceOutputDir: options.sourceOutputDir,
    targetOutputDir: options.targetOutputDir,
    sourceGraphHash: options.graphHash,
    sourceAlignmentHash: options.alignmentHash,
    sourceGraphSemanticHash: options.graphSemanticHash,
    sourceAlignmentSemanticHash: options.alignmentSemanticHash,
    atlasHash: null,
    trajectoryInputHash: null,
    reusedMembershipItemCount: 0,
    generatedMembershipItemCount: 0,
    atlasReused: false,
    trajectoryReused: false,
    membershipBatchSize: options.membershipBatchSize,
    atlasCompleted: false,
    membershipBatchCount: 0,
    completedMembershipBatchIds: [],
    coverageBatchCount: 0,
    completedCoverageBatchIds: [],
    trajectoryCompleted: false,
    failureMessage: null
  };
}

function mergeMembershipItems(
  initial: MacroMembershipItem[],
  replacements: MacroMembershipItem[]
): MacroMembershipItem[] {
  const byNodeId = new Map(initial.map((item) => [item.nodeId, item]));
  replacements.forEach((item) => byNodeId.set(item.nodeId, item));
  return Array.from(byNodeId.values());
}

export function validateSavedCoverageSubset(options: {
  raw: MacroMembershipBatchOutput;
  batchId: string;
  expectedNodeIds: string[];
  constellationKeys: Set<string>;
}): MacroMembershipBatchOutput {
  const expected = new Set(options.expectedNodeIds);
  return validateMembershipBatch({
    ...options,
    raw: {
      batchId: options.raw.batchId,
      items: options.raw.items.filter((item) => expected.has(item.nodeId))
    }
  });
}

export function acceptedHighSalienceOmissions(options: {
  memberships: MacroMembershipItem[];
  assessments: MacroNodeAssessment[];
}): string[] {
  const assessmentById = new Map(options.assessments.map((item) => [item.nodeId, item]));
  return uniqueSorted(options.memberships
    .filter((item) => {
      const assessment = assessmentById.get(item.nodeId);
      return Boolean(
        assessment &&
        assessment.salienceScore >= DEFAULTS.highSalienceThreshold &&
        !requiresMacroMapCoverage(assessment) &&
        item.memberships.length === 0 &&
        item.omissionReason !== "mapped"
      );
    })
    .map((item) => item.nodeId));
}

export function maxAllowedConstellationMembers(graphNodeCount: number): number {
  return Math.max(
    DEFAULTS.maxConstellationMemberCount,
    Math.ceil(graphNodeCount * DEFAULTS.maxConstellationMemberShare)
  );
}

function assembleMacroMapProposal(options: {
  atlas: MacroAtlasProposal;
  memberships: MacroMembershipItem[];
  graph: ConsolidatedThoughtGraph;
  assessments: MacroNodeAssessment[];
}): MacroMapProposal {
  const assessmentById = new Map(options.assessments.map((item) => [item.nodeId, item]));
  const nodeById = new Map(options.graph.nodes.map((node) => [node.id, node]));
  const membershipByConstellation = new Map<string, Map<string, MacroMembership>>();
  for (const constellation of options.atlas.constellations) {
    const members = new Map<string, MacroMembership>();
    constellation.seedNodeIds.forEach((nodeId) => members.set(nodeId, {
      constellationKey: constellation.key,
      role: "core",
      currentPosition: false,
      openQuestion: nodeById.get(nodeId)?.nodeType === "question",
      tension: nodeById.get(nodeId)?.nodeType === "tension"
    }));
    membershipByConstellation.set(constellation.key, members);
  }
  const rolePriority: Record<MacroNodeRole, number> = { core: 0, supporting: 1, context: 2 };
  const maxConstellationMembers = maxAllowedConstellationMembers(options.graph.nodeCount);
  for (const item of options.memberships) {
    for (const membership of item.memberships) {
      const members = membershipByConstellation.get(membership.constellationKey)!;
      const existing = members.get(item.nodeId);
      if (!existing || rolePriority[membership.role] < rolePriority[existing.role]) {
        members.set(item.nodeId, membership);
      } else {
        existing.currentPosition ||= membership.currentPosition;
        existing.openQuestion ||= membership.openQuestion;
        existing.tension ||= membership.tension;
      }
    }
  }

  return {
    atlasTitle: options.atlas.atlasTitle,
    atlasSummary: options.atlas.atlasSummary,
    constellations: options.atlas.constellations.map((constellation) => {
      const members = Array.from(membershipByConstellation.get(constellation.key)!.entries());
      if (members.length > maxConstellationMembers) {
        throw new Error(
          `${constellation.key} has ${members.length} members; maximum is ${maxConstellationMembers} ` +
          `for a ${options.graph.nodeCount}-node graph.`
        );
      }
      const seedIds = new Set(constellation.seedNodeIds);
      const ranked = members.slice().sort((left, right) => {
        const leftSeed = seedIds.has(left[0]) ? 1 : 0;
        const rightSeed = seedIds.has(right[0]) ? 1 : 0;
        if (leftSeed !== rightSeed) return rightSeed - leftSeed;
        return (assessmentById.get(right[0])?.salienceScore ?? 0) -
          (assessmentById.get(left[0])?.salienceScore ?? 0) || left[0].localeCompare(right[0]);
      });
      const coreIds = new Set(
        ranked
          .filter(([, membership]) => membership.role === "core")
          .slice(0, DEFAULTS.maxCoreMembersPerConstellation)
          .map(([nodeId]) => nodeId)
      );
      const currentIds = new Set(
        ranked
          .filter(([, membership]) => membership.currentPosition)
          .slice(0, DEFAULTS.maxCurrentPositionsPerConstellation)
          .map(([nodeId]) => nodeId)
      );
      const memberNodeIds = uniqueSorted(members.map(([nodeId]) => nodeId));
      const supportingNodeIds = uniqueSorted(members
        .filter(([nodeId, membership]) => !coreIds.has(nodeId) && membership.role !== "context")
        .map(([nodeId]) => nodeId));
      const contextNodeIds = uniqueSorted(members
        .filter(([nodeId, membership]) => !coreIds.has(nodeId) && membership.role === "context")
        .map(([nodeId]) => nodeId));
      return {
        key: constellation.key,
        title: constellation.title,
        summary: constellation.summary,
        rationale: constellation.rationale,
        trajectoryHint: constellation.trajectoryHint,
        atlasRole: constellation.atlasRole,
        confidence: constellation.confidence,
        uncertainty: constellation.uncertainty,
        memberNodeIds,
        coreNodeIds: uniqueSorted(coreIds),
        supportingNodeIds,
        contextNodeIds,
        currentPositionNodeIds: uniqueSorted(currentIds),
        openQuestionNodeIds: uniqueSorted(members
          .filter(([, membership]) => membership.openQuestion)
          .map(([nodeId]) => nodeId)),
        tensionNodeIds: uniqueSorted(members
          .filter(([, membership]) => membership.tension)
          .map(([nodeId]) => nodeId))
      };
    })
  };
}

function artifactSummary(options: {
  artifact: ThoughtMacroMapArtifact;
  state: ScaledMacroMapRunState;
  representatives: MacroNodeAssessment[];
  artifactPath: string;
  reportPath: string;
  runDir: string;
}): ScaledThoughtMacroMapSummary {
  return {
    status: options.state.status,
    runId: options.state.runId,
    sourceNodeCount: options.artifact.sourceNodeCount,
    representativeNodeCount: options.representatives.length,
    membershipBatchCount: options.state.membershipBatchCount,
    completedMembershipBatchCount: options.state.completedMembershipBatchIds.length,
    coverageBatchCount: options.state.coverageBatchCount,
    atlasReused: options.state.atlasReused ?? false,
    reusedMembershipItemCount: options.state.reusedMembershipItemCount ?? 0,
    generatedMembershipItemCount: options.state.generatedMembershipItemCount ?? 0,
    trajectoryReused: options.state.trajectoryReused ?? false,
    constellationCount: options.artifact.quality.constellationCount,
    trajectoryCount: options.artifact.quality.trajectoryCount,
    mappedNodeCount: options.artifact.quality.mappedNodeCount,
    mappedNodeShare: options.artifact.quality.mappedNodeShare,
    mappedHighSalienceShare: options.artifact.quality.mappedHighSalienceShare,
    mappedAuthoredShare: options.artifact.quality.mappedAuthoredShare,
    warningCount: options.artifact.quality.warnings.length,
    artifactPath: options.artifactPath,
    reportPath: options.reportPath,
    runDir: options.runDir
  };
}

function pausedSummary(options: {
  graph: ConsolidatedThoughtGraph;
  state: ScaledMacroMapRunState;
  representatives: MacroNodeAssessment[];
  runDir: string;
  targetOutputDir: string;
}): ScaledThoughtMacroMapSummary {
  return {
    status: options.state.status,
    runId: options.state.runId,
    sourceNodeCount: options.graph.nodeCount,
    representativeNodeCount: options.representatives.length,
    membershipBatchCount: options.state.membershipBatchCount,
    completedMembershipBatchCount: options.state.completedMembershipBatchIds.length,
    coverageBatchCount: options.state.coverageBatchCount,
    atlasReused: options.state.atlasReused ?? false,
    reusedMembershipItemCount: options.state.reusedMembershipItemCount ?? 0,
    generatedMembershipItemCount: options.state.generatedMembershipItemCount ?? 0,
    trajectoryReused: options.state.trajectoryReused ?? false,
    constellationCount: 0,
    trajectoryCount: 0,
    mappedNodeCount: 0,
    mappedNodeShare: 0,
    mappedHighSalienceShare: 0,
    mappedAuthoredShare: 0,
    warningCount: 0,
    artifactPath: path.join(options.targetOutputDir, "compiled", DEFAULTS.compiledArtifactFilename),
    reportPath: path.join(options.targetOutputDir, "state", "audits", DEFAULTS.markdownReportFilename),
    runDir: options.runDir
  };
}

export function buildScaledThoughtMacroMap(options: ScaledMacroMapOptions): ScaledThoughtMacroMapSummary {
  const sourceOutputDir = resolveRepoPath(
    options.paths.root,
    options.sourceOutputDir,
    options.paths.outputDir
  );
  const targetOutputDir = resolveRepoPath(
    options.paths.root,
    options.targetOutputDir,
    options.paths.outputDir
  );
  const sourceCompiledDir = path.join(sourceOutputDir, "compiled");
  const targetCompiledDir = path.join(targetOutputDir, "compiled");
  const targetStateDir = path.join(targetOutputDir, "state");
  const targetAuditsDir = path.join(targetStateDir, "audits");
  const runsDir = path.join(targetStateDir, DEFAULTS.stateDirname, "runs");
  const graphPath = path.join(
    sourceCompiledDir,
    SECOND_BRAIN_DEFAULTS.thoughtConsolidation.compiledGraphFilename
  );
  const alignmentPath = path.join(
    sourceCompiledDir,
    SECOND_BRAIN_DEFAULTS.thoughtFrameAlignment.compiledArtifactFilename
  );
  if (!existsSync(graphPath)) throw new Error(`Missing consolidated graph at ${graphPath}.`);
  const graphText = readFileSync(graphPath, "utf8");
  const graph = JSON.parse(graphText) as ConsolidatedThoughtGraph;
  const alignmentText = existsSync(alignmentPath) ? readFileSync(alignmentPath, "utf8") : null;
  const alignment = alignmentText ? JSON.parse(alignmentText) as ThoughtFrameAlignmentArtifact : null;
  const graphHash = hashText(graphText);
  const alignmentHash = alignmentText ? hashText(alignmentText) : null;
  const graphSemanticHash = computeConsolidatedGraphSemanticHash(graph);
  const alignmentSemanticHash = computeFrameAlignmentSemanticHash(alignment);
  const model = options.model ?? null;
  const membershipBatchSize = options.membershipBatchSize ?? DEFAULTS.membershipBatchSize;
  if (!Number.isInteger(membershipBatchSize) || membershipBatchSize < 1) {
    throw new Error("membershipBatchSize must be a positive integer.");
  }
  const progress = new ThrottledProgressReporter(options.progress);
  const assessments = assessMacroNodes(graph);
  const assessmentById = new Map(assessments.map((item) => [item.nodeId, item]));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const representatives = selectMacroAtlasRepresentatives({ graph, assessments });
  const membershipCache = loadMembershipCache(targetStateDir);
  const migratedMembershipCount = options.forceNewRun
    ? 0
    : migrateLegacyMembershipBatches({
        runsDir,
        graphHash,
        graphSemanticHash,
        nodeById,
        assessmentById,
        model,
        reasoningEffort: options.reasoningEffort,
        cache: membershipCache
      });
  if (migratedMembershipCount > 0) {
    writeMembershipCache(targetStateDir, membershipCache);
    progress.phase(
      "macro:membership",
      `migrated ${migratedMembershipCount} validated legacy items into the item cache`
    );
  }
  const expectedRun = {
    graphHash,
    alignmentHash,
    graphSemanticHash,
    alignmentSemanticHash,
    model,
    reasoningEffort: options.reasoningEffort,
    sourceOutputDir,
    targetOutputDir,
    membershipBatchSize
  };
  const compatible = options.replayCompleted
    ? findReplayableCompletedRun(runsDir, expectedRun)
    : options.forceNewRun
      ? null
      : findCompatibleRun(runsDir, expectedRun);
  if (options.replayCompleted && !compatible) {
    throw new Error("No completed macro-map run matches the requested source, model, and target.");
  }
  const runId = compatible?.state.runId ??
    `macro-map-${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(options.iterationLabel) || "run"}`;
  const runDir = compatible?.runDir ?? path.join(runsDir, runId);
  const reusableAtlas = options.forceNewRun || options.replayCompleted || compatible?.state.atlasCompleted
    ? null
    : findReusableAtlasRun({
        runsDir,
        currentNodeIds: new Set(graph.nodes.map((node) => node.id)),
        cache: membershipCache,
        model,
        reasoningEffort: options.reasoningEffort,
        sourceOutputDir,
        targetOutputDir
      });
  const state = compatible?.state ?? createRunState({
    runId,
    iterationLabel: options.iterationLabel,
    model,
    reasoningEffort: options.reasoningEffort,
    sourceOutputDir,
    targetOutputDir,
    graphHash,
    alignmentHash,
    graphSemanticHash,
    alignmentSemanticHash,
    membershipBatchSize
  });
  const stateWasLegacy = state.schemaVersion === 1;
  state.schemaVersion = 2;
  state.sourceGraphHash = graphHash;
  state.sourceAlignmentHash = alignmentHash;
  state.sourceGraphSemanticHash = graphSemanticHash;
  state.sourceAlignmentSemanticHash = alignmentSemanticHash;
  mkdirSync(runDir, { recursive: true });
  if (!options.replayCompleted) writeRunState(runDir, state);

  const artifactPath = path.join(targetCompiledDir, DEFAULTS.compiledArtifactFilename);
  const reportPath = path.join(targetAuditsDir, DEFAULTS.markdownReportFilename);
  if (state.status === "completed" && existsSync(artifactPath) && !options.replayCompleted) {
    const completedArtifact = readJson<ThoughtMacroMapArtifact>(artifactPath);
    completedArtifact.sourceConsolidatedGraphHash = graphHash;
    completedArtifact.sourceConsolidatedGraphSemanticHash = graphSemanticHash;
    completedArtifact.sourceFrameAlignmentHash = alignmentHash;
    completedArtifact.sourceFrameAlignmentSemanticHash = alignmentSemanticHash;
    state.atlasHash = existsSync(path.join(runDir, "atlas.json"))
      ? macroAtlasHash(readJson<MacroAtlasProposal>(path.join(runDir, "atlas.json")))
      : state.atlasHash ?? null;
    state.reusedMembershipItemCount = graph.nodeCount;
    state.generatedMembershipItemCount = 0;
    state.atlasReused = true;
    state.trajectoryReused = true;
    writeJson(artifactPath, completedArtifact);
    writeJson(path.join(runDir, "artifact.json"), completedArtifact);
    writeFileSync(reportPath, buildMacroMapReport(completedArtifact), "utf8");
    writeRunState(runDir, state);
    return artifactSummary({
      artifact: completedArtifact,
      state,
      representatives,
      artifactPath,
      reportPath,
      runDir
    });
  }

  const replayingCompletedRun = Boolean(options.replayCompleted && state.status === "completed");
  if (!replayingCompletedRun) {
    state.status = "in_progress";
    state.failureMessage = null;
    writeRunState(runDir, state);
  }
  const workerDir = mkdtempSync(path.join(os.tmpdir(), "second-brain-macro-map-worker-"));
  const validNodeIds = new Set(graph.nodes.map((node) => node.id));
  const representativeNodeIds = new Set(representatives.map((item) => item.nodeId));
  const atlasSchemaPath = writeJson(path.join(runDir, "atlas.schema.json"), ATLAS_SCHEMA);
  const membershipSchemaPath = writeJson(
    path.join(runDir, "membership.schema.json"),
    MEMBERSHIP_SCHEMA
  );
  const trajectorySchemaPath = writeJson(
    path.join(runDir, "trajectories.schema.json"),
    TRAJECTORY_SCHEMA
  );
  const semanticClient = (): Pick<CodexCliClient, "execSemanticBatch"> => {
    if (!options.client) {
      throw new Error("Completed replay is missing a required checkpoint; semantic calls are disabled.");
    }
    return options.client;
  };

  try {
    let atlas: MacroAtlasProposal;
    const atlasPath = path.join(runDir, "atlas.json");
    if (state.atlasCompleted && existsSync(atlasPath)) {
      const savedAtlas = readJson<MacroAtlasProposal>(atlasPath);
      const savedRepresentativeIds = new Set([
        ...representativeNodeIds,
        ...savedAtlas.constellations.flatMap((item) => item.seedNodeIds)
      ]);
      atlas = validateAtlasProposal(savedAtlas, savedRepresentativeIds, validNodeIds);
      progress.phase("macro:atlas", `reusing completed atlas with ${atlas.constellations.length} constellations`);
      state.atlasReused = true;
    } else if (reusableAtlas) {
      const reusableRepresentativeIds = new Set([
        ...representativeNodeIds,
        ...reusableAtlas.atlas.constellations.flatMap((item) => item.seedNodeIds)
      ]);
      atlas = validateAtlasProposal(
        reusableAtlas.atlas,
        reusableRepresentativeIds,
        validNodeIds
      );
      writeJson(atlasPath, atlas);
      state.atlasCompleted = true;
      state.atlasReused = true;
      state.atlasHash = reusableAtlas.atlasHash;
      writeRunState(runDir, state);
      progress.phase(
        "macro:atlas",
        `reusing atlas across ${(reusableAtlas.topologyDriftShare * 100).toFixed(2)}% topology drift`
      );
    } else {
      progress.phase("macro:atlas", `proposing atlas from ${representatives.length}/${graph.nodeCount} representative nodes`);
      const atlasPrompt = buildAtlasPrompt({ graph, alignment, assessments, representatives });
      writeFileSync(path.join(runDir, "atlas-prompt.txt"), `${atlasPrompt}\n`, "utf8");
      atlas = executeValidatedSemanticBatch<MacroAtlasProposal>({
        client: semanticClient(),
        prompt: atlasPrompt,
        outputSchemaPath: atlasSchemaPath,
        workingDir: workerDir,
        targetOutputDir,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        rawPath: path.join(runDir, "atlas.raw.json"),
        validate: (raw) => validateAtlasProposal(raw, representativeNodeIds, validNodeIds),
        onRetry: (message) => progress.phase("macro:atlas", `retrying atlas after ${message}`)
      });
      writeJson(atlasPath, atlas);
      state.atlasCompleted = true;
      state.atlasReused = false;
      writeRunState(runDir, state);
    }
    const displayOverridesPath = options.atlasDisplayOverridesPath
      ? path.resolve(options.paths.root, options.atlasDisplayOverridesPath)
      : path.join(runDir, "atlas.display-overrides.json");
    if (existsSync(displayOverridesPath)) {
      const displayOverrides = readJson<MacroAtlasDisplayOverrides>(displayOverridesPath);
      atlas = applyAtlasDisplayOverrides(
        atlas,
        displayOverrides
      );
      writeJson(path.join(runDir, "atlas.display-overrides.json"), displayOverrides);
      writeJson(path.join(runDir, "atlas.curated.json"), atlas);
      progress.phase("macro:atlas", "applied prose-only display overrides");
    }
    const atlasHash = macroAtlasHash(atlas);
    state.atlasHash = atlasHash;
    const constellationKeys = new Set(atlas.constellations.map((item) => item.key));
    const reusedMembershipItems: MacroMembershipItem[] = [];
    const pendingMembershipNodes: ConsolidatedThoughtNode[] = [];
    for (const node of graph.nodes) {
      const cached = options.forceNewRun
        ? null
        : cachedMembershipForNode({
            cache: membershipCache,
            node,
            assessment: assessmentById.get(node.id)!,
            nodeById,
            atlasHash,
            model,
            reasoningEffort: options.reasoningEffort
          });
      if (cached) reusedMembershipItems.push(cached);
      else pendingMembershipNodes.push(node);
    }
    const canResumeMembershipPlan =
      !stateWasLegacy &&
      state.membershipPlanGraphSemanticHash === graphSemanticHash &&
      state.membershipPlanAtlasHash === atlasHash &&
      Array.isArray(state.membershipPlanNodeIds);
    if (!canResumeMembershipPlan) {
      // Legacy completed batch ids describe the whole ordered graph. Once
      // validated items have been promoted to the item cache, pending-only
      // batches use a new layout and must start their own checkpoint sequence.
      state.completedMembershipBatchIds = [];
      state.completedCoverageBatchIds = [];
      state.membershipPlanNodeIds = pendingMembershipNodes
        .slice()
        .sort(membershipSort)
        .map((node) => node.id);
      state.membershipPlanGraphSemanticHash = graphSemanticHash;
      state.membershipPlanAtlasHash = atlasHash;
    }
    const membershipPlanNodes = (state.membershipPlanNodeIds ?? [])
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is ConsolidatedThoughtNode => Boolean(node));
    const batches = buildMembershipBatches(membershipPlanNodes, membershipBatchSize);
    state.membershipBatchCount = batches.length;
    state.reusedMembershipItemCount = reusedMembershipItems.length;
    state.generatedMembershipItemCount = state.generatedMembershipItemCount ?? 0;
    writeRunState(runDir, state);
    const completedMembership = new Set(state.completedMembershipBatchIds);
    const membershipItems: MacroMembershipItem[] = [...reusedMembershipItems];
    let generatedMembershipBatchCount = 0;

    progress.phase(
      "macro:membership",
      `${reusedMembershipItems.length}/${graph.nodeCount} items reused; ${pendingMembershipNodes.length} nodes across ${batches.length} resumable batches`
    );
    for (const [index, batch] of batches.entries()) {
      const batchId = membershipBatchId("membership", index);
      const batchPath = path.join(runDir, "membership", `${batchId}.json`);
      const rawBatchPath = path.join(runDir, "membership", `${batchId}.raw.json`);
      const cachedByNodeId = new Map<string, MacroMembershipItem>();
      for (const node of batch) {
        const cached = cachedMembershipForNode({
          cache: membershipCache,
          node,
          assessment: assessmentById.get(node.id)!,
          nodeById,
          atlasHash,
          model,
          reasoningEffort: options.reasoningEffort
        });
        if (cached) cachedByNodeId.set(node.id, cached);
      }
      const unresolvedBatch = batch.filter((node) => !cachedByNodeId.has(node.id));
      if (unresolvedBatch.length === 0) {
        if (!completedMembership.has(batchId)) {
          state.completedMembershipBatchIds.push(batchId);
          completedMembership.add(batchId);
          writeRunState(runDir, state);
        }
        continue;
      }
      const recoveryPath = existsSync(batchPath) ? batchPath : rawBatchPath;
      if (existsSync(recoveryPath)) {
        try {
          const recovered = validateMembershipBatch({
            raw: readJson<MacroMembershipBatchOutput>(recoveryPath),
            batchId,
            expectedNodeIds: unresolvedBatch.map((node) => node.id),
            constellationKeys
          });
          writeJson(batchPath, recovered);
          membershipItems.push(...recovered.items);
          upsertMembershipCacheItems({
            cache: membershipCache,
            items: recovered.items,
            nodeById,
            assessmentById,
            atlasHash,
            model,
            reasoningEffort: options.reasoningEffort,
            sourceRunId: state.runId
          });
          writeMembershipCache(targetStateDir, membershipCache);
          state.completedMembershipBatchIds.push(batchId);
          completedMembership.add(batchId);
          writeRunState(runDir, state);
          progress.item("macro:membership", "recovered batches", index + 1, batches.length, batchId);
          continue;
        } catch {
          // Keep the raw audit, but regenerate when it cannot satisfy the current contract.
        }
      }
      if (
        options.maxMembershipBatches !== null &&
        options.maxMembershipBatches !== undefined &&
        generatedMembershipBatchCount >= options.maxMembershipBatches
      ) {
        state.status = "paused_manual";
        writeRunState(runDir, state);
        return pausedSummary({ graph, state, representatives, runDir, targetOutputDir });
      }
      const prompt = buildMembershipPrompt({
        batchId,
        nodes: unresolvedBatch,
        assessmentById,
        nodeById,
        atlas,
        coverageRepair: false
      });
      const validated = executeValidatedSemanticBatch<MacroMembershipBatchOutput>({
        client: semanticClient(),
        prompt,
        outputSchemaPath: membershipSchemaPath,
        workingDir: workerDir,
        targetOutputDir,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        rawPath: rawBatchPath,
        validate: (raw) => validateMembershipBatch({
          raw,
          batchId,
          expectedNodeIds: unresolvedBatch.map((node) => node.id),
          constellationKeys
        }),
        onRetry: (message) => progress.phase("macro:membership", `retrying ${batchId} after ${message}`)
      });
      writeJson(batchPath, validated);
      membershipItems.push(...validated.items);
      upsertMembershipCacheItems({
        cache: membershipCache,
        items: validated.items,
        nodeById,
        assessmentById,
        atlasHash,
        model,
        reasoningEffort: options.reasoningEffort,
        sourceRunId: state.runId,
        overwrite: true
      });
      writeMembershipCache(targetStateDir, membershipCache);
      state.completedMembershipBatchIds.push(batchId);
      completedMembership.add(batchId);
      generatedMembershipBatchCount += 1;
      state.generatedMembershipItemCount =
        (state.generatedMembershipItemCount ?? 0) + validated.items.length;
      writeRunState(runDir, state);
      progress.item("macro:membership", "batches", index + 1, batches.length, batchId);
    }

    const resolvedMembershipItems = mergeMembershipItems([], membershipItems);
    const initiallyMapped = new Set(
      resolvedMembershipItems.filter((item) => item.memberships.length > 0).map((item) => item.nodeId)
    );
    atlas.constellations.forEach((constellation) => {
      constellation.seedNodeIds.forEach((nodeId) => initiallyMapped.add(nodeId));
    });
    const requiredUnmapped = assessments
      .filter((item) =>
        !initiallyMapped.has(item.nodeId) && requiresMacroMapCoverage(item)
      )
      .map((item) => nodeById.get(item.nodeId)!)
      .sort(membershipSort);
    const coverageBatches = buildMembershipBatches(requiredUnmapped, membershipBatchSize);
    state.coverageBatchCount = coverageBatches.length;
    writeRunState(runDir, state);
    const completedCoverage = new Set(state.completedCoverageBatchIds);
    const coverageItems: MacroMembershipItem[] = [];
    if (coverageBatches.length > 0) {
      progress.phase(
        "macro:coverage",
        `${requiredUnmapped.length} required nodes across ${coverageBatches.length} repair batches`
      );
    }
    for (const [index, batch] of coverageBatches.entries()) {
      const batchId = membershipBatchId("coverage", index);
      const batchPath = path.join(runDir, "coverage", `${batchId}.json`);
      const rawBatchPath = path.join(runDir, "coverage", `${batchId}.raw.json`);
      if (completedCoverage.has(batchId) && existsSync(batchPath)) {
        const saved = validateSavedCoverageSubset({
          raw: readJson<MacroMembershipBatchOutput>(batchPath),
          batchId,
          expectedNodeIds: batch.map((node) => node.id),
          constellationKeys
        });
        coverageItems.push(...saved.items);
        continue;
      }
      if (existsSync(rawBatchPath)) {
        try {
          const recovered = validateSavedCoverageSubset({
            raw: readJson<MacroMembershipBatchOutput>(rawBatchPath),
            batchId,
            expectedNodeIds: batch.map((node) => node.id),
            constellationKeys
          });
          writeJson(batchPath, recovered);
          coverageItems.push(...recovered.items);
          upsertMembershipCacheItems({
            cache: membershipCache,
            items: recovered.items,
            nodeById,
            assessmentById,
            atlasHash,
            model,
            reasoningEffort: options.reasoningEffort,
            sourceRunId: state.runId,
            overwrite: true
          });
          writeMembershipCache(targetStateDir, membershipCache);
          state.completedCoverageBatchIds.push(batchId);
          completedCoverage.add(batchId);
          writeRunState(runDir, state);
          progress.item("macro:coverage", "recovered batches", index + 1, coverageBatches.length, batchId);
          continue;
        } catch {
          // Keep the raw audit, but regenerate when it cannot satisfy the current contract.
        }
      }
      const prompt = buildMembershipPrompt({
        batchId,
        nodes: batch,
        assessmentById,
        nodeById,
        atlas,
        coverageRepair: true
      });
      const validated = executeValidatedSemanticBatch<MacroMembershipBatchOutput>({
        client: semanticClient(),
        prompt,
        outputSchemaPath: membershipSchemaPath,
        workingDir: workerDir,
        targetOutputDir,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        rawPath: rawBatchPath,
        validate: (raw) => validateMembershipBatch({
          raw,
          batchId,
          expectedNodeIds: batch.map((node) => node.id),
          constellationKeys
        }),
        onRetry: (message) => progress.phase("macro:coverage", `retrying ${batchId} after ${message}`)
      });
      writeJson(batchPath, validated);
      coverageItems.push(...validated.items);
      upsertMembershipCacheItems({
        cache: membershipCache,
        items: validated.items,
        nodeById,
        assessmentById,
        atlasHash,
        model,
        reasoningEffort: options.reasoningEffort,
        sourceRunId: state.runId,
        overwrite: true
      });
      writeMembershipCache(targetStateDir, membershipCache);
      state.completedCoverageBatchIds.push(batchId);
      completedCoverage.add(batchId);
      state.generatedMembershipItemCount =
        (state.generatedMembershipItemCount ?? 0) + validated.items.length;
      writeRunState(runDir, state);
      progress.item("macro:coverage", "batches", index + 1, coverageBatches.length, batchId);
    }

    const mergedMemberships = mergeMembershipItems(resolvedMembershipItems, coverageItems);
    const acceptedUnmappedHighSalienceNodeIds = acceptedHighSalienceOmissions({
      memberships: resolvedMembershipItems,
      assessments
    });
    writeJson(path.join(runDir, "coverage", "coverage-policy.json"), {
      schemaVersion: 1,
      hardCoveragePolicy: "authored_or_mixed",
      requiredNodeIds: requiredUnmapped.map((node) => node.id),
      appliedCoverageNodeIds: coverageItems.map((item) => item.nodeId),
      acceptedUnmappedHighSalienceNodeIds
    });
    const assembled = assembleMacroMapProposal({
      atlas,
      memberships: mergedMemberships,
      graph,
      assessments
    });
    const validatedProposal = validateMacroMapProposal(assembled, validNodeIds, {
      maxConstellationMemberCount: maxAllowedConstellationMembers(graph.nodeCount)
    });
    const graphRepair = repairMacroMapCoverage({
      proposal: validatedProposal,
      graph,
      assessments,
      maxConstellationMemberCount: maxAllowedConstellationMembers(graph.nodeCount)
    });
    const proposal = validateMacroMapProposal(graphRepair.proposal, validNodeIds, {
      maxConstellationMemberCount: maxAllowedConstellationMembers(graph.nodeCount)
    });
    writeJson(path.join(runDir, "proposal.json"), proposal);
    writeJson(path.join(runDir, "proposal_repairs.json"), graphRepair.repairs);
    let artifact = buildMacroMapArtifact({
      proposal,
      graph,
      assessments,
      model,
      reasoningEffort: options.reasoningEffort,
      iterationLabel: options.iterationLabel,
      graphPath,
      graphHash,
      graphSemanticHash,
      alignmentPath: alignment ? alignmentPath : null,
      alignmentHash,
      alignmentSemanticHash,
      proposalRepairs: graphRepair.repairs,
      acceptedUnmappedHighSalienceNodeIds
    });

    const trajectoryPath = path.join(runDir, "trajectories.json");
    const rawTrajectoryPath = path.join(runDir, "trajectories.raw.json");
    const refinedTrajectoryPath = options.refinedTrajectoryPath
      ? path.resolve(options.paths.root, options.refinedTrajectoryPath)
      : path.join(runDir, "trajectories.refined.json");
    const rawRefinedTrajectoryPath = path.join(runDir, "trajectories.refined.raw.json");
    const trajectoryEvidenceHash = macroTrajectoryEvidenceHash(artifact);
    const reusableArtifactPath = reusableAtlas
      ? path.join(reusableAtlas.runDir, "artifact.json")
      : null;
    const reusableArtifact = reusableArtifactPath && existsSync(reusableArtifactPath)
      ? readJson<ThoughtMacroMapArtifact>(reusableArtifactPath)
      : null;
    const reusableTrajectoryProposal =
      reusableArtifact &&
      reusableArtifact.trajectories.length > 0 &&
      macroTrajectoryEvidenceHash(reusableArtifact) === trajectoryEvidenceHash
        ? { trajectories: reusableArtifact.trajectories.map((trajectory) => ({
            key: trajectory.id.split(":").slice(-1)[0] ?? trajectory.id,
            title: trajectory.title,
            summary: trajectory.summary,
            constellationIds: trajectory.constellationIds,
            stages: trajectory.stages,
            currentPositionNodeIds: trajectory.currentPositionNodeIds,
            openTensionNodeIds: trajectory.openTensionNodeIds,
            confidence: trajectory.confidence,
            uncertainty: trajectory.uncertainty
          })) } satisfies MacroTrajectoryProposal
        : null;
    let trajectories: MacroTrajectoryProposal;
    if (options.refreshTrajectories) {
      state.trajectoryReused = false;
      trajectories = awaitTrajectoryProposal(refinedTrajectoryPath, rawRefinedTrajectoryPath);
    } else if (existsSync(refinedTrajectoryPath)) {
      trajectories = validateMacroTrajectories(
        readJson<MacroTrajectoryProposal>(refinedTrajectoryPath),
        artifact
      );
      writeJson(path.join(runDir, "trajectories.refined.json"), trajectories);
      state.trajectoryReused = true;
      progress.phase("macro:trajectories", "reusing refined trajectory pass");
    } else if (state.trajectoryCompleted && existsSync(trajectoryPath)) {
      trajectories = validateMacroTrajectories(
        readJson<MacroTrajectoryProposal>(trajectoryPath),
        artifact
      );
      state.trajectoryReused = true;
      progress.phase("macro:trajectories", "reusing completed trajectory pass");
    } else if (reusableTrajectoryProposal) {
      trajectories = validateMacroTrajectories(reusableTrajectoryProposal, artifact);
      writeJson(trajectoryPath, trajectories);
      state.trajectoryCompleted = true;
      state.trajectoryReused = true;
      progress.phase("macro:trajectories", "reusing trajectories with unchanged constellation evidence");
    } else if (existsSync(rawTrajectoryPath)) {
      try {
        trajectories = validateMacroTrajectories(
          readJson<MacroTrajectoryProposal>(rawTrajectoryPath),
          artifact
        );
        writeJson(trajectoryPath, trajectories);
        state.trajectoryCompleted = true;
        state.trajectoryReused = true;
        writeRunState(runDir, state);
        progress.phase("macro:trajectories", "recovered validated trajectory pass from raw output");
      } catch {
        state.trajectoryReused = false;
        trajectories = awaitTrajectoryProposal(trajectoryPath, rawTrajectoryPath);
      }
    } else {
      state.trajectoryReused = false;
      trajectories = awaitTrajectoryProposal(trajectoryPath, rawTrajectoryPath);
    }

    function awaitTrajectoryProposal(
      outputPath: string,
      rawOutputPath: string
    ): MacroTrajectoryProposal {
      progress.phase("macro:trajectories", "synthesizing global developmental trajectories");
      const trajectoryPrompt = buildTrajectoryPrompt(artifact, graph);
      writeFileSync(path.join(runDir, "trajectory-prompt.txt"), `${trajectoryPrompt}\n`, "utf8");
      const result = executeValidatedSemanticBatch<MacroTrajectoryProposal>({
        client: semanticClient(),
        prompt: trajectoryPrompt,
        outputSchemaPath: trajectorySchemaPath,
        workingDir: workerDir,
        targetOutputDir,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        rawPath: rawOutputPath,
        validate: (raw) => validateMacroTrajectories(raw, artifact),
        onRetry: (message) => progress.phase("macro:trajectories", `retrying after ${message}`)
      });
      writeJson(outputPath, result);
      state.trajectoryCompleted = true;
      state.trajectoryInputHash = trajectoryEvidenceHash;
      writeRunState(runDir, state);
      return result;
    }
    state.trajectoryInputHash = trajectoryEvidenceHash;
    artifact = attachTrajectories(artifact, trajectories);
    mkdirSync(targetCompiledDir, { recursive: true });
    mkdirSync(targetAuditsDir, { recursive: true });
    writeJson(artifactPath, artifact);
    writeFileSync(reportPath, buildMacroMapReport(artifact), "utf8");
    writeJson(path.join(runDir, "artifact.json"), artifact);
    writeFileSync(path.join(runDir, "report.md"), buildMacroMapReport(artifact), "utf8");
    state.status = "completed";
    state.failureMessage = null;
    writeRunState(runDir, state);
    return artifactSummary({
      artifact,
      state,
      representatives,
      artifactPath,
      reportPath,
      runDir
    });
  } catch (error) {
    if (!replayingCompletedRun) {
      state.status = "failed";
      state.failureMessage = error instanceof Error ? error.message : String(error);
      writeRunState(runDir, state);
    }
    throw error;
  } finally {
    rmSync(workerDir, { recursive: true, force: true });
  }
}
