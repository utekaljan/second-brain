import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CodexCliClient, type CodexReasoningEffort } from "../codex/client.js";
import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import type {
  ConsolidatedThoughtGraph,
  ConsolidatedThoughtNode,
  ThoughtFrameAlignmentArtifact
} from "../compiler/types.js";
import type { ProjectPaths } from "../system/paths.js";
import type { SourceKind } from "../types/domain.js";
import { slugify } from "../utils/text.js";

const DEFAULTS = SECOND_BRAIN_DEFAULTS.thoughtMacroMap;

export type MacroNodeRole = "core" | "supporting" | "context";
export type MacroAtlasRole = "core_direction" | "active_exploration" | "supporting_context";

export type MacroNodeAssessment = {
  nodeId: string;
  title: string;
  nodeType: ConsolidatedThoughtNode["nodeType"];
  status: ConsolidatedThoughtNode["status"];
  sourceAuthority: "authored" | "mixed" | "conversation" | "chat" | "unknown";
  salienceScore: number;
  salienceFactors: {
    authority: number;
    crossDocument: number;
    recurrence: number;
    graphCentrality: number;
    semanticRole: number;
  };
  documentIds: string[];
  writingDocumentIds: string[];
  conversationDocumentIds: string[];
  chatDocumentIds: string[];
};

export type ThoughtMacroConstellation = {
  id: string;
  title: string;
  summary: string;
  rationale: string;
  trajectoryHint: string;
  atlasRole: MacroAtlasRole;
  confidence: number;
  uncertainty: string;
  salienceScore: number;
  sourceAuthority: MacroNodeAssessment["sourceAuthority"];
  firstSeen: string | null;
  lastSeen: string | null;
  documentIds: string[];
  memberNodeIds: string[];
  members: Array<{
    nodeId: string;
    role: MacroNodeRole;
    currentPosition: boolean;
    openQuestion: boolean;
    tension: boolean;
  }>;
  evidenceHighlights: Array<{
    nodeId: string;
    title: string;
    salienceScore: number;
    sourceAuthority: MacroNodeAssessment["sourceAuthority"];
    documentIds: string[];
  }>;
};

export type ThoughtMacroTrajectory = {
  id: string;
  title: string;
  summary: string;
  constellationIds: string[];
  stages: Array<{
    label: string;
    summary: string;
    nodeIds: string[];
    startDate: string | null;
    endDate: string | null;
  }>;
  currentPositionNodeIds: string[];
  openTensionNodeIds: string[];
  confidence: number;
  uncertainty: string;
};

export type ThoughtMacroZoomItem = {
  nodeId: string;
  title: string;
  constellationIds: string[];
  salienceScore: number;
  sourceAuthority: MacroNodeAssessment["sourceAuthority"];
};

export type ThoughtMacroMapArtifact = {
  schemaVersion: 1;
  contractVersion: string;
  generatedAt: string;
  model: string | null;
  reasoningEffort: CodexReasoningEffort;
  iterationLabel: string;
  sourceConsolidatedGraphPath: string;
  sourceConsolidatedGraphHash: string;
  sourceConsolidatedGraphSemanticHash?: string;
  sourceFrameAlignmentPath: string | null;
  sourceFrameAlignmentHash: string | null;
  sourceFrameAlignmentSemanticHash?: string | null;
  sourceNodeCount: number;
  atlas: {
    title: string;
    summary: string;
    constellationIds: string[];
    entrypointConstellationIds: string[];
    trajectoryIds: string[];
    currentPositionNodeIds: string[];
    openQuestionNodeIds: string[];
    openTensionNodeIds: string[];
  };
  constellations: ThoughtMacroConstellation[];
  trajectories: ThoughtMacroTrajectory[];
  currentPositions: ThoughtMacroZoomItem[];
  openQuestions: ThoughtMacroZoomItem[];
  openTensions: ThoughtMacroZoomItem[];
  nodeAssessments: MacroNodeAssessment[];
  quality: {
    constellationCount: number;
    trajectoryCount: number;
    mappedNodeCount: number;
    mappedNodeShare: number;
    overlapNodeCount: number;
    highSalienceNodeCount: number;
    mappedHighSalienceNodeCount: number;
    mappedHighSalienceShare: number;
    authoredNodeCount: number;
    mappedAuthoredNodeCount: number;
    mappedAuthoredShare: number;
    unmappedNodeIds: string[];
    unmappedHighSalienceNodeIds: string[];
    acceptedUnmappedHighSalienceNodeIds: string[];
    unmappedAuthoredNodeIds: string[];
    proposalRepairs: string[];
    warnings: string[];
  };
};

export type ThoughtMacroMapSummary = {
  constellationCount: number;
  trajectoryCount: number;
  mappedNodeCount: number;
  mappedNodeShare: number;
  mappedHighSalienceShare: number;
  mappedAuthoredShare: number;
  warningCount: number;
  artifactPath: string;
  reportPath: string;
  runDir: string;
};

export type MacroMapProposal = {
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
    memberNodeIds: string[];
    coreNodeIds: string[];
    supportingNodeIds: string[];
    contextNodeIds: string[];
    currentPositionNodeIds: string[];
    openQuestionNodeIds: string[];
    tensionNodeIds: string[];
  }>;
};

/** Authored evidence is the only hard coverage invariant at the macro layer. */
export function requiresMacroMapCoverage(assessment: MacroNodeAssessment): boolean {
  return assessment.sourceAuthority === "authored" || assessment.sourceAuthority === "mixed";
}

export type MacroTrajectoryProposal = {
  trajectories: Array<{
    key: string;
    title: string;
    summary: string;
    constellationIds: string[];
    stages: Array<{
      label: string;
      summary: string;
      nodeIds: string[];
      startDate: string | null;
      endDate: string | null;
    }>;
    currentPositionNodeIds: string[];
    openTensionNodeIds: string[];
    confidence: number;
    uncertainty: string;
  }>;
};

const MACRO_MAP_SCHEMA = {
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
          "memberNodeIds",
          "coreNodeIds",
          "supportingNodeIds",
          "contextNodeIds",
          "currentPositionNodeIds",
          "openQuestionNodeIds",
          "tensionNodeIds"
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
          memberNodeIds: {
            type: "array",
            minItems: DEFAULTS.minConstellationMemberCount,
            maxItems: DEFAULTS.maxConstellationMemberCount,
            items: { type: "string" }
          },
          coreNodeIds: { type: "array", minItems: 1, items: { type: "string" } },
          supportingNodeIds: { type: "array", items: { type: "string" } },
          contextNodeIds: { type: "array", items: { type: "string" } },
          currentPositionNodeIds: { type: "array", items: { type: "string" } },
          openQuestionNodeIds: { type: "array", items: { type: "string" } },
          tensionNodeIds: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
} as const;

const MACRO_TRAJECTORY_SCHEMA = {
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

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundShare(value: number): number {
  return Math.round(value * 1000) / 1000;
}

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

function sourceDocuments(node: ConsolidatedThoughtNode, kind: SourceKind): string[] {
  return uniqueSorted(
    node.sourceRefs
      .filter((ref) => ref.sourceKind === kind)
      .map((ref) => ref.documentId)
  );
}

function sourceAuthority(options: {
  writingDocumentIds: string[];
  conversationDocumentIds: string[];
  chatDocumentIds: string[];
}): MacroNodeAssessment["sourceAuthority"] {
  if (options.writingDocumentIds.length > 0) {
    return options.conversationDocumentIds.length > 0 || options.chatDocumentIds.length > 0
      ? "mixed"
      : "authored";
  }
  if (options.conversationDocumentIds.length > 0) {
    return "conversation";
  }
  if (options.chatDocumentIds.length > 0) {
    return "chat";
  }
  return "unknown";
}

/**
 * Rank navigation candidates from inspectable provenance rather than raw node
 * volume. One authored document deliberately outweighs many turns from one
 * conversation, while cross-document recurrence can still raise a dialogue idea.
 */
export function assessMacroNodes(graph: ConsolidatedThoughtGraph): MacroNodeAssessment[] {
  const maxDegree = Math.max(1, ...graph.nodes.map((node) => node.relatedNodeIds.length));

  return graph.nodes
    .map((node) => {
      const writingDocumentIds = sourceDocuments(node, "writing");
      const conversationDocumentIds = sourceDocuments(node, "conversation");
      const chatDocumentIds = sourceDocuments(node, "chat");
      const documentIds = uniqueSorted([
        ...writingDocumentIds,
        ...conversationDocumentIds,
        ...chatDocumentIds
      ]);
      const authority = writingDocumentIds.length > 0
        ? Math.min(1, 0.78 + Math.max(0, writingDocumentIds.length - 1) * 0.1 + conversationDocumentIds.length * 0.04)
        : conversationDocumentIds.length > 0
          ? Math.min(0.62, 0.28 + Math.max(0, conversationDocumentIds.length - 1) * 0.12)
          : chatDocumentIds.length > 0
            ? Math.min(0.45, 0.2 + Math.max(0, chatDocumentIds.length - 1) * 0.08)
            : 0;
      const crossDocument = Math.min(1, Math.max(0, documentIds.length - 1) / 3);
      const recurrence = Math.min(1, Math.log2(1 + documentIds.length) / Math.log2(5));
      const graphCentrality = Math.log2(1 + node.relatedNodeIds.length) / Math.log2(1 + maxDegree);
      const semanticRole = node.nodeType === "thesis"
        ? 1
        : node.nodeType === "tension" || node.nodeType === "thread"
          ? 0.9
          : node.nodeType === "question"
            ? 0.82
            : 0.65;
      const salienceScore = roundScore(100 * (
        authority * 0.46 +
        crossDocument * 0.18 +
        recurrence * 0.14 +
        graphCentrality * 0.1 +
        semanticRole * 0.12
      ));

      return {
        nodeId: node.id,
        title: node.title,
        nodeType: node.nodeType,
        status: node.status,
        sourceAuthority: sourceAuthority({
          writingDocumentIds,
          conversationDocumentIds,
          chatDocumentIds
        }),
        salienceScore,
        salienceFactors: {
          authority: roundScore(authority * 100),
          crossDocument: roundScore(crossDocument * 100),
          recurrence: roundScore(recurrence * 100),
          graphCentrality: roundScore(graphCentrality * 100),
          semanticRole: roundScore(semanticRole * 100)
        },
        documentIds,
        writingDocumentIds,
        conversationDocumentIds,
        chatDocumentIds
      };
    })
    .sort((left, right) => right.salienceScore - left.salienceScore || left.nodeId.localeCompare(right.nodeId));
}

function compactNodeInput(
  node: ConsolidatedThoughtNode,
  assessment: MacroNodeAssessment,
  nodeById: Map<string, ConsolidatedThoughtNode>
): Record<string, unknown> {
  return {
    id: node.id,
    title: node.title,
    summary: node.summary.slice(0, 700),
    type: node.nodeType,
    status: node.status,
    firstSeen: node.firstSeen,
    lastSeen: node.lastSeen,
    salience: assessment.salienceScore,
    sourceAuthority: assessment.sourceAuthority,
    documents: assessment.documentIds,
    frameLabels: uniqueSorted((node.frameMemberships ?? []).map((membership) => membership.frameLabel)),
    relatedTitles: node.relatedNodeIds
      .slice(0, 8)
      .map((nodeId) => nodeById.get(nodeId)?.title)
      .filter((title): title is string => Boolean(title))
  };
}

function buildPrompt(options: {
  graph: ConsolidatedThoughtGraph;
  alignment: ThoughtFrameAlignmentArtifact | null;
  assessments: MacroNodeAssessment[];
}): string {
  const nodeById = new Map(options.graph.nodes.map((node) => [node.id, node]));
  const assessmentById = new Map(options.assessments.map((item) => [item.nodeId, item]));
  const nodes = options.graph.nodes.map((node) => compactNodeInput(
    node,
    assessmentById.get(node.id)!,
    nodeById
  ));
  const frameFamilies = (options.alignment?.families ?? []).map((family) => ({
    id: family.id,
    label: family.label,
    documents: family.memberDocumentIds,
    nodeIds: family.memberNodeIds
  }));

  return [
    "Jsi kurátor osobní mapy myšlení. Vytvoř první makro mapu NAD existujícím konsolidovaným grafem; nic neslučuj ani nepřepisuj.",
    "Výstup musí být česky a přesně odpovídat JSON schematu.",
    "",
    "CÍL",
    `- Navrhni ${DEFAULTS.minConstellationCount}-${DEFAULTS.maxConstellationCount} významově soudržných konstelací jako hlavní orientaci v autorově myšlení.`,
    "- Upřednostni autorské texty, opakované formulace, pozdější revize a explicitní postoje před objemem jedné konverzace.",
    "- Zachovej jemné rozdíly: konstelace je navigační rodič, ne nový široký claim.",
    "- Konstelace se mohou omezeně překrývat, pokud uzel skutečně plní dvě různé makro role.",
    `- Jedna konstelace smí mít ${DEFAULTS.minConstellationMemberCount}-${DEFAULTS.maxConstellationMemberCount} členů. Větší oblast zúž na její nosnou makro strukturu.`,
    "- Nenuť každý detail do mapy. Musíš ale pokrýt všechny uzly se salience >= 70 a všechny authored/mixed uzly, pokud nejsou čistě lokálním příkladem.",
    "- Vyvaž hlavní tematické oblasti korpusu; jedna dlouhá konverzace nesmí pohltit atlas.",
    "",
    "ROLE A FACETY",
    "- memberNodeIds je přesná množina členů konstelace.",
    "- coreNodeIds, supportingNodeIds a contextNodeIds musí být disjunktní partition memberNodeIds.",
    "- currentPositionNodeIds označuje nejlepší současnou formulaci, ne automaticky nejnovější datum.",
    "- openQuestionNodeIds a tensionNodeIds jsou významové facety a mohou překrývat role.",
    "- Používej pouze přesná node ID z podkladů.",
    "- atlasRole=core_direction používej jen pro autorsky nebo vícedokumentově ukotvený směr; active_exploration pro soudržné rozvíjené myšlení hlavně z konverzace; supporting_context pro technické, čtenářské a pomocné mapy.",
    "- confidence vyjadřuje jistotu, že konstelace je skutečný stabilní makro celek, ne jen tematický shluk. uncertainty stručně pojmenuje hlavní mez důkazů.",
    "",
    "PODKLADY",
    JSON.stringify({ nodes, frameFamilies })
  ].join("\n");
}

function assertUnique(values: string[], context: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${context} contains duplicate node ids.`);
  }
}

function normalizeProposalRoles(
  proposal: MacroMapProposal,
  validNodeIds: Set<string>
): {
  proposal: MacroMapProposal;
  repairs: string[];
} {
  const repairs: string[] = [];
  const repairSet = new Set<string>();
  const validIdsBySuffix = new Map<string, string[]>();
  for (const nodeId of validNodeIds) {
    const suffix = nodeId.split(":").slice(2).join(":");
    validIdsBySuffix.set(suffix, [...(validIdsBySuffix.get(suffix) ?? []), nodeId]);
  }
  const normalizeNodeId = (nodeId: string): string => {
    if (validNodeIds.has(nodeId)) return nodeId;
    const suffix = nodeId.split(":").slice(2).join(":");
    const candidates = validIdsBySuffix.get(suffix) ?? [];
    if (candidates.length !== 1) return nodeId;
    const repair = `normalized malformed stable id ${nodeId} to ${candidates[0]}.`;
    if (!repairSet.has(repair)) {
      repairSet.add(repair);
      repairs.push(repair);
    }
    return candidates[0]!;
  };
  return {
    proposal: {
      ...proposal,
      constellations: proposal.constellations.map((constellation) => {
        const normalizedMemberIds = constellation.memberNodeIds.map(normalizeNodeId);
        const normalizedCoreIds = constellation.coreNodeIds.map(normalizeNodeId);
        const normalizedSupportingIds = constellation.supportingNodeIds.map(normalizeNodeId);
        const normalizedContextIds = constellation.contextNodeIds.map(normalizeNodeId);
        const normalizedCurrentIds = constellation.currentPositionNodeIds.map(normalizeNodeId);
        const normalizedQuestionIds = constellation.openQuestionNodeIds.map(normalizeNodeId);
        const normalizedTensionIds = constellation.tensionNodeIds.map(normalizeNodeId);
        const memberIds = uniqueSorted([
          ...normalizedMemberIds,
          ...normalizedCoreIds,
          ...normalizedSupportingIds,
          ...normalizedContextIds,
          ...normalizedCurrentIds,
          ...normalizedQuestionIds,
          ...normalizedTensionIds
        ]);
        const memberSet = new Set(memberIds);
        const coreIds = uniqueSorted(normalizedCoreIds.filter((nodeId) => memberSet.has(nodeId)));
        const coreSet = new Set(coreIds);
        const supportingIds = uniqueSorted(
          normalizedSupportingIds.filter((nodeId) => memberSet.has(nodeId) && !coreSet.has(nodeId))
        );
        const supportingSet = new Set(supportingIds);
        const contextIds = uniqueSorted(
          memberIds.filter((nodeId) => !coreSet.has(nodeId) && !supportingSet.has(nodeId))
        );
        const originalRoles = [
          ...normalizedCoreIds,
          ...normalizedSupportingIds,
          ...normalizedContextIds
        ];
        if (
          memberIds.length !== normalizedMemberIds.length ||
          new Set(originalRoles).size !== originalRoles.length ||
          originalRoles.length !== memberIds.length ||
          contextIds.some((nodeId) => !normalizedContextIds.includes(nodeId))
        ) {
          repairs.push(`${constellation.key}: normalized role partition; unassigned members became context.`);
        }
        return {
          ...constellation,
          memberNodeIds: memberIds,
          coreNodeIds: coreIds,
          supportingNodeIds: supportingIds,
          contextNodeIds: contextIds,
          currentPositionNodeIds: uniqueSorted(normalizedCurrentIds),
          openQuestionNodeIds: uniqueSorted(normalizedQuestionIds),
          tensionNodeIds: uniqueSorted(normalizedTensionIds)
        };
      })
    },
    repairs
  };
}

/** Validate semantic output before any model-proposed memberships reach disk. */
export function validateMacroMapProposal(
  proposal: MacroMapProposal,
  validNodeIds: Set<string>,
  options: { maxConstellationMemberCount?: number } = {}
): MacroMapProposal {
  const maxConstellationMemberCount = options.maxConstellationMemberCount ??
    DEFAULTS.maxConstellationMemberCount;
  if (
    proposal.constellations.length < DEFAULTS.minConstellationCount ||
    proposal.constellations.length > DEFAULTS.maxConstellationCount
  ) {
    throw new Error(`Macro map must contain ${DEFAULTS.minConstellationCount}-${DEFAULTS.maxConstellationCount} constellations.`);
  }

  const keys = new Set<string>();
  for (const constellation of proposal.constellations) {
    if (keys.has(constellation.key)) {
      throw new Error(`Duplicate constellation key: ${constellation.key}`);
    }
    keys.add(constellation.key);
    if (
      constellation.memberNodeIds.length < DEFAULTS.minConstellationMemberCount ||
      constellation.memberNodeIds.length > maxConstellationMemberCount
    ) {
      throw new Error(
        `${constellation.key} must contain ${DEFAULTS.minConstellationMemberCount}-${maxConstellationMemberCount} members.`
      );
    }
    assertUnique(constellation.memberNodeIds, constellation.key);
    assertUnique(constellation.coreNodeIds, `${constellation.key}.coreNodeIds`);
    assertUnique(constellation.supportingNodeIds, `${constellation.key}.supportingNodeIds`);
    assertUnique(constellation.contextNodeIds, `${constellation.key}.contextNodeIds`);

    for (const nodeId of constellation.memberNodeIds) {
      if (!validNodeIds.has(nodeId)) {
        throw new Error(`${constellation.key} references unknown node ${nodeId}.`);
      }
    }

    const roles = [
      ...constellation.coreNodeIds,
      ...constellation.supportingNodeIds,
      ...constellation.contextNodeIds
    ];
    assertUnique(roles, `${constellation.key} role partition`);
    if (roles.length !== constellation.memberNodeIds.length || roles.some((nodeId) => !constellation.memberNodeIds.includes(nodeId))) {
      throw new Error(`${constellation.key} roles must partition memberNodeIds.`);
    }

    for (const [facet, ids] of [
      ["currentPositionNodeIds", constellation.currentPositionNodeIds],
      ["openQuestionNodeIds", constellation.openQuestionNodeIds],
      ["tensionNodeIds", constellation.tensionNodeIds]
    ] as const) {
      assertUnique(ids, `${constellation.key}.${facet}`);
      if (ids.some((nodeId) => !constellation.memberNodeIds.includes(nodeId))) {
        throw new Error(`${constellation.key}.${facet} must be a subset of memberNodeIds.`);
      }
    }
  }

  return proposal;
}

/**
 * Repair only required coverage gaps backed by a clear majority of existing
 * graph neighbors. This reuses semantic relations already accepted upstream;
 * ambiguous gaps remain visible warnings instead of being guessed into a map.
 */
export function repairMacroMapCoverage(options: {
  proposal: MacroMapProposal;
  graph: ConsolidatedThoughtGraph;
  assessments: MacroNodeAssessment[];
  maxConstellationMemberCount?: number;
}): { proposal: MacroMapProposal; repairs: string[] } {
  const maxConstellationMemberCount = options.maxConstellationMemberCount ??
    DEFAULTS.maxConstellationMemberCount;
  const constellations = options.proposal.constellations.map((item) => ({
    ...item,
    memberNodeIds: [...item.memberNodeIds],
    coreNodeIds: [...item.coreNodeIds],
    supportingNodeIds: [...item.supportingNodeIds],
    contextNodeIds: [...item.contextNodeIds],
    currentPositionNodeIds: [...item.currentPositionNodeIds],
    openQuestionNodeIds: [...item.openQuestionNodeIds],
    tensionNodeIds: [...item.tensionNodeIds]
  }));
  const constellationIndexesByNodeId = new Map<string, number[]>();
  for (const [index, constellation] of constellations.entries()) {
    for (const nodeId of constellation.memberNodeIds) {
      constellationIndexesByNodeId.set(nodeId, [
        ...(constellationIndexesByNodeId.get(nodeId) ?? []),
        index
      ]);
    }
  }
  const nodeById = new Map(options.graph.nodes.map((node) => [node.id, node]));
  const requiredAssessments = options.assessments.filter(requiresMacroMapCoverage);
  const repairs: string[] = [];

  for (const assessment of requiredAssessments) {
    if (constellationIndexesByNodeId.has(assessment.nodeId)) continue;
    const node = nodeById.get(assessment.nodeId);
    if (!node) continue;
    const votes = new Map<number, number>();
    for (const relatedNodeId of node.relatedNodeIds) {
      for (const index of constellationIndexesByNodeId.get(relatedNodeId) ?? []) {
        votes.set(index, (votes.get(index) ?? 0) + 1);
      }
    }
    const ranked = Array.from(votes.entries()).sort((left, right) => right[1] - left[1] || left[0] - right[0]);
    const [winnerIndex, winnerVotes] = ranked[0] ?? [];
    const runnerUpVotes = ranked[1]?.[1] ?? 0;
    if (
      winnerIndex === undefined ||
      winnerVotes === undefined ||
      winnerVotes < 2 ||
      winnerVotes <= runnerUpVotes
    ) {
      continue;
    }
    const constellation = constellations[winnerIndex]!;
    if (constellation.memberNodeIds.length >= maxConstellationMemberCount) continue;
    constellation.memberNodeIds.push(node.id);
    constellation.supportingNodeIds.push(node.id);
    if (node.nodeType === "question") constellation.openQuestionNodeIds.push(node.id);
    if (node.nodeType === "tension") constellation.tensionNodeIds.push(node.id);
    constellationIndexesByNodeId.set(node.id, [winnerIndex]);
    repairs.push(
      `${node.id}: assigned to ${constellation.key} from ${winnerVotes} related mapped neighbors.`
    );
  }

  return {
    proposal: {
      ...options.proposal,
      constellations: constellations.map((item) => ({
        ...item,
        memberNodeIds: uniqueSorted(item.memberNodeIds),
        supportingNodeIds: uniqueSorted(item.supportingNodeIds),
        openQuestionNodeIds: uniqueSorted(item.openQuestionNodeIds),
        tensionNodeIds: uniqueSorted(item.tensionNodeIds)
      }))
    },
    repairs
  };
}

function stableConstellationId(key: string, memberNodeIds: string[]): string {
  const digest = hashText(uniqueSorted(memberNodeIds).join("\n")).slice(0, 10);
  return `macro:${digest}:${slugify(key) || "constellation"}`;
}

function aggregateAuthority(assessments: MacroNodeAssessment[]): MacroNodeAssessment["sourceAuthority"] {
  if (assessments.some((item) => item.sourceAuthority === "mixed")) return "mixed";
  if (assessments.some((item) => item.sourceAuthority === "authored")) {
    return assessments.some((item) => item.sourceAuthority === "conversation" || item.sourceAuthority === "chat")
      ? "mixed"
      : "authored";
  }
  if (assessments.some((item) => item.sourceAuthority === "conversation")) return "conversation";
  if (assessments.some((item) => item.sourceAuthority === "chat")) return "chat";
  return "unknown";
}

function nonNullDates(values: Array<string | null>): string[] {
  return values.filter((value): value is string => Boolean(value)).sort();
}

export function buildMacroMapArtifact(options: {
  proposal: MacroMapProposal;
  graph: ConsolidatedThoughtGraph;
  assessments: MacroNodeAssessment[];
  model: string | null;
  reasoningEffort: CodexReasoningEffort;
  iterationLabel: string;
  graphPath: string;
  graphHash: string;
  graphSemanticHash?: string;
  alignmentPath: string | null;
  alignmentHash: string | null;
  alignmentSemanticHash?: string | null;
  proposalRepairs?: string[];
  acceptedUnmappedHighSalienceNodeIds?: string[];
}): ThoughtMacroMapArtifact {
  const nodeById = new Map(options.graph.nodes.map((node) => [node.id, node]));
  const assessmentById = new Map(options.assessments.map((item) => [item.nodeId, item]));
  const constellations = options.proposal.constellations.map((proposal) => {
    const memberIds = uniqueSorted(proposal.memberNodeIds);
    const memberAssessments = memberIds.map((nodeId) => assessmentById.get(nodeId)!);
    const dates = nonNullDates(memberIds.flatMap((nodeId) => {
      const node = nodeById.get(nodeId)!;
      return [node.firstSeen, node.lastSeen];
    }));
    const roleById = new Map<string, MacroNodeRole>([
      ...proposal.coreNodeIds.map((nodeId) => [nodeId, "core"] as const),
      ...proposal.supportingNodeIds.map((nodeId) => [nodeId, "supporting"] as const),
      ...proposal.contextNodeIds.map((nodeId) => [nodeId, "context"] as const)
    ]);
    const evidenceHighlights = memberAssessments
      .slice()
      .sort((left, right) => right.salienceScore - left.salienceScore || left.nodeId.localeCompare(right.nodeId))
      .slice(0, DEFAULTS.evidenceHighlightCount)
      .map((item) => ({
        nodeId: item.nodeId,
        title: item.title,
        salienceScore: item.salienceScore,
        sourceAuthority: item.sourceAuthority,
        documentIds: item.documentIds
      }));

    const authority = aggregateAuthority(memberAssessments);
    const atlasRole = proposal.atlasRole === "core_direction" && (
      authority === "conversation" || authority === "chat" || authority === "unknown"
    )
      ? "active_exploration"
      : proposal.atlasRole;
    return {
      id: stableConstellationId(proposal.key, memberIds),
      title: proposal.title,
      summary: proposal.summary,
      rationale: proposal.rationale,
      trajectoryHint: proposal.trajectoryHint,
      atlasRole,
      confidence: roundScore(Math.min(
        proposal.confidence,
        authority === "conversation" || authority === "chat" ? 0.72 : 1
      )),
      uncertainty: proposal.uncertainty,
      salienceScore: roundScore(memberAssessments.reduce((sum, item) => sum + item.salienceScore, 0) / Math.max(1, memberAssessments.length)),
      sourceAuthority: authority,
      firstSeen: dates.at(0) ?? null,
      lastSeen: dates.at(-1) ?? null,
      documentIds: uniqueSorted(memberAssessments.flatMap((item) => item.documentIds)),
      memberNodeIds: memberIds,
      members: memberIds.map((nodeId) => ({
        nodeId,
        role: roleById.get(nodeId)!,
        currentPosition: proposal.currentPositionNodeIds.includes(nodeId),
        openQuestion: proposal.openQuestionNodeIds.includes(nodeId),
        tension: proposal.tensionNodeIds.includes(nodeId)
      })),
      evidenceHighlights
    } satisfies ThoughtMacroConstellation;
  });

  const membershipCounts = new Map<string, number>();
  for (const constellation of constellations) {
    for (const nodeId of constellation.memberNodeIds) {
      membershipCounts.set(nodeId, (membershipCounts.get(nodeId) ?? 0) + 1);
    }
  }
  const mappedNodeIds = new Set(membershipCounts.keys());
  const highSalience = options.assessments.filter((item) => item.salienceScore >= DEFAULTS.highSalienceThreshold);
  const authored = options.assessments.filter((item) => item.sourceAuthority === "authored" || item.sourceAuthority === "mixed");
  const unmappedNodeIds = options.assessments.filter((item) => !mappedNodeIds.has(item.nodeId)).map((item) => item.nodeId);
  const unmappedHighSalienceNodeIds = highSalience.filter((item) => !mappedNodeIds.has(item.nodeId)).map((item) => item.nodeId);
  const acceptedUnmappedHighSalienceNodeIds = uniqueSorted(
    (options.acceptedUnmappedHighSalienceNodeIds ?? [])
      .filter((nodeId) => unmappedHighSalienceNodeIds.includes(nodeId))
  );
  const acceptedUnmappedHighSalience = new Set(acceptedUnmappedHighSalienceNodeIds);
  const unresolvedUnmappedHighSalienceNodeIds = unmappedHighSalienceNodeIds.filter(
    (nodeId) => !acceptedUnmappedHighSalience.has(nodeId)
  );
  const unmappedAuthoredNodeIds = authored.filter((item) => !mappedNodeIds.has(item.nodeId)).map((item) => item.nodeId);
  const mappedHighSalienceNodeCount = highSalience.length - unmappedHighSalienceNodeIds.length;
  const mappedAuthoredNodeCount = authored.length - unmappedAuthoredNodeIds.length;
  const warnings: string[] = [];
  for (const [index, proposal] of options.proposal.constellations.entries()) {
    const constellation = constellations[index]!;
    if (proposal.atlasRole !== constellation.atlasRole) {
      warnings.push(`${proposal.key}: downgraded core_direction to active_exploration because evidence is conversation-only.`);
    }
  }
  if (unresolvedUnmappedHighSalienceNodeIds.length > 0) {
    warnings.push(`${unresolvedUnmappedHighSalienceNodeIds.length} high-salience nodes are unexpectedly unmapped.`);
  }
  if (unmappedAuthoredNodeIds.length > 0) warnings.push(`${unmappedAuthoredNodeIds.length} authored or mixed nodes are unmapped.`);
  const overlapNodeCount = Array.from(membershipCounts.values()).filter((count) => count > 1).length;
  for (let leftIndex = 0; leftIndex < constellations.length; leftIndex += 1) {
    const left = constellations[leftIndex]!;
    const leftIds = new Set(left.memberNodeIds);
    for (let rightIndex = leftIndex + 1; rightIndex < constellations.length; rightIndex += 1) {
      const right = constellations[rightIndex]!;
      const overlap = right.memberNodeIds.filter((nodeId) => leftIds.has(nodeId)).length;
      const union = left.memberNodeIds.length + right.memberNodeIds.length - overlap;
      const jaccard = overlap / Math.max(1, union);
      if (jaccard > DEFAULTS.maxPairwiseConstellationJaccard) {
        warnings.push(
          `${left.title} and ${right.title} have high pairwise overlap (${roundShare(jaccard)} Jaccard).`
        );
      }
    }
  }

  const entrypointConstellationIds = constellations
    .filter((item) => item.atlasRole === "core_direction")
    .slice()
    .sort((left, right) => right.salienceScore - left.salienceScore || left.id.localeCompare(right.id))
    .slice(0, Math.min(6, constellations.length))
    .map((item) => item.id);

  const buildZoomItems = (
    predicate: (member: ThoughtMacroConstellation["members"][number]) => boolean
  ): ThoughtMacroZoomItem[] => {
    const constellationIdsByNodeId = new Map<string, Set<string>>();
    for (const constellation of constellations) {
      for (const member of constellation.members.filter(predicate)) {
        const ids = constellationIdsByNodeId.get(member.nodeId) ?? new Set<string>();
        ids.add(constellation.id);
        constellationIdsByNodeId.set(member.nodeId, ids);
      }
    }
    return Array.from(constellationIdsByNodeId.entries())
      .map(([nodeId, constellationIds]) => {
        const assessment = assessmentById.get(nodeId)!;
        return {
          nodeId,
          title: nodeById.get(nodeId)!.title,
          constellationIds: Array.from(constellationIds).sort(),
          salienceScore: assessment.salienceScore,
          sourceAuthority: assessment.sourceAuthority
        };
      })
      .sort((left, right) => right.salienceScore - left.salienceScore || left.nodeId.localeCompare(right.nodeId));
  };
  const currentPositions = buildZoomItems((member) => member.currentPosition);
  const openQuestions = buildZoomItems((member) => member.openQuestion);
  const openTensions = buildZoomItems((member) => member.tension);

  return {
    schemaVersion: 1,
    contractVersion: DEFAULTS.contractVersion,
    generatedAt: new Date().toISOString(),
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    iterationLabel: options.iterationLabel,
    sourceConsolidatedGraphPath: options.graphPath,
    sourceConsolidatedGraphHash: options.graphHash,
    sourceConsolidatedGraphSemanticHash: options.graphSemanticHash,
    sourceFrameAlignmentPath: options.alignmentPath,
    sourceFrameAlignmentHash: options.alignmentHash,
    sourceFrameAlignmentSemanticHash: options.alignmentSemanticHash,
    sourceNodeCount: options.graph.nodeCount,
    atlas: {
      title: options.proposal.atlasTitle,
      summary: options.proposal.atlasSummary,
      constellationIds: constellations.map((item) => item.id),
      entrypointConstellationIds,
      trajectoryIds: [],
      currentPositionNodeIds: currentPositions.slice(0, 12).map((item) => item.nodeId),
      openQuestionNodeIds: openQuestions.slice(0, 12).map((item) => item.nodeId),
      openTensionNodeIds: openTensions.slice(0, 12).map((item) => item.nodeId)
    },
    constellations,
    trajectories: [],
    currentPositions,
    openQuestions,
    openTensions,
    nodeAssessments: options.assessments,
    quality: {
      constellationCount: constellations.length,
      trajectoryCount: 0,
      mappedNodeCount: mappedNodeIds.size,
      mappedNodeShare: roundShare(mappedNodeIds.size / Math.max(1, options.graph.nodeCount)),
      overlapNodeCount,
      highSalienceNodeCount: highSalience.length,
      mappedHighSalienceNodeCount,
      mappedHighSalienceShare: roundShare(mappedHighSalienceNodeCount / Math.max(1, highSalience.length)),
      authoredNodeCount: authored.length,
      mappedAuthoredNodeCount,
      mappedAuthoredShare: roundShare(mappedAuthoredNodeCount / Math.max(1, authored.length)),
      unmappedNodeIds,
      unmappedHighSalienceNodeIds,
      acceptedUnmappedHighSalienceNodeIds,
      unmappedAuthoredNodeIds,
      proposalRepairs: options.proposalRepairs ?? [],
      warnings
    }
  };
}

export function buildTrajectoryPrompt(
  artifact: ThoughtMacroMapArtifact,
  graph: ConsolidatedThoughtGraph
): string {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const assessmentById = new Map(artifact.nodeAssessments.map((item) => [item.nodeId, item]));
  const constellations = artifact.constellations.map((constellation) => ({
    id: constellation.id,
    title: constellation.title,
    summary: constellation.summary,
    atlasRole: constellation.atlasRole,
    entrypoint: artifact.atlas.entrypointConstellationIds.includes(constellation.id),
    confidence: constellation.confidence,
    members: constellation.members
      .slice()
      .sort((left, right) => {
        const priority = (member: ThoughtMacroConstellation["members"][number]): number => {
          if (member.currentPosition) return 0;
          if (member.role === "core") return 1;
          if (member.tension) return 2;
          if (member.openQuestion) return 3;
          return 4;
        };
        const priorityDelta = priority(left) - priority(right);
        if (priorityDelta !== 0) return priorityDelta;
        return (assessmentById.get(right.nodeId)?.salienceScore ?? 0) -
          (assessmentById.get(left.nodeId)?.salienceScore ?? 0);
      })
      .slice(0, DEFAULTS.trajectoryEvidencePerConstellation)
      .map((member) => {
      const node = nodeById.get(member.nodeId)!;
      return {
        id: node.id,
        title: node.title,
        firstSeen: node.firstSeen,
        lastSeen: node.lastSeen,
        role: member.role,
        sourceAuthority: assessmentById.get(member.nodeId)?.sourceAuthority,
        currentPosition: member.currentPosition,
        openQuestion: member.openQuestion,
        tension: member.tension
      };
      })
  }));

  return [
    "Vytvoř explicitní vývojové trajektorie nad hotovou makro mapou osobního myšlení.",
    "Výstup musí být česky a přesně odpovídat JSON schematu.",
    "Všechny potřebné podklady jsou v tomto promptu. Nepoužívej nástroje, shell, soubory, memory ani web; rovnou vrať pouze výsledný JSON.",
    "",
    "PRAVIDLA",
    "- Trajektorie není tematický seznam. Vytvoř ji jen tam, kde podklady ukazují skutečnou časovou nebo konceptuální změnu postoje.",
    "- Vyber 2-8 nejsilnějších trajektorií; není povinné pokrýt každou konstelaci.",
    "- U velkého atlasu hlídej tematickou šíři podle skutečné evidence napříč konstelacemi. Žádnou oblast nepřidávej ani neupřednostňuj předem.",
    "- Když jedna vývojová linie skutečně prochází více konstelacemi, uveď všechny a postav jednu společnou trajektorii místo izolovaných tematických seznamů.",
    "- Upřednostni autorské a mixed uzly a entrypoint konstelace; conversation-only detail sám o sobě vývojovou linii nezakládá.",
    "- Každá trajektorie musí mít 2-6 odlišných, smysluplně seřazených stages.",
    "- Používej pouze přesná constellation a node ID z podkladů.",
    "- Node ID ve stages musí patřit alespoň do jedné uvedené konstelace a nesmí se opakovat mezi stages.",
    "- currentPositionNodeIds vybírej pouze z uzlů označených currentPosition; openTensionNodeIds pouze z tension uzlů.",
    "- Datum neodhaduj. Pokud podklady nemají použitelný čas, vrať null a pořadí zdůvodni konceptuálním vývojem v summary.",
    "- confidence hodnotí důkaz skutečného vývoje; uncertainty stručně zachytí, kde je pořadí nebo interpretace nejistá.",
    "",
    "MAKRO MAPA",
    JSON.stringify({ constellations })
  ].join("\n");
}

export function validateMacroTrajectories(
  proposal: MacroTrajectoryProposal,
  artifact: ThoughtMacroMapArtifact
): MacroTrajectoryProposal {
  const normalizeStableId = (value: string, validIds: string[]): string => {
    if (validIds.includes(value)) return value;
    const stablePrefix = value.split(":").slice(0, 2).join(":");
    const candidates = validIds.filter((item) =>
      item.split(":").slice(0, 2).join(":") === stablePrefix
    );
    if (candidates.length === 1) return candidates[0]!;
    const readableSuffix = value.split(":").slice(2).join(":");
    const suffixCandidates = validIds.filter((item) =>
      item.split(":").slice(2).join(":") === readableSuffix
    );
    return suffixCandidates.length === 1 ? suffixCandidates[0]! : value;
  };
  const validConstellationIds = artifact.constellations.map((item) => item.id);
  const validNodeIds = artifact.nodeAssessments.map((item) => item.nodeId);
  const normalizedProposal: MacroTrajectoryProposal = {
    trajectories: proposal.trajectories.map((trajectory) => ({
      ...trajectory,
      constellationIds: trajectory.constellationIds.map((id) =>
        normalizeStableId(id, validConstellationIds)
      ),
      stages: trajectory.stages.map((stage) => ({
        ...stage,
        nodeIds: stage.nodeIds.map((id) => normalizeStableId(id, validNodeIds))
      })),
      currentPositionNodeIds: trajectory.currentPositionNodeIds.map((id) =>
        normalizeStableId(id, validNodeIds)
      ),
      openTensionNodeIds: trajectory.openTensionNodeIds.map((id) =>
        normalizeStableId(id, validNodeIds)
      )
    }))
  };

  if (normalizedProposal.trajectories.length < 2 || normalizedProposal.trajectories.length > 8) {
    throw new Error("Macro map must contain 2-8 trajectories.");
  }
  const constellationById = new Map(artifact.constellations.map((item) => [item.id, item]));
  const currentNodeIds = new Set(artifact.currentPositions.map((item) => item.nodeId));
  const tensionNodeIds = new Set(artifact.openTensions.map((item) => item.nodeId));
  const keys = new Set<string>();

  for (const trajectory of normalizedProposal.trajectories) {
    if (keys.has(trajectory.key)) throw new Error(`Duplicate trajectory key: ${trajectory.key}`);
    keys.add(trajectory.key);
    assertUnique(trajectory.constellationIds, `${trajectory.key}.constellationIds`);
    const allowedNodeIds = new Set<string>();
    for (const constellationId of trajectory.constellationIds) {
      const constellation = constellationById.get(constellationId);
      if (!constellation) throw new Error(`${trajectory.key} references unknown constellation ${constellationId}.`);
      constellation.memberNodeIds.forEach((nodeId) => allowedNodeIds.add(nodeId));
    }
    const stagedNodeIds = trajectory.stages.flatMap((stage) => stage.nodeIds);
    assertUnique(stagedNodeIds, `${trajectory.key} stage nodes`);
    if (stagedNodeIds.some((nodeId) => !allowedNodeIds.has(nodeId))) {
      throw new Error(`${trajectory.key} contains a stage node outside its constellations.`);
    }
    assertUnique(trajectory.currentPositionNodeIds, `${trajectory.key}.currentPositionNodeIds`);
    if (trajectory.currentPositionNodeIds.some((nodeId) => !allowedNodeIds.has(nodeId) || !currentNodeIds.has(nodeId))) {
      throw new Error(`${trajectory.key} current positions must use surfaced current-position nodes.`);
    }
    assertUnique(trajectory.openTensionNodeIds, `${trajectory.key}.openTensionNodeIds`);
    if (trajectory.openTensionNodeIds.some((nodeId) => !allowedNodeIds.has(nodeId) || !tensionNodeIds.has(nodeId))) {
      throw new Error(`${trajectory.key} tensions must use surfaced tension nodes.`);
    }
  }
  return normalizedProposal;
}

export function attachTrajectories(
  artifact: ThoughtMacroMapArtifact,
  proposal: MacroTrajectoryProposal
): ThoughtMacroMapArtifact {
  const trajectories = proposal.trajectories.map((trajectory) => {
    const nodeIds = uniqueSorted(trajectory.stages.flatMap((stage) => stage.nodeIds));
    return {
      id: `trajectory:${hashText(nodeIds.join("\n")).slice(0, 10)}:${slugify(trajectory.key) || "development"}`,
      title: trajectory.title,
      summary: trajectory.summary,
      constellationIds: uniqueSorted(trajectory.constellationIds),
      stages: trajectory.stages.map((stage) => ({
        ...stage,
        nodeIds: uniqueSorted(stage.nodeIds)
      })),
      currentPositionNodeIds: uniqueSorted(trajectory.currentPositionNodeIds),
      openTensionNodeIds: uniqueSorted(trajectory.openTensionNodeIds),
      confidence: roundScore(trajectory.confidence),
      uncertainty: trajectory.uncertainty
    } satisfies ThoughtMacroTrajectory;
  });
  return {
    ...artifact,
    atlas: {
      ...artifact.atlas,
      trajectoryIds: trajectories.map((item) => item.id)
    },
    trajectories,
    quality: {
      ...artifact.quality,
      trajectoryCount: trajectories.length
    }
  };
}

export function buildMacroMapReport(artifact: ThoughtMacroMapArtifact): string {
  const lines = [
    "# Thought Macro Map",
    "",
    `- Iteration: ${artifact.iterationLabel}`,
    `- Model: ${artifact.model ?? "default"} / ${artifact.reasoningEffort}`,
    `- Source nodes: ${artifact.sourceNodeCount}`,
    `- Constellations: ${artifact.quality.constellationCount}`,
    `- Trajectories: ${artifact.quality.trajectoryCount}`,
    `- Mapped nodes: ${artifact.quality.mappedNodeCount} (${Math.round(artifact.quality.mappedNodeShare * 100)}%)`,
    `- High-salience coverage: ${artifact.quality.mappedHighSalienceNodeCount}/${artifact.quality.highSalienceNodeCount}`,
    `- Accepted high-salience omissions: ${artifact.quality.acceptedUnmappedHighSalienceNodeIds.length}`,
    `- Authored coverage: ${artifact.quality.mappedAuthoredNodeCount}/${artifact.quality.authoredNodeCount}`,
    `- Overlap nodes: ${artifact.quality.overlapNodeCount}`,
    "",
    "## Atlas",
    "",
    `# ${artifact.atlas.title}`,
    "",
    artifact.atlas.summary,
    "",
    "## Quality Warnings",
    ""
  ];
  if (artifact.quality.warnings.length === 0) lines.push("- None.");
  else artifact.quality.warnings.forEach((warning) => lines.push(`- ${warning}`));
  lines.push("", "## Proposal Repairs", "");
  if (artifact.quality.proposalRepairs.length === 0) lines.push("- None.");
  else artifact.quality.proposalRepairs.forEach((repair) => lines.push(`- ${repair}`));
  lines.push("", "## Constellations", "");
  for (const constellation of artifact.constellations) {
    const coreCount = constellation.members.filter((member) => member.role === "core").length;
    const currentCount = constellation.members.filter((member) => member.currentPosition).length;
    const questionCount = constellation.members.filter((member) => member.openQuestion).length;
    const tensionCount = constellation.members.filter((member) => member.tension).length;
    lines.push(
      `### ${constellation.title}`,
      "",
      constellation.summary,
      "",
      `- ID: \`${constellation.id}\``,
      `- Members: ${constellation.memberNodeIds.length}; core ${coreCount}; current ${currentCount}; questions ${questionCount}; tensions ${tensionCount}`,
      `- Salience: ${constellation.salienceScore}; authority: ${constellation.sourceAuthority}; documents: ${constellation.documentIds.length}`,
      `- Atlas role: ${constellation.atlasRole}; confidence: ${constellation.confidence}; uncertainty: ${constellation.uncertainty || "none"}`,
      `- Trajectory hint: ${constellation.trajectoryHint}`,
      `- Evidence: ${constellation.evidenceHighlights.map((item) => item.title).join(" | ")}`,
      ""
    );
  }
  lines.push("## Trajectories", "");
  if (artifact.trajectories.length === 0) {
    lines.push("- None.", "");
  } else {
    for (const trajectory of artifact.trajectories) {
      lines.push(
        `### ${trajectory.title}`,
        "",
        trajectory.summary,
        "",
        `- ID: \`${trajectory.id}\``,
        `- Stages: ${trajectory.stages.length}; confidence: ${trajectory.confidence}`,
        `- Current positions: ${trajectory.currentPositionNodeIds.length}; open tensions: ${trajectory.openTensionNodeIds.length}`,
        `- Uncertainty: ${trajectory.uncertainty || "none"}`,
        ""
      );
      trajectory.stages.forEach((stage, index) => {
        lines.push(`${index + 1}. **${stage.label}:** ${stage.summary}`);
      });
      lines.push("");
    }
  }
  lines.push(
    "## Zoom Surfaces",
    "",
    `- Current positions: ${artifact.currentPositions.length}`,
    `- Open questions: ${artifact.openQuestions.length}`,
    `- Open tensions: ${artifact.openTensions.length}`,
    ""
  );
  return `${lines.join("\n")}\n`;
}

export function buildThoughtMacroMap(options: {
  paths: ProjectPaths;
  client?: Pick<CodexCliClient, "execSemanticBatch">;
  model?: string;
  reasoningEffort: CodexReasoningEffort;
  iterationLabel: string;
  proposalPath?: string;
  trajectoryPath?: string;
}): ThoughtMacroMapSummary {
  const graphPath = path.join(options.paths.compiledDir, SECOND_BRAIN_DEFAULTS.thoughtConsolidation.compiledGraphFilename);
  const alignmentPath = path.join(options.paths.compiledDir, SECOND_BRAIN_DEFAULTS.thoughtFrameAlignment.compiledArtifactFilename);
  if (!existsSync(graphPath)) throw new Error(`Missing consolidated graph at ${graphPath}.`);
  const graphText = readFileSync(graphPath, "utf8");
  const graph = JSON.parse(graphText) as ConsolidatedThoughtGraph;
  const alignmentText = existsSync(alignmentPath) ? readFileSync(alignmentPath, "utf8") : null;
  const alignment = alignmentText ? JSON.parse(alignmentText) as ThoughtFrameAlignmentArtifact : null;
  const assessments = assessMacroNodes(graph);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(options.iterationLabel) || "iteration"}`;
  const runDir = path.join(options.paths.stateDir, DEFAULTS.stateDirname, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const schemaPath = writeJson(path.join(runDir, "thought-macro-map.schema.json"), MACRO_MAP_SCHEMA);
  const prompt = buildPrompt({ graph, alignment, assessments });
  writeFileSync(path.join(runDir, "prompt.txt"), `${prompt}\n`, "utf8");
  const rawProposal = options.proposalPath
    ? readJson<MacroMapProposal>(path.resolve(options.paths.root, options.proposalPath))
    : options.client?.execSemanticBatch<MacroMapProposal>({
        prompt,
        outputSchemaPath: schemaPath,
        workingDir: options.paths.root,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        extraWritableDirs: [options.paths.outputDir]
      }).parsed;
  if (!rawProposal) {
    throw new Error("Macro map generation requires a client or --proposal-path replay input.");
  }
  writeJson(path.join(runDir, "proposal.raw.json"), rawProposal);
  const validNodeIds = new Set(graph.nodes.map((node) => node.id));
  const normalized = normalizeProposalRoles(rawProposal, validNodeIds);
  const normalizedProposal = validateMacroMapProposal(normalized.proposal, validNodeIds);
  const coverageRepair = repairMacroMapCoverage({
    proposal: normalizedProposal,
    graph,
    assessments
  });
  const proposal = validateMacroMapProposal(coverageRepair.proposal, validNodeIds);
  const proposalRepairs = [...normalized.repairs, ...coverageRepair.repairs];
  writeJson(path.join(runDir, "proposal.json"), proposal);
  writeJson(path.join(runDir, "proposal_repairs.json"), proposalRepairs);
  let artifact = buildMacroMapArtifact({
    proposal,
    graph,
    assessments,
    model: options.model ?? null,
    reasoningEffort: options.reasoningEffort,
    iterationLabel: options.iterationLabel,
    graphPath,
    graphHash: hashText(graphText),
    alignmentPath: alignment ? alignmentPath : null,
    alignmentHash: alignmentText ? hashText(alignmentText) : null,
    proposalRepairs
  });
  const trajectorySchemaPath = writeJson(
    path.join(runDir, "thought-macro-trajectories.schema.json"),
    MACRO_TRAJECTORY_SCHEMA
  );
  const trajectoryPrompt = buildTrajectoryPrompt(artifact, graph);
  writeFileSync(path.join(runDir, "trajectory-prompt.txt"), `${trajectoryPrompt}\n`, "utf8");
  const rawTrajectoryProposal = options.trajectoryPath
    ? readJson<MacroTrajectoryProposal>(path.resolve(options.paths.root, options.trajectoryPath))
    : options.client?.execSemanticBatch<MacroTrajectoryProposal>({
        prompt: trajectoryPrompt,
        outputSchemaPath: trajectorySchemaPath,
        workingDir: options.paths.root,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        extraWritableDirs: [options.paths.outputDir]
      }).parsed;
  if (!rawTrajectoryProposal) {
    throw new Error("Macro trajectory generation requires a client or --trajectory-path replay input.");
  }
  writeJson(path.join(runDir, "trajectories.raw.json"), rawTrajectoryProposal);
  const trajectoryProposal = validateMacroTrajectories(rawTrajectoryProposal, artifact);
  writeJson(path.join(runDir, "trajectories.json"), trajectoryProposal);
  artifact = attachTrajectories(artifact, trajectoryProposal);
  const artifactPath = writeJson(path.join(options.paths.compiledDir, DEFAULTS.compiledArtifactFilename), artifact);
  const reportPath = path.join(options.paths.stateAuditsDir, DEFAULTS.markdownReportFilename);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, buildMacroMapReport(artifact), "utf8");
  writeJson(path.join(runDir, "artifact.json"), artifact);
  writeFileSync(path.join(runDir, "report.md"), buildMacroMapReport(artifact), "utf8");

  return {
    constellationCount: artifact.quality.constellationCount,
    trajectoryCount: artifact.quality.trajectoryCount,
    mappedNodeCount: artifact.quality.mappedNodeCount,
    mappedNodeShare: artifact.quality.mappedNodeShare,
    mappedHighSalienceShare: artifact.quality.mappedHighSalienceShare,
    mappedAuthoredShare: artifact.quality.mappedAuthoredShare,
    warningCount: artifact.quality.warnings.length,
    artifactPath,
    reportPath,
    runDir
  };
}
