import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type {
  ConsolidatedThoughtEdge,
  ConsolidatedThoughtGraph,
  ThoughtNodeStatus,
  ThoughtNodeType,
  ThoughtRelationType
} from "../compiler/types.js";
import type {
  MacroNodeAssessment,
  MacroNodeRole,
  ThoughtMacroConstellation,
  ThoughtMacroMapArtifact
} from "../structure/macro_map.js";
import type { ProjectPaths } from "../system/paths.js";
import { slugify } from "../utils/text.js";
import { GRAPH_EXPLORER_SCRIPT } from "./graph_client.js";

type GraphWikiPage = {
  title: string;
  path: string;
  kind: "index" | "thought" | "reference" | "constellation" | "trajectory";
  summary: string;
  nodeType?: ThoughtNodeType;
  nodeId?: string;
};

export type GraphExplorerNode = {
  id: string;
  title: string;
  summary: string;
  type: number;
  status: number;
  url: string;
  cluster: number;
  secondaryClusters: number[];
  x: number;
  y: number;
  size: number;
  salience: number;
  reveal: number;
  degree: number;
};

export type GraphExplorerEdge = [source: number, target: number, type: number, weight: number];

export type GraphExplorerCluster = {
  id: string;
  title: string;
  summary: string;
  color: string;
  x: number;
  y: number;
  radius: number;
  count: number;
  url: string | null;
  atlasRole: ThoughtMacroConstellation["atlasRole"] | "residual";
};

export type GraphExplorerClusterEdge = {
  source: number;
  target: number;
  count: number;
  weight: number;
  dominantType: number;
  typeCounts: number[];
};

export type GraphExplorerData = {
  version: 1;
  generatedAt: string;
  sourceRunId: string;
  title: string;
  summary: string;
  nodeTypes: ThoughtNodeType[];
  statuses: ThoughtNodeStatus[];
  relationTypes: ThoughtRelationType[];
  nodes: GraphExplorerNode[];
  edges: GraphExplorerEdge[];
  clusters: GraphExplorerCluster[];
  clusterEdges: GraphExplorerClusterEdge[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  stats: {
    nodeCount: number;
    edgeCount: number;
    clusterCount: number;
    atlasClusterCount: number;
    mappedNodeCount: number;
    overlapNodeCount: number;
  };
};

export type GraphExplorerRenderSummary = {
  pagePath: string;
  dataPath: string;
  scriptPath: string;
  stylePath: string;
  nodeCount: number;
  edgeCount: number;
  clusterCount: number;
  dataBytes: number;
};

const NODE_TYPES: ThoughtNodeType[] = ["thesis", "question", "theme", "tension", "thread"];
const STATUSES: ThoughtNodeStatus[] = ["active", "tentative", "unresolved", "revised"];
const RELATION_TYPES: ThoughtRelationType[] = [
  "semantic_related",
  "supports",
  "co_occurs",
  "tensions_with",
  "revises",
  "supersedes",
  "context_split"
];

const CLUSTER_COLORS = [
  "#63d5b5",
  "#ffb45d",
  "#8aa8ff",
  "#ef7fa7",
  "#b78cff",
  "#62c9ef",
  "#e7d36f",
  "#78db7b",
  "#ff876f",
  "#8ad6c1",
  "#d99df0",
  "#72a2c8",
  "#e7a75f",
  "#a9ce68",
  "#d88982",
  "#8c9ca7",
  "#7b8d99",
  "#9a8c83",
  "#778a80",
  "#8f8297"
];

const ROLE_SCORE: Record<MacroNodeRole, number> = {
  core: 3,
  supporting: 2,
  context: 1
};

const GRAPH_STYLE = `
:root {
  color-scheme: dark;
  --ink: #f3f5ef;
  --muted: #9ba9a4;
  --glass: rgba(13, 19, 18, 0.78);
  --line: rgba(212, 231, 221, 0.14);
  --accent: #63d5b5;
}

* { box-sizing: border-box; }
html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
body {
  background: #08100f;
  color: var(--ink);
  font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
}

.graph-shell {
  position: relative;
  width: 100%;
  height: 100%;
  isolation: isolate;
  background:
    radial-gradient(circle at 18% 12%, rgba(50, 128, 109, 0.20), transparent 35%),
    radial-gradient(circle at 80% 85%, rgba(92, 82, 160, 0.16), transparent 38%),
    linear-gradient(145deg, #07100e, #0b1115 55%, #090d12);
}

.graph-shell::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 3;
  opacity: 0.17;
  background:
    repeating-linear-gradient(17deg, rgba(255,255,255,.018) 0 1px, transparent 1px 5px),
    repeating-linear-gradient(103deg, rgba(99,213,181,.012) 0 1px, transparent 1px 7px);
  mix-blend-mode: soft-light;
}

#thought-graph { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1; }

.graph-header {
  position: absolute;
  z-index: 5;
  top: 24px;
  left: 24px;
  max-width: min(560px, calc(100vw - 48px));
  pointer-events: none;
  transition: transform .35s cubic-bezier(.2,.8,.2,1), opacity .25s ease;
}

.graph-kicker {
  margin-bottom: 7px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .18em;
  text-transform: uppercase;
}

.graph-header h1 {
  margin: 0;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(28px, 4vw, 54px);
  font-weight: 500;
  line-height: .98;
  letter-spacing: -.045em;
  text-wrap: balance;
  text-shadow: 0 8px 32px rgba(0, 0, 0, .35);
}

.graph-subtitle {
  max-width: 500px;
  margin: 11px 0 0;
  color: #afbbb6;
  font-size: 13px;
  line-height: 1.5;
  max-height: 100px;
  overflow: hidden;
  transition: opacity .2s ease, max-height .3s ease, margin .3s ease;
}

.graph-shell.is-exploring .graph-header { transform: translateY(-5px); }
.graph-shell.is-exploring .graph-header h1 { font-size: 23px; letter-spacing: -.025em; }
.graph-shell.is-exploring .graph-kicker { margin-bottom: 4px; font-size: 9px; }
.graph-shell.is-exploring .graph-subtitle { max-height: 0; margin-top: 0; opacity: 0; }

.graph-top-actions {
  position: absolute;
  z-index: 7;
  top: 22px;
  right: 22px;
  display: flex;
  gap: 8px;
}

.glass-button, .filter-button, .node-link {
  border: 1px solid var(--line);
  background: rgba(14, 22, 21, .75);
  color: var(--ink);
  backdrop-filter: blur(18px);
  border-radius: 999px;
  padding: 9px 13px;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  text-decoration: none;
  cursor: pointer;
  transition: border-color .2s ease, background .2s ease, transform .2s ease;
}
.glass-button:hover, .filter-button:hover, .node-link:hover {
  border-color: rgba(99, 213, 181, .52);
  background: rgba(28, 48, 43, .88);
  transform: translateY(-1px);
}

.graph-controls {
  position: absolute;
  z-index: 6;
  left: 24px;
  bottom: 22px;
  width: min(380px, calc(100vw - 48px));
  padding: 13px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: var(--glass);
  box-shadow: 0 22px 70px rgba(0, 0, 0, .32);
  backdrop-filter: blur(22px) saturate(1.15);
}

.graph-search-wrap { position: relative; }
#graph-search {
  width: 100%;
  border: 1px solid rgba(218, 235, 226, .15);
  border-radius: 12px;
  background: rgba(255,255,255,.055);
  color: var(--ink);
  padding: 11px 12px;
  outline: none;
  font: inherit;
  font-size: 13px;
}
#graph-search:focus { border-color: rgba(99, 213, 181, .62); }

.graph-search-results {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 8px);
  display: none;
  max-height: 260px;
  overflow: auto;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: rgba(9, 15, 15, .96);
  box-shadow: 0 20px 60px rgba(0,0,0,.45);
}
.graph-search-results.is-open { display: block; }
.graph-search-result {
  display: block;
  width: 100%;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--ink);
  padding: 9px 10px;
  text-align: left;
  cursor: pointer;
}
.graph-search-result:hover { background: rgba(99,213,181,.11); }
.graph-search-result span { display: block; color: var(--muted); font-size: 10px; margin-top: 2px; }

.filter-row { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
.filter-button { padding: 6px 9px; font-size: 10px; background: rgba(255,255,255,.045); }
.filter-button[aria-pressed="false"] { opacity: .4; filter: grayscale(.8); }
.filter-dot { display: inline-block; width: 7px; height: 7px; margin-right: 5px; border-radius: 50%; }

.graph-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
  color: var(--muted);
  font-size: 10px;
  letter-spacing: .04em;
}

.zoom-controls {
  position: absolute;
  z-index: 6;
  right: 22px;
  bottom: 22px;
  display: grid;
  gap: 7px;
}
.zoom-controls .glass-button { width: 40px; height: 40px; padding: 0; font-size: 18px; }

.node-panel {
  position: absolute;
  z-index: 8;
  top: 86px;
  right: 22px;
  width: min(370px, calc(100vw - 44px));
  max-height: calc(100vh - 165px);
  overflow: auto;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 21px;
  background: rgba(11, 18, 18, .9);
  box-shadow: 0 24px 80px rgba(0, 0, 0, .44);
  backdrop-filter: blur(24px) saturate(1.18);
  transform: translateX(calc(100% + 40px));
  opacity: 0;
  transition: transform .38s cubic-bezier(.2,.8,.2,1), opacity .25s ease;
}
.node-panel.is-open { transform: translateX(0); opacity: 1; }
.node-panel-close { position: absolute; top: 12px; right: 12px; }
.node-panel-kicker { color: var(--accent); font-size: 10px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
.node-panel h2 { margin: 8px 35px 10px 0; font-family: Georgia, serif; font-size: 27px; line-height: 1.06; font-weight: 500; }
.node-panel p { margin: 0; color: #b6c1bc; font-size: 13px; line-height: 1.55; }
.node-panel-meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0; }
.node-panel-meta span { border: 1px solid var(--line); border-radius: 99px; padding: 5px 8px; color: #c8d2cd; font-size: 10px; }
.node-link { display: inline-flex; margin-top: 16px; background: rgba(99,213,181,.14); border-color: rgba(99,213,181,.35); }
.node-help { margin-top: 11px !important; color: #73817c !important; font-size: 10px !important; }

.graph-loading {
  position: absolute;
  z-index: 10;
  inset: 0;
  display: grid;
  place-items: center;
  background: #08100f;
  transition: opacity .6s ease, visibility .6s ease;
}
.graph-loading.is-done { opacity: 0; visibility: hidden; }
.loading-mark { text-align: center; }
.loading-orbit { width: 58px; height: 58px; margin: 0 auto 17px; border: 1px solid rgba(99,213,181,.2); border-top-color: #63d5b5; border-radius: 50%; animation: spin 1s linear infinite; }
.loading-mark strong { display: block; font-family: Georgia, serif; font-size: 20px; font-weight: 500; }
.loading-mark span { display: block; margin-top: 5px; color: var(--muted); font-size: 11px; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 760px) {
  .graph-header { top: 16px; left: 16px; max-width: calc(100vw - 120px); }
  .graph-header h1 { font-size: 28px; }
  .graph-subtitle { display: none; }
  .graph-top-actions { top: 14px; right: 14px; }
  .graph-top-actions .glass-button:not(.wiki-link) { display: none; }
  .graph-controls { left: 12px; bottom: 12px; width: calc(100vw - 24px); }
  .filter-row { max-height: 58px; overflow: auto; }
  .graph-meta { display: none; }
  .zoom-controls { right: 13px; bottom: 152px; }
  .node-panel { top: auto; right: 12px; bottom: 142px; width: calc(100vw - 24px); max-height: 48vh; }
}

@media (prefers-reduced-motion: reduce) {
  .loading-orbit { animation: none; }
  .node-panel, .glass-button, .filter-button { transition: none; }
}
`;

function readJson<T>(target: string): T {
  return JSON.parse(readFileSync(target, "utf8")) as T;
}

function hashUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function truncate(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function packClusterCenters(
  clusters: Array<{ id: string; count: number }>
): Array<{ x: number; y: number; radius: number }> {
  const ordered = clusters
    .map((cluster, index) => ({
      index,
      id: cluster.id,
      radius: 42 + Math.sqrt(Math.max(1, cluster.count)) * 5.2
    }))
    .sort((left, right) => right.radius - left.radius || left.id.localeCompare(right.id));
  const placements: Array<{ index: number; x: number; y: number; radius: number }> = [];

  for (const item of ordered) {
    if (placements.length === 0) {
      placements.push({ ...item, x: 0, y: 0 });
      continue;
    }

    const phase = hashUnit(item.id) * Math.PI * 2;
    let accepted: { x: number; y: number } | null = null;
    for (let step = 1; step < 9000; step += 1) {
      const angle = phase + step * 0.47;
      const radius = 17 * Math.sqrt(step);
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius * 0.76;
      const overlaps = placements.some((placed) => {
        const dx = x - placed.x;
        const dy = y - placed.y;
        const required = (item.radius + placed.radius) * 0.84 + 30;
        return dx * dx + dy * dy < required * required;
      });
      if (!overlaps) {
        accepted = { x, y };
        break;
      }
    }
    placements.push({ ...item, x: accepted?.x ?? 0, y: accepted?.y ?? 0 });
  }

  const byIndex = new Array<{ x: number; y: number; radius: number }>(clusters.length);
  for (const placement of placements) {
    byIndex[placement.index] = {
      x: round(placement.x),
      y: round(placement.y),
      radius: round(placement.radius)
    };
  }
  return byIndex;
}

function choosePrimaryCluster(
  memberships: Array<{ constellationIndex: number; role: MacroNodeRole }>,
  nodeId: string,
  neighborAffinity: Map<number, number>
): number | null {
  if (memberships.length === 0) {
    if (neighborAffinity.size === 0) {
      return null;
    }
    return [...neighborAffinity.entries()].sort(
      (left, right) => right[1] - left[1] || left[0] - right[0]
    )[0]?.[0] ?? null;
  }
  return [...memberships]
    .sort((left, right) => {
      const leftScore = ROLE_SCORE[left.role] * 1000 + (neighborAffinity.get(left.constellationIndex) ?? 0);
      const rightScore = ROLE_SCORE[right.role] * 1000 + (neighborAffinity.get(right.constellationIndex) ?? 0);
      return rightScore - leftScore || hashUnit(`${nodeId}:${left.constellationIndex}`) - hashUnit(`${nodeId}:${right.constellationIndex}`);
    })[0]?.constellationIndex ?? null;
}

function relationWeight(edge: ConsolidatedThoughtEdge): number {
  const semanticMultiplier =
    edge.type === "supports" || edge.type === "revises" || edge.type === "supersedes"
      ? 1.35
      : edge.type === "co_occurs"
        ? 0.55
        : 1;
  return Math.max(0.25, Math.log2(1 + Math.max(0, edge.weight))) * semanticMultiplier;
}

function constellationPageUrl(
  constellation: ThoughtMacroConstellation,
  pages: GraphWikiPage[]
): string | null {
  const exact = pages.find(
    (page) => page.kind === "constellation" && page.title === constellation.title
  );
  const fallback = pages.find(
    (page) =>
      page.kind === "constellation" &&
      page.path.endsWith(`/${slugify(constellation.title)}.md`)
  );
  const page = exact ?? fallback;
  return page ? `../${page.path.replace(/\.md$/, ".html")}` : null;
}

/**
 * Build the compact, presentation-only graph payload.
 *
 * Macro memberships provide the semantic gravity. Graph-neighbor affinity
 * resolves overlaps and pulls unmapped nodes toward the closest constellation;
 * deterministic residual groups retain isolated material. The browser can then
 * interpolate every node continuously between its cluster center and detail
 * position without changing graph topology during zoom.
 */
export function buildGraphExplorerData(options: {
  graph: ConsolidatedThoughtGraph;
  macroMap: ThoughtMacroMapArtifact | null;
  pages: GraphWikiPage[];
}): GraphExplorerData {
  const { graph, macroMap, pages } = options;
  const nodeIndexById = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const pageByNodeId = new Map(
    pages.filter((page) => page.nodeId).map((page) => [page.nodeId as string, page])
  );
  const degree = new Array<number>(graph.nodes.length).fill(0);
  const neighbors: Array<Array<{ index: number; weight: number }>> = Array.from(
    { length: graph.nodes.length },
    () => []
  );

  for (const edge of graph.edges) {
    const source = nodeIndexById.get(edge.from);
    const target = nodeIndexById.get(edge.to);
    if (source === undefined || target === undefined || source === target) {
      continue;
    }
    const weight = relationWeight(edge);
    degree[source] += weight;
    degree[target] += weight;
    neighbors[source]?.push({ index: target, weight });
    neighbors[target]?.push({ index: source, weight });
  }

  const constellations = macroMap?.constellations ?? [];
  const rawMemberships = new Map<string, Array<{ constellationIndex: number; role: MacroNodeRole }>>();
  for (let constellationIndex = 0; constellationIndex < constellations.length; constellationIndex += 1) {
    const constellation = constellations[constellationIndex];
    if (!constellation) continue;
    for (const member of constellation.members) {
      const entries = rawMemberships.get(member.nodeId) ?? [];
      entries.push({ constellationIndex, role: member.role });
      rawMemberships.set(member.nodeId, entries);
    }
  }

  const primary = new Array<number | null>(graph.nodes.length).fill(null);
  for (let index = 0; index < graph.nodes.length; index += 1) {
    const node = graph.nodes[index];
    if (!node) continue;
    primary[index] = choosePrimaryCluster(rawMemberships.get(node.id) ?? [], node.id, new Map());
  }

  // Two bounded propagation passes keep non-atlas nodes close to actual graph
  // neighborhoods while preserving explicit macro memberships as the anchor.
  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 0; index < graph.nodes.length; index += 1) {
      const node = graph.nodes[index];
      if (!node) continue;
      const affinity = new Map<number, number>();
      for (const neighbor of neighbors[index] ?? []) {
        const cluster = primary[neighbor.index];
        if (cluster === null) continue;
        affinity.set(cluster, (affinity.get(cluster) ?? 0) + neighbor.weight);
      }
      primary[index] = choosePrimaryCluster(rawMemberships.get(node.id) ?? [], node.id, affinity);
    }
  }

  const residualTypes = new Set<ThoughtNodeType>();
  for (let index = 0; index < graph.nodes.length; index += 1) {
    if (primary[index] === null) {
      const node = graph.nodes[index];
      if (node) residualTypes.add(node.nodeType);
    }
  }
  const residualTypeList = [...residualTypes].sort(
    (left, right) => NODE_TYPES.indexOf(left) - NODE_TYPES.indexOf(right)
  );
  const residualIndexByType = new Map(
    residualTypeList.map((type, offset) => [type, constellations.length + offset])
  );
  for (let index = 0; index < graph.nodes.length; index += 1) {
    if (primary[index] === null) {
      primary[index] = residualIndexByType.get(graph.nodes[index]?.nodeType ?? "theme") ?? 0;
    }
  }

  const clusterSeeds = [
    ...constellations.map((constellation, index) => ({
      id: constellation.id,
      title: constellation.title,
      summary: constellation.summary,
      color: CLUSTER_COLORS[index % CLUSTER_COLORS.length] as string,
      url: constellationPageUrl(constellation, pages),
      atlasRole: constellation.atlasRole as GraphExplorerCluster["atlasRole"]
    })),
    ...residualTypeList.map((type, offset) => ({
      id: `graph:residual:${type}`,
      title: `Volné ${type === "question" ? "otázky" : type === "thesis" ? "teze" : type === "tension" ? "tenze" : type === "thread" ? "vývojové linky" : "motivy"}`,
      summary: "Myšlenky mimo současný makro-atlas, seskupené podle typu a nejbližšího grafového okolí.",
      color: CLUSTER_COLORS[(constellations.length + offset) % CLUSTER_COLORS.length] as string,
      url: null,
      atlasRole: "residual" as const
    }))
  ];
  const clusterCounts = new Array<number>(clusterSeeds.length).fill(0);
  for (const cluster of primary) {
    if (cluster !== null) clusterCounts[cluster] = (clusterCounts[cluster] ?? 0) + 1;
  }
  const centers = packClusterCenters(
    clusterSeeds.map((cluster, index) => ({ id: cluster.id, count: clusterCounts[index] ?? 0 }))
  );
  const clusters: GraphExplorerCluster[] = clusterSeeds.map((cluster, index) => ({
    ...cluster,
    x: centers[index]?.x ?? 0,
    y: centers[index]?.y ?? 0,
    radius: centers[index]?.radius ?? 60,
    count: clusterCounts[index] ?? 0
  }));

  const assessmentByNodeId = new Map<string, MacroNodeAssessment>(
    (macroMap?.nodeAssessments ?? []).map((assessment) => [assessment.nodeId, assessment])
  );
  const membersByCluster: number[][] = Array.from({ length: clusters.length }, () => []);
  const rankWithinCluster = new Uint32Array(graph.nodes.length);
  for (let index = 0; index < graph.nodes.length; index += 1) {
    membersByCluster[primary[index] ?? 0]?.push(index);
  }
  for (const members of membersByCluster) {
    members.sort((left, right) => {
      const leftNode = graph.nodes[left];
      const rightNode = graph.nodes[right];
      const leftSalience = leftNode ? assessmentByNodeId.get(leftNode.id)?.salienceScore ?? 0 : 0;
      const rightSalience = rightNode ? assessmentByNodeId.get(rightNode.id)?.salienceScore ?? 0 : 0;
      return rightSalience - leftSalience || degree[right]! - degree[left]! || left - right;
    });
    members.forEach((nodeIndex, rank) => {
      rankWithinCluster[nodeIndex] = rank;
    });
  }

  const positions = new Array<{ x: number; y: number }>(graph.nodes.length);
  for (let clusterIndex = 0; clusterIndex < membersByCluster.length; clusterIndex += 1) {
    const members = membersByCluster[clusterIndex] ?? [];
    const cluster = clusters[clusterIndex];
    if (!cluster) continue;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let rank = 0; rank < members.length; rank += 1) {
      const nodeIndex = members[rank];
      const node = graph.nodes[nodeIndex];
      if (nodeIndex === undefined || !node) continue;
      const jitter = hashUnit(node.id);
      const angle = rank * goldenAngle + jitter * 0.7;
      // Keep the strongest local landmarks spatially distinct. If every
      // high-salience node sits at the exact center, their text bubbles cannot
      // coexist at the zoom where a constellation first opens.
      const landmarkRadial = rank === 0
        ? 8
        : Math.min(cluster.radius * 0.72, 50 + Math.sqrt(rank) * 5.2);
      const radial = rank < 10
        ? landmarkRadial * (0.94 + jitter * 0.12)
        : 9 + Math.sqrt(rank + 0.5) * 4.85 * (0.87 + jitter * 0.25);
      positions[nodeIndex] = {
        x: cluster.x + Math.cos(angle) * radial,
        y: cluster.y + Math.sin(angle) * radial * 0.78
      };
    }
  }

  // A few cheap barycentric passes introduce graph structure inside each
  // semantic island without the cost or instability of a live 10k-node force.
  for (let pass = 0; pass < 5; pass += 1) {
    const next = positions.map((position) => ({ ...position }));
    for (let index = 0; index < graph.nodes.length; index += 1) {
      const clusterIndex = primary[index] ?? 0;
      const related = (neighbors[index] ?? []).filter(
        (neighbor) => primary[neighbor.index] === clusterIndex
      );
      if (related.length === 0) continue;
      let total = 0;
      let x = 0;
      let y = 0;
      for (const neighbor of related.slice(0, 28)) {
        const position = positions[neighbor.index];
        if (!position) continue;
        x += position.x * neighbor.weight;
        y += position.y * neighbor.weight;
        total += neighbor.weight;
      }
      const current = positions[index];
      const cluster = clusters[clusterIndex];
      if (!current || !cluster || total === 0) continue;
      const neighborMix = rankWithinCluster[index]! < 10 ? 0.05 : 0.16;
      const mixedX = current.x * (1 - neighborMix) + (x / total) * neighborMix;
      const mixedY = current.y * (1 - neighborMix) + (y / total) * neighborMix;
      const dx = mixedX - cluster.x;
      const dy = mixedY - cluster.y;
      const distance = Math.hypot(dx, dy) || 1;
      const limit = cluster.radius * 0.88;
      next[index] = distance > limit
        ? { x: cluster.x + (dx / distance) * limit, y: cluster.y + (dy / distance) * limit }
        : { x: mixedX, y: mixedY };
    }
    for (let index = 0; index < positions.length; index += 1) positions[index] = next[index]!;
  }

  const maxDegree = Math.max(1, ...degree);
  const nodes: GraphExplorerNode[] = graph.nodes.map((node, index) => {
    const assessment = assessmentByNodeId.get(node.id);
    const salience = assessment?.salienceScore ?? Math.min(100, (degree[index]! / maxDegree) * 100);
    const salienceUnit = Math.max(0, Math.min(1, salience / 100));
    const page = pageByNodeId.get(node.id);
    const membershipIndexes = (rawMemberships.get(node.id) ?? []).map(
      (membership) => membership.constellationIndex
    );
    const clusterIndex = primary[index] ?? 0;
    const secondaryClusters = [...new Set(membershipIndexes)]
      .filter((candidate) => candidate !== clusterIndex)
      .sort((left, right) => left - right);
    const position = positions[index] ?? { x: clusters[clusterIndex]?.x ?? 0, y: clusters[clusterIndex]?.y ?? 0 };
    return {
      id: node.id,
      title: node.title,
      summary: truncate(node.summary, 420),
      type: Math.max(0, NODE_TYPES.indexOf(node.nodeType)),
      status: Math.max(0, STATUSES.indexOf(node.status)),
      url: page ? `../${page.path.replace(/\.md$/, ".html")}` : "",
      cluster: clusterIndex,
      secondaryClusters,
      x: round(position.x),
      y: round(position.y),
      size: round(1.75 + Math.sqrt(salienceUnit) * 2.7 + Math.log2(1 + degree[index]!) * 0.22, 2),
      salience: round(salience, 1),
      reveal: round(1.08 + (1 - salienceUnit) * 2.45 + hashUnit(node.id) * 0.34, 2),
      degree: round(degree[index]!, 1)
    };
  });

  const edges: GraphExplorerEdge[] = [];
  const aggregated = new Map<
    string,
    { source: number; target: number; count: number; weight: number; typeCounts: number[] }
  >();
  for (const edge of graph.edges) {
    const source = nodeIndexById.get(edge.from);
    const target = nodeIndexById.get(edge.to);
    if (source === undefined || target === undefined || source === target) continue;
    const type = Math.max(0, RELATION_TYPES.indexOf(edge.type));
    const weight = round(Math.max(0.1, edge.weight), 2);
    edges.push([source, target, type, weight]);
    const sourceCluster = primary[source] ?? 0;
    const targetCluster = primary[target] ?? 0;
    if (sourceCluster === targetCluster) continue;
    const left = Math.min(sourceCluster, targetCluster);
    const right = Math.max(sourceCluster, targetCluster);
    const key = `${left}:${right}`;
    const entry = aggregated.get(key) ?? {
      source: left,
      target: right,
      count: 0,
      weight: 0,
      typeCounts: new Array<number>(RELATION_TYPES.length).fill(0)
    };
    entry.count += 1;
    entry.weight += weight;
    entry.typeCounts[type] = (entry.typeCounts[type] ?? 0) + 1;
    aggregated.set(key, entry);
  }
  const clusterEdges: GraphExplorerClusterEdge[] = [...aggregated.values()]
    .map((entry) => ({
      source: entry.source,
      target: entry.target,
      count: entry.count,
      weight: round(entry.weight, 1),
      dominantType: entry.typeCounts.indexOf(Math.max(...entry.typeCounts)),
      typeCounts: entry.typeCounts
    }))
    .sort((left, right) => right.count - left.count);

  const allX = nodes.map((node) => node.x);
  const allY = nodes.map((node) => node.y);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceRunId: graph.sourceRunId,
    title: macroMap?.atlas.title ?? "Živá mapa myšlení",
    summary:
      macroMap?.atlas.summary ??
      "Interaktivní síť konsolidovaných myšlenek a vztahů v osobním thought graphu.",
    nodeTypes: NODE_TYPES,
    statuses: STATUSES,
    relationTypes: RELATION_TYPES,
    nodes,
    edges,
    clusters,
    clusterEdges,
    bounds: {
      minX: Math.min(...allX),
      minY: Math.min(...allY),
      maxX: Math.max(...allX),
      maxY: Math.max(...allY)
    },
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      clusterCount: clusters.length,
      atlasClusterCount: constellations.length,
      mappedNodeCount: macroMap?.quality.mappedNodeCount ?? 0,
      overlapNodeCount: macroMap?.quality.overlapNodeCount ?? 0
    }
  };
}

function serializeInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[character] ?? character;
  });
}

function graphHtml(data: GraphExplorerData): string {
  return `<!DOCTYPE html>
<html lang="cs">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="Plynulá interaktivní vizualizace osobního thought graphu." />
    <link rel="icon" href="data:," />
    <title>${escapeHtml(data.title)} · Živý graf</title>
    <link rel="stylesheet" href="../assets/graph.css" />
  </head>
  <body>
    <main class="graph-shell">
      <canvas id="thought-graph" aria-label="Interaktivní síť myšlenek"></canvas>
      <header class="graph-header">
        <div class="graph-kicker">Second Brain · živý graf</div>
        <h1>${escapeHtml(data.title)}</h1>
        <p class="graph-subtitle">${escapeHtml(truncate(data.summary, 245))}</p>
      </header>
      <nav class="graph-top-actions" aria-label="Hlavní navigace">
        <button class="glass-button" type="button" id="graph-intro">Jak mapu číst</button>
        <a class="glass-button wiki-link" href="../index.html">Zpět do wiki</a>
      </nav>
      <section class="graph-controls" aria-label="Ovládání grafu">
        <div class="graph-search-wrap">
          <input id="graph-search" type="search" autocomplete="off" placeholder="Najít myšlenku v grafu…" aria-label="Najít myšlenku" />
          <div class="graph-search-results" id="graph-search-results"></div>
        </div>
        <div class="filter-row" id="node-filters" aria-label="Filtry typů uzlů"></div>
        <div class="filter-row" id="relation-filters" aria-label="Filtry vztahů"></div>
        <div class="graph-meta">
          <span>${data.stats.nodeCount.toLocaleString("cs-CZ")} nodů · ${data.stats.edgeCount.toLocaleString("cs-CZ")} vztahů</span>
          <span id="graph-performance">adaptivní kvalita</span>
        </div>
      </section>
      <div class="zoom-controls" aria-label="Přiblížení">
        <button class="glass-button" type="button" id="zoom-in" aria-label="Přiblížit">+</button>
        <button class="glass-button" type="button" id="zoom-out" aria-label="Oddálit">−</button>
        <button class="glass-button" type="button" id="zoom-reset" aria-label="Zobrazit celý graf">⌂</button>
      </div>
      <aside class="node-panel" id="node-panel" aria-live="polite">
        <button class="glass-button node-panel-close" id="node-panel-close" type="button" aria-label="Zavřít detail">×</button>
        <div class="node-panel-kicker" id="node-panel-kicker"></div>
        <h2 id="node-panel-title"></h2>
        <p id="node-panel-summary"></p>
        <div class="node-panel-meta" id="node-panel-meta"></div>
        <a class="node-link" id="node-panel-link" href="#">Otevřít stránku ve wiki →</a>
        <p class="node-help">Dvojklik na node otevře stránku přímo. Esc zavře výběr.</p>
      </aside>
      <div class="graph-loading" id="graph-loading">
        <div class="loading-mark"><div class="loading-orbit"></div><strong>Skládám mapu myšlení</strong><span>Načítám skutečný thought graph…</span></div>
      </div>
    </main>
    <script src="../assets/graph-data.js"></script>
    <script src="../assets/graph-app.js"></script>
  </body>
</html>`;
}

/** Write the self-contained graph explorer beside the generated static wiki. */
export function renderGraphExplorer(options: {
  paths: ProjectPaths;
  pages: GraphWikiPage[];
  macroMapPath?: string;
}): GraphExplorerRenderSummary | null {
  const graphPath = path.join(options.paths.compiledDir, "consolidated_thought_graph.json");
  if (!existsSync(graphPath)) {
    return null;
  }
  const defaultMacroMapPath = path.join(options.paths.compiledDir, "thought_macro_map.json");
  const macroMapPath = options.macroMapPath ?? defaultMacroMapPath;
  const graph = readJson<ConsolidatedThoughtGraph>(graphPath);
  const macroMap = existsSync(macroMapPath) ? readJson<ThoughtMacroMapArtifact>(macroMapPath) : null;
  const data = buildGraphExplorerData({ graph, macroMap, pages: options.pages });
  const graphDir = path.join(options.paths.siteDir, "graph");
  const pagePath = path.join(graphDir, "index.html");
  const dataPath = path.join(options.paths.siteAssetsDir, "graph-data.js");
  const scriptPath = path.join(options.paths.siteAssetsDir, "graph-app.js");
  const stylePath = path.join(options.paths.siteAssetsDir, "graph.css");
  mkdirSync(graphDir, { recursive: true });
  mkdirSync(options.paths.siteAssetsDir, { recursive: true });
  const dataScript = `window.__SECOND_BRAIN_GRAPH__ = ${serializeInlineJson(data)};\n`;
  writeFileSync(pagePath, graphHtml(data), "utf8");
  writeFileSync(dataPath, dataScript, "utf8");
  writeFileSync(scriptPath, GRAPH_EXPLORER_SCRIPT.trimStart(), "utf8");
  writeFileSync(stylePath, GRAPH_STYLE.trimStart(), "utf8");
  return {
    pagePath,
    dataPath,
    scriptPath,
    stylePath,
    nodeCount: data.stats.nodeCount,
    edgeCount: data.stats.edgeCount,
    clusterCount: data.stats.clusterCount,
    dataBytes: Buffer.byteLength(dataScript)
  };
}
