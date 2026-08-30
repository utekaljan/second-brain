import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import type { ProjectPaths } from "../system/paths.js";
import { slugify } from "../utils/text.js";
import type {
  ConsolidatedThoughtGraph,
  ThoughtDocumentFrame,
  ThoughtDocumentFrameArtifact,
  ThoughtDocumentSubframe,
  ThoughtFrameAlignmentArtifact,
  ThoughtFrameAlignmentFamily,
  ThoughtFrameAlignmentSummary,
  ThoughtFrameRole,
  ThoughtHigherOrderPattern,
  ThoughtNodeType
} from "../compiler/types.js";
import { computeConsolidatedGraphSemanticHash } from "./artifact_identity.js";

const THOUGHT_COMPILER_DEFAULTS = SECOND_BRAIN_DEFAULTS.thoughtCompiler;
const THOUGHT_CONSOLIDATION_DEFAULTS = SECOND_BRAIN_DEFAULTS.thoughtConsolidation;
const THOUGHT_FRAME_ALIGNMENT_DEFAULTS = SECOND_BRAIN_DEFAULTS.thoughtFrameAlignment;

const STOPWORDS = new Set([
  "a",
  "aby",
  "ale",
  "ani",
  "as",
  "at",
  "bez",
  "by",
  "byt",
  "co",
  "cim",
  "do",
  "i",
  "ja",
  "je",
  "jsme",
  "jsou",
  "k",
  "kdyz",
  "ktery",
  "ma",
  "me",
  "mezi",
  "mi",
  "muze",
  "na",
  "nad",
  "ne",
  "nebo",
  "neni",
  "nez",
  "o",
  "od",
  "po",
  "pod",
  "pro",
  "proto",
  "se",
  "si",
  "tak",
  "take",
  "to",
  "tohle",
  "toto",
  "u",
  "uz",
  "v",
  "ve",
  "vsak",
  "vse",
  "z",
  "za",
  "ze",
  "the",
  "and",
  "for",
  "from",
  "of",
  "that",
  "this",
  "with",
  "jako",
  "skrze",
  "mezi",
  "vuci"
]);

type FrameSupportMembership = {
  frameId: string;
  frameLabel: string;
  subframeId: string | null;
  subframeLabel: string | null;
  frameRole: ThoughtFrameRole | null;
  occurrenceCount: number;
};

type FrameFeature = {
  frame: ThoughtDocumentFrame;
  subframes: ThoughtDocumentSubframe[];
  labelTokens: string[];
  anchorTokens: string[];
  anchorNodeIds: Set<string>;
  nodeIds: Set<string>;
  nodeTitles: Set<string>;
  nodeTypes: Set<ThoughtNodeType>;
  relatedNodeIds: Set<string>;
  subframeIds: Set<string>;
  subframeLabels: Set<string>;
  frameRoles: Set<ThoughtFrameRole>;
  supportWeight: number;
};

type FamilyFeature = {
  family: ThoughtFrameAlignmentFamily;
  labelTokens: string[];
  contextualTokens: string[];
  nodeIds: Set<string>;
  relatedNodeIds: Set<string>;
};

class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(value: number): number {
    if (this.parent[value] === value) {
      return value;
    }

    const next = this.find(this.parent[value] ?? value);
    this.parent[value] = next;
    return next;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) {
      this.parent[rightRoot] = leftRoot;
    }
  }
}

function tokenize(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) {
    return 1;
  }

  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection += 1;
    }
  }

  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function intersectCount(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) {
      count += 1;
    }
  }
  return count;
}

function frameRoleWeight(role: ThoughtFrameRole | null): number {
  switch (role) {
    case "main_claim":
      return 3;
    case "revision_branch":
      return 2.5;
    case "question":
    case "tension":
      return 2;
    case "subclaim":
      return 1;
    default:
      return 1;
  }
}

function buildAnchorTokens(texts: string[]): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const token of tokenize(text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((left, right) => {
      if (left[1] !== right[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })
    .slice(0, THOUGHT_FRAME_ALIGNMENT_DEFAULTS.maxAnchorTokens)
    .map(([token]) => token);
}

function readJsonFile<T>(target: string): T {
  return JSON.parse(readFileSync(target, "utf8")) as T;
}

function loadAlignmentInputs(paths: ProjectPaths): {
  documentFrames: ThoughtDocumentFrameArtifact;
  consolidatedGraph: ConsolidatedThoughtGraph;
  documentFramesPath: string;
  consolidatedGraphPath: string;
} {
  const documentFramesPath = path.join(
    paths.compiledDir,
    THOUGHT_COMPILER_DEFAULTS.compiledDocumentFramesFilename
  );
  const consolidatedGraphPath = path.join(
    paths.compiledDir,
    THOUGHT_CONSOLIDATION_DEFAULTS.compiledGraphFilename
  );

  return {
    documentFrames: readJsonFile<ThoughtDocumentFrameArtifact>(documentFramesPath),
    consolidatedGraph: readJsonFile<ConsolidatedThoughtGraph>(consolidatedGraphPath),
    documentFramesPath,
    consolidatedGraphPath
  };
}

function buildFrameFeatures(
  documentFrames: ThoughtDocumentFrameArtifact,
  consolidatedGraph: ConsolidatedThoughtGraph
): FrameFeature[] {
  const writingFrames = documentFrames.frames.filter((frame) => frame.sourceKind === "writing");
  const writingFrameIds = new Set(writingFrames.map((frame) => frame.id));
  const subframesByFrameId = new Map<string, ThoughtDocumentSubframe[]>();
  for (const subframe of documentFrames.subframes) {
    if (!writingFrameIds.has(subframe.frameId)) {
      continue;
    }
    const bucket = subframesByFrameId.get(subframe.frameId) ?? [];
    bucket.push(subframe);
    subframesByFrameId.set(subframe.frameId, bucket);
  }

  const membershipsByFrameId = new Map<
    string,
    Array<{
      nodeId: string;
      nodeTitle: string;
      nodeType: ThoughtNodeType;
      relatedNodeIds: string[];
      membership: FrameSupportMembership;
    }>
  >();

  for (const node of consolidatedGraph.nodes) {
    for (const membership of node.frameMemberships ?? []) {
      if (!writingFrameIds.has(membership.frameId)) {
        continue;
      }
      const bucket = membershipsByFrameId.get(membership.frameId) ?? [];
      bucket.push({
        nodeId: node.id,
        nodeTitle: node.title,
        nodeType: node.nodeType,
        relatedNodeIds: node.relatedNodeIds,
        membership
      });
      membershipsByFrameId.set(membership.frameId, bucket);
    }
  }

  return writingFrames.map((frame) => {
    const subframes = subframesByFrameId.get(frame.id) ?? [];
    const supports = membershipsByFrameId.get(frame.id) ?? [];
    const nodeIds = new Set<string>();
    const nodeTitles = new Set<string>();
    const nodeTypes = new Set<ThoughtNodeType>();
    const relatedNodeIds = new Set<string>();
    const subframeIds = new Set<string>();
    const subframeLabels = new Set<string>();
    const frameRoles = new Set<ThoughtFrameRole>();
    let supportWeight = 0;
    const weightedSupportByNodeId = new Map<string, number>();

    for (const subframe of subframes) {
      subframeIds.add(subframe.id);
      subframeLabels.add(subframe.label);
    }

    for (const support of supports) {
      nodeIds.add(support.nodeId);
      nodeTitles.add(support.nodeTitle);
      nodeTypes.add(support.nodeType);
      support.relatedNodeIds.forEach((relatedNodeId) => relatedNodeIds.add(relatedNodeId));
      supportWeight += support.membership.occurrenceCount;
      weightedSupportByNodeId.set(
        support.nodeId,
        (weightedSupportByNodeId.get(support.nodeId) ?? 0) +
          support.membership.occurrenceCount * frameRoleWeight(support.membership.frameRole)
      );
      if (support.membership.subframeId) {
        subframeIds.add(support.membership.subframeId);
      }
      if (support.membership.subframeLabel) {
        subframeLabels.add(support.membership.subframeLabel);
      }
      if (support.membership.frameRole) {
        frameRoles.add(support.membership.frameRole);
      }
    }

    const anchorNodeIds = new Set(
      Array.from(weightedSupportByNodeId.entries())
        .sort((left, right) => {
          if (left[1] !== right[1]) {
            return right[1] - left[1];
          }
          return left[0].localeCompare(right[0]);
        })
        .slice(0, 2)
        .map(([nodeId]) => nodeId)
    );

    return {
      frame,
      subframes,
      labelTokens: tokenize(frame.label),
      anchorTokens: [
        ...tokenize(frame.label),
        ...subframes.flatMap((subframe) => tokenize(subframe.label)),
        ...Array.from(nodeTitles).flatMap((title) => tokenize(title))
      ],
      anchorNodeIds,
      nodeIds,
      nodeTitles,
      nodeTypes,
      relatedNodeIds,
      subframeIds,
      subframeLabels,
      frameRoles,
      supportWeight
    };
  });
}

function framePairShouldMerge(left: FrameFeature, right: FrameFeature): boolean {
  if (left.frame.documentId === right.frame.documentId) {
    return false;
  }

  const sharedAnchorNodeCount = intersectCount(left.anchorNodeIds, right.anchorNodeIds);
  const sharedNodeCount = intersectCount(left.nodeIds, right.nodeIds);
  const nodeOverlapRatio =
    Math.min(left.nodeIds.size, right.nodeIds.size) === 0
      ? 0
      : sharedNodeCount / Math.min(left.nodeIds.size, right.nodeIds.size);
  const labelScore = jaccard(new Set(left.labelTokens), new Set(right.labelTokens));
  const anchorScore = jaccard(new Set(left.anchorTokens), new Set(right.anchorTokens));

  if (sharedAnchorNodeCount >= 1 && nodeOverlapRatio >= 0.5 && anchorScore >= 0.14) {
    return true;
  }

  if (
    sharedNodeCount >= THOUGHT_FRAME_ALIGNMENT_DEFAULTS.familySharedNodeThreshold &&
    nodeOverlapRatio >= 0.5 &&
    labelScore >= THOUGHT_FRAME_ALIGNMENT_DEFAULTS.familyLexicalThreshold
  ) {
    return true;
  }

  return false;
}

function buildAlignedFamilies(frameFeatures: FrameFeature[]): ThoughtFrameAlignmentFamily[] {
  const unionFind = new UnionFind(frameFeatures.length);

  for (let leftIndex = 0; leftIndex < frameFeatures.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < frameFeatures.length; rightIndex += 1) {
      if (framePairShouldMerge(frameFeatures[leftIndex]!, frameFeatures[rightIndex]!)) {
        unionFind.union(leftIndex, rightIndex);
      }
    }
  }

  const groups = new Map<number, FrameFeature[]>();
  frameFeatures.forEach((feature, index) => {
    const root = unionFind.find(index);
    const bucket = groups.get(root) ?? [];
    bucket.push(feature);
    groups.set(root, bucket);
  });

  return Array.from(groups.values())
    .map((group, index) => {
      const representative = group
        .slice()
        .sort((left, right) => {
          const leftCrossSupport = group.reduce(
            (sum, candidate) => sum + intersectCount(left.nodeIds, candidate.nodeIds),
            0
          );
          const rightCrossSupport = group.reduce(
            (sum, candidate) => sum + intersectCount(right.nodeIds, candidate.nodeIds),
            0
          );

          if (leftCrossSupport !== rightCrossSupport) {
            return rightCrossSupport - leftCrossSupport;
          }
          if (left.supportWeight !== right.supportWeight) {
            return right.supportWeight - left.supportWeight;
          }
          return left.frame.label.localeCompare(right.frame.label);
        })[0]!;

      const memberFrameIds = group.map((feature) => feature.frame.id).sort((left, right) =>
        left.localeCompare(right)
      );
      const memberDocumentIds = Array.from(
        new Set(group.map((feature) => feature.frame.documentId))
      ).sort((left, right) => left.localeCompare(right));
      const memberSubframeIds = Array.from(
        new Set(group.flatMap((feature) => Array.from(feature.subframeIds)))
      ).sort((left, right) => left.localeCompare(right));
      const memberFrameLabels = Array.from(
        new Set(group.map((feature) => feature.frame.label))
      ).sort((left, right) => left.localeCompare(right));
      const memberSubframeLabels = Array.from(
        new Set(group.flatMap((feature) => Array.from(feature.subframeLabels)))
      ).sort((left, right) => left.localeCompare(right));
      const memberNodeIds = Array.from(
        new Set(group.flatMap((feature) => Array.from(feature.nodeIds)))
      ).sort((left, right) => left.localeCompare(right));
      const memberNodeTitles = Array.from(
        new Set(group.flatMap((feature) => Array.from(feature.nodeTitles)))
      ).sort((left, right) => left.localeCompare(right));
      const memberNodeTypes = Array.from(
        new Set(group.flatMap((feature) => Array.from(feature.nodeTypes)))
      ).sort((left, right) => left.localeCompare(right)) as ThoughtNodeType[];
      const memberFrameRoles = Array.from(
        new Set(group.flatMap((feature) => Array.from(feature.frameRoles)))
      ).sort((left, right) => left.localeCompare(right)) as ThoughtFrameRole[];
      const anchorTokens = buildAnchorTokens([
        ...memberFrameLabels,
        ...memberSubframeLabels,
        ...memberNodeTitles
      ]);
      const cohesionScore =
        group.length === 1
          ? representative.supportWeight
          : group.reduce((sum, feature, featureIndex) => {
              const peerScore = group.reduce((innerSum, peer, peerIndex) => {
                if (featureIndex === peerIndex) {
                  return innerSum;
                }
                return innerSum + intersectCount(feature.nodeIds, peer.nodeIds);
              }, 0);
              return sum + peerScore;
            }, 0);

      return {
        id: `frame-family:${String(index + 1).padStart(4, "0")}:${slugify(representative.frame.label) || "rodina"}`,
        label: representative.frame.label,
        representativeFrameId: representative.frame.id,
        representativeDocumentId: representative.frame.documentId,
        anchorTokens,
        memberFrameIds,
        memberDocumentIds,
        memberSubframeIds,
        memberFrameLabels,
        memberSubframeLabels,
        memberNodeIds,
        memberNodeTitles,
        memberNodeTypes,
        memberFrameRoles,
        supportingNodeCount: memberNodeIds.length,
        cohesionScore
      } satisfies ThoughtFrameAlignmentFamily;
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

function buildFamilyFeatures(
  families: ThoughtFrameAlignmentFamily[],
  consolidatedGraph: ConsolidatedThoughtGraph
): FamilyFeature[] {
  const nodeById = new Map(consolidatedGraph.nodes.map((node) => [node.id, node]));

  return families.map((family) => {
    const relatedNodeIds = new Set<string>();
    for (const nodeId of family.memberNodeIds) {
      for (const relatedNodeId of nodeById.get(nodeId)?.relatedNodeIds ?? []) {
        relatedNodeIds.add(relatedNodeId);
      }
    }

    return {
      family,
      labelTokens: tokenize(family.label),
      contextualTokens: [
        ...tokenize(family.label),
        ...family.memberFrameLabels.flatMap((label) => tokenize(label)),
        ...family.memberSubframeLabels.flatMap((label) => tokenize(label)),
        ...family.memberNodeTitles.flatMap((title) => tokenize(title))
      ],
      nodeIds: new Set(family.memberNodeIds),
      relatedNodeIds
    };
  });
}

function familyPairShouldMerge(left: FamilyFeature, right: FamilyFeature): boolean {
  if (left.family.id === right.family.id) {
    return false;
  }

  const sharedNodeCount = intersectCount(left.nodeIds, right.nodeIds);
  const sharedRelatedNodeCount = intersectCount(left.relatedNodeIds, right.relatedNodeIds);
  const labelScore = jaccard(new Set(left.labelTokens), new Set(right.labelTokens));
  const contextualScore = jaccard(
    new Set(left.contextualTokens),
    new Set(right.contextualTokens)
  );

  if (sharedNodeCount >= THOUGHT_FRAME_ALIGNMENT_DEFAULTS.patternSharedNodeThreshold && sharedNodeCount >= 2) {
    return true;
  }

  if (
    sharedNodeCount >= THOUGHT_FRAME_ALIGNMENT_DEFAULTS.patternSharedNodeThreshold &&
    (labelScore >= THOUGHT_FRAME_ALIGNMENT_DEFAULTS.patternLexicalThreshold ||
      contextualScore >= THOUGHT_FRAME_ALIGNMENT_DEFAULTS.patternContextualThreshold)
  ) {
    return true;
  }

  if (
    sharedNodeCount >= 1 &&
    sharedRelatedNodeCount >= THOUGHT_FRAME_ALIGNMENT_DEFAULTS.patternRelatedNodeThreshold &&
    contextualScore >= THOUGHT_FRAME_ALIGNMENT_DEFAULTS.patternLexicalThreshold
  ) {
    return true;
  }

  return false;
}

function buildHigherOrderPatterns(
  families: ThoughtFrameAlignmentFamily[],
  consolidatedGraph: ConsolidatedThoughtGraph
): ThoughtHigherOrderPattern[] {
  const features = buildFamilyFeatures(families, consolidatedGraph);
  const unionFind = new UnionFind(features.length);

  for (let leftIndex = 0; leftIndex < features.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < features.length; rightIndex += 1) {
      if (familyPairShouldMerge(features[leftIndex]!, features[rightIndex]!)) {
        unionFind.union(leftIndex, rightIndex);
      }
    }
  }

  const groups = new Map<number, FamilyFeature[]>();
  features.forEach((feature, index) => {
    const root = unionFind.find(index);
    const bucket = groups.get(root) ?? [];
    bucket.push(feature);
    groups.set(root, bucket);
  });

  return Array.from(groups.values())
    .filter((group) => group.length > 1)
    .map((group, index) => {
      const representative = group
        .slice()
        .sort((left, right) => {
          const leftCrossSupport = group.reduce(
            (sum, candidate) => sum + intersectCount(left.nodeIds, candidate.nodeIds),
            0
          );
          const rightCrossSupport = group.reduce(
            (sum, candidate) => sum + intersectCount(right.nodeIds, candidate.nodeIds),
            0
          );
          if (leftCrossSupport !== rightCrossSupport) {
            return rightCrossSupport - leftCrossSupport;
          }
          return left.family.label.localeCompare(right.family.label);
        })[0]!;

      const familyIds = group.map((feature) => feature.family.id).sort((left, right) =>
        left.localeCompare(right)
      );
      const familyLabels = group.map((feature) => feature.family.label).sort((left, right) =>
        left.localeCompare(right)
      );
      const documentIds = Array.from(
        new Set(group.flatMap((feature) => feature.family.memberDocumentIds))
      ).sort((left, right) => left.localeCompare(right));
      const nodeIds = Array.from(
        new Set(group.flatMap((feature) => feature.family.memberNodeIds))
      ).sort((left, right) => left.localeCompare(right));
      const nodeTitles = Array.from(
        new Set(group.flatMap((feature) => feature.family.memberNodeTitles))
      ).sort((left, right) => left.localeCompare(right));
      const nodeTypes = Array.from(
        new Set(group.flatMap((feature) => feature.family.memberNodeTypes))
      ).sort((left, right) => left.localeCompare(right)) as ThoughtNodeType[];
      const anchorTokens = buildAnchorTokens([
        ...familyLabels,
        ...nodeTitles
      ]);
      const cohesionScore = group.reduce((sum, feature, featureIndex) => {
        const peerScore = group.reduce((innerSum, peer, peerIndex) => {
          if (featureIndex === peerIndex) {
            return innerSum;
          }
          return innerSum + intersectCount(feature.nodeIds, peer.nodeIds);
        }, 0);
        return sum + peerScore;
      }, 0);

      return {
        id: `frame-pattern:${String(index + 1).padStart(4, "0")}:${slugify(representative.family.label) || "pattern"}`,
        label: representative.family.label,
        representativeFamilyId: representative.family.id,
        anchorTokens,
        familyIds,
        familyLabels,
        documentIds,
        nodeIds,
        nodeTitles,
        nodeTypes,
        cohesionScore
      } satisfies ThoughtHigherOrderPattern;
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function buildThoughtFrameAlignmentArtifact(options: {
  documentFrames: ThoughtDocumentFrameArtifact;
  consolidatedGraph: ConsolidatedThoughtGraph;
  sourceDocumentFramesPath: string;
  sourceConsolidatedGraphPath: string;
}): ThoughtFrameAlignmentArtifact {
  const frameFeatures = buildFrameFeatures(options.documentFrames, options.consolidatedGraph);
  const families = buildAlignedFamilies(frameFeatures);
  const patterns = buildHigherOrderPatterns(families, options.consolidatedGraph);

  return {
    generatedAt: new Date().toISOString(),
    sourceDocumentFramesPath: options.sourceDocumentFramesPath,
    sourceConsolidatedGraphPath: options.sourceConsolidatedGraphPath,
    sourceConsolidatedGraphSemanticHash:
      computeConsolidatedGraphSemanticHash(options.consolidatedGraph),
    sourceFrameCount: options.documentFrames.frameCount,
    sourceSubframeCount: options.documentFrames.subframeCount,
    sourceConsolidatedNodeCount: options.consolidatedGraph.nodeCount,
    familyCount: families.length,
    patternCount: patterns.length,
    families,
    patterns
  };
}

function buildMarkdownReport(artifact: ThoughtFrameAlignmentArtifact): string {
  const lines: string[] = [
    "# Cross-Writing Frame Alignment",
    "",
    `- Generated: ${artifact.generatedAt}`,
    `- Source frames: \`${artifact.sourceDocumentFramesPath}\``,
    `- Source consolidated graph: \`${artifact.sourceConsolidatedGraphPath}\``,
    `- Main frames: ${artifact.sourceFrameCount}`,
    `- Subframes: ${artifact.sourceSubframeCount}`,
    `- Consolidated nodes: ${artifact.sourceConsolidatedNodeCount}`,
    `- Families: ${artifact.familyCount}`,
    `- Higher-order patterns: ${artifact.patternCount}`,
    "",
    "## Verdict",
    "",
    "- This artifact aligns local writing frames across documents without reusing the old graph-first vertical tree.",
    "- Families are the first shared parent layer above local writings.",
    "- Higher-order patterns are a second deterministic grouping layer above those families.",
    "",
    "## Largest Families",
    ""
  ];

  const largestFamilies = artifact.families
    .slice()
    .sort((left, right) => {
      if (left.memberDocumentIds.length !== right.memberDocumentIds.length) {
        return right.memberDocumentIds.length - left.memberDocumentIds.length;
      }
      if (left.supportingNodeCount !== right.supportingNodeCount) {
        return right.supportingNodeCount - left.supportingNodeCount;
      }
      return left.label.localeCompare(right.label);
    })
    .slice(0, 12);

  if (largestFamilies.length === 0) {
    lines.push("Žádné aligned families.");
  } else {
    for (const family of largestFamilies) {
      lines.push(`### ${family.label}`);
      lines.push("");
      lines.push(`- Documents: ${family.memberDocumentIds.length}`);
      lines.push(`- Frames: ${family.memberFrameIds.length}`);
      lines.push(`- Supporting nodes: ${family.supportingNodeCount}`);
      lines.push(`- Anchor tokens: ${family.anchorTokens.join(", ") || "n/a"}`);
      lines.push(`- Frame labels: ${family.memberFrameLabels.join(" | ")}`);
      lines.push("");
    }
  }

  lines.push("## Higher-Order Patterns", "");

  if (artifact.patterns.length === 0) {
    lines.push("Žádné multi-family patterns.");
  } else {
    for (const pattern of artifact.patterns
      .slice()
      .sort((left, right) => {
        if (left.familyIds.length !== right.familyIds.length) {
          return right.familyIds.length - left.familyIds.length;
        }
        return left.label.localeCompare(right.label);
      })
      .slice(0, 12)) {
      lines.push(`### ${pattern.label}`);
      lines.push("");
      lines.push(`- Families: ${pattern.familyIds.length}`);
      lines.push(`- Documents: ${pattern.documentIds.length}`);
      lines.push(`- Nodes: ${pattern.nodeIds.length}`);
      lines.push(`- Anchor tokens: ${pattern.anchorTokens.join(", ") || "n/a"}`);
      lines.push(`- Family labels: ${pattern.familyLabels.join(" | ")}`);
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

export function alignWritingFrames(paths: ProjectPaths): ThoughtFrameAlignmentSummary {
  const {
    documentFrames,
    consolidatedGraph,
    documentFramesPath,
    consolidatedGraphPath
  } = loadAlignmentInputs(paths);

  const artifact = buildThoughtFrameAlignmentArtifact({
    documentFrames,
    consolidatedGraph,
    sourceDocumentFramesPath: documentFramesPath,
    sourceConsolidatedGraphPath: consolidatedGraphPath
  });

  const artifactPath = path.join(
    paths.compiledDir,
    THOUGHT_FRAME_ALIGNMENT_DEFAULTS.compiledArtifactFilename
  );
  const reportPath = path.join(
    paths.stateAuditsDir,
    THOUGHT_FRAME_ALIGNMENT_DEFAULTS.markdownReportFilename
  );

  mkdirSync(path.dirname(artifactPath), { recursive: true });
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  writeFileSync(reportPath, buildMarkdownReport(artifact), "utf8");

  return {
    sourceFrameCount: artifact.sourceFrameCount,
    sourceSubframeCount: artifact.sourceSubframeCount,
    sourceConsolidatedNodeCount: artifact.sourceConsolidatedNodeCount,
    familyCount: artifact.familyCount,
    patternCount: artifact.patternCount,
    artifactPath,
    reportPath
  };
}
