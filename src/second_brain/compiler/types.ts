import type { SourceKind, UnifiedCorpus, UnifiedSourceRef } from "../types/domain.js";
import type { SegmentIndexDiffSummary } from "./semantic_cache.js";

/**
 * Core thought-node categories for the current semantic compiler.
 */
export type ThoughtNodeType = "question" | "thesis" | "theme" | "tension" | "thread";

/**
 * Lightweight node states that the model can propose while the graph is still early.
 */
export type ThoughtNodeStatus = "active" | "tentative" | "unresolved" | "revised";

/**
 * Broader local scope of one source-grounded frame inside a document.
 *
 * `document` means the frame spans most or all of the writing.
 * `section` means it is a substantial branch, but not the whole document.
 */
export type ThoughtDocumentFrameScope = "document" | "section";

/**
 * Source kinds currently supported by the source-local vertical layer.
 */
export type ThoughtDocumentFrameSourceKind = "writing" | "conversation";

/**
 * Local outline role of one main frame inside a single source document.
 *
 * This is separate from node-level `ThoughtFrameRole`: it describes how a
 * broader frame behaves inside the parent document spine.
 */
export type ThoughtDocumentOutlineRole =
  | "opening"
  | "development"
  | "branch"
  | "return"
  | "conclusion";

/**
 * Role of one thought unit inside its local source frame.
 *
 * This is intentionally local to one source document. It should not be confused
 * with global node identity or with cross-document vertical families.
 */
export type ThoughtFrameRole =
  | "main_claim"
  | "subclaim"
  | "question"
  | "tension"
  | "revision_branch";

/**
 * Explicit relation types the graph can currently represent.
 *
 * `co_occurs` remains a weak structural fallback. Everything else is intended
 * to be semantically meaningful enough to inspect directly before any wiki render exists.
 */
export type ThoughtRelationType =
  | "co_occurs"
  | "semantic_related"
  | "supports"
  | "tensions_with"
  | "revises"
  | "supersedes"
  | "context_split";

/**
 * One normalized primary segment prepared for inclusion in a semantic batch.
 */
export type ThoughtBatchItem = {
  inputId: string;
  documentId: string;
  sourceKind: SourceKind;
  documentTitle: string;
  chronologyIndex: number;
  time: string | null;
  segmentLabel: string;
  text: string;
  textPreview: string;
  localContext?: {
    previousSegmentLabel: string | null;
    previousText: string | null;
    nextSegmentLabel: string | null;
    nextText: string | null;
  };
  documentFrameHint?: {
    frameId: string;
    label: string;
    summary: string;
    scope: ThoughtDocumentFrameScope;
    subframeHints: Array<{
      subframeId: string;
      label: string;
      summary: string;
    }>;
  } | null;
  estimatedTokens: number;
};

/**
 * One Codex call over several normalized primary segments.
 */
export type ThoughtCompilerBatch = {
  batchId: string;
  batchIndex: number;
  estimatedInputTokens: number;
  items: ThoughtBatchItem[];
};

/**
 * Relation hint attached to one candidate within a semantic batch.
 *
 * This is the local equivalent of propstore's explicit stance/conflict layer,
 * just pared down for the thought-graph use case.
 */
export type ThoughtRelationProposal = {
  targetCanonicalKey: string;
  type: Exclude<ThoughtRelationType, "co_occurs">;
  rationale: string;
};

/**
 * Candidate thought-node attached to one input segment in Codex output.
 */
export type ThoughtNodeCandidate = {
  canonicalKey: string;
  title: string;
  nodeType: ThoughtNodeType;
  status: ThoughtNodeStatus;
  summary: string;
  rationale: string;
  claim?: string;
  identityAliases?: string[];
  documentFrameId?: string | null;
  documentSubframeId?: string | null;
  frameRole?: ThoughtFrameRole | null;
  relatedCanonicalKeys: string[];
  relationProposals?: ThoughtRelationProposal[];
};

/**
 * One broader locally coherent frame extracted from a single source document before
 * segment-level node compilation runs.
 */
export type ThoughtDocumentFrame = {
  id: string;
  documentId: string;
  sourceKind: ThoughtDocumentFrameSourceKind;
  label: string;
  summary: string;
  scope: ThoughtDocumentFrameScope;
  segmentIds: string[];
  startSequenceIndex: number;
  endSequenceIndex: number;
  subframeIds: string[];
};

/**
 * Subframe or local branch inside one broader document frame.
 */
export type ThoughtDocumentSubframe = {
  id: string;
  frameId: string;
  documentId: string;
  sourceKind: ThoughtDocumentFrameSourceKind;
  label: string;
  summary: string;
  segmentIds: string[];
  startSequenceIndex: number;
  endSequenceIndex: number;
};

/**
 * One ordered step inside the local document outline.
 *
 * `returnsToFrameId` is only used when the step re-opens or revisits an earlier
 * frame without changing the single-parent membership model of the segments.
 */
export type ThoughtDocumentOutlineStep = {
  frameId: string;
  orderIndex: number;
  role: ThoughtDocumentOutlineRole;
  returnsToFrameId: string | null;
  rationale: string;
};

/**
 * Source-local document outline above broad frames.
 *
 * This preserves that one writing or conversation first exists as one compact whole with an
 * internal spine before its nodes are connected horizontally across the corpus.
 */
export type ThoughtDocumentOutline = {
  id: string;
  documentId: string;
  sourceKind: ThoughtDocumentFrameSourceKind;
  label: string;
  summary: string;
  frameIds: string[];
  steps: ThoughtDocumentOutlineStep[];
};

/**
 * Inspectable artifact bundle for source-local writing and conversation frames.
 *
 * This exists specifically so vertical structure can start from document
 * composition rather than from a later graph-only reconstruction.
 */
export type ThoughtDocumentFrameArtifact = {
  generatedAt: string;
  sourceCorpusPath: string;
  corpusHash: string;
  model?: string | null;
  reasoningEffort?: string | null;
  documentCount: number;
  frameCount: number;
  subframeCount: number;
  frames: ThoughtDocumentFrame[];
  subframes: ThoughtDocumentSubframe[];
  outlines?: ThoughtDocumentOutline[];
  cacheBindings?: Record<
    string,
    {
      cacheKey: string;
      segmentHash: string;
      contractHash: string;
      model: string | null;
      reasoningEffort: string | null;
    }
  >;
};

/**
 * Structured result for one input segment within a semantic batch.
 */
export type ThoughtBatchItemResult = {
  inputId: string;
  nodeCandidates: ThoughtNodeCandidate[];
};

/**
 * Structured result of one semantic Codex batch.
 */
export type ThoughtBatchOutput = {
  batchId: string;
  items: ThoughtBatchItemResult[];
};

/**
 * Traceable evidence connecting a compiled node back to one source segment.
 */
export type ThoughtNodeEvidence = {
  inputId: string;
  batchId: string;
  sourceKind: SourceKind;
  sourceRef: UnifiedSourceRef;
  rationale: string;
};

/**
 * Claim-like semantic unit extracted from one segment-level node proposal.
 *
 * This sits between batch outputs and node aggregation so revision, tension,
 * and worldline logic do not have to work directly on raw segment text.
 */
export type ThoughtClaim = {
  id: string;
  nodeId: string;
  canonicalKey: string;
  inputId: string;
  batchId: string;
  chronologyIndex: number;
  time: string | null;
  sourceKind: SourceKind;
  nodeType: ThoughtNodeType;
  status: ThoughtNodeStatus;
  title: string;
  summary: string;
  claim: string;
  rationale: string;
  documentFrameId?: string | null;
  documentSubframeId?: string | null;
  frameRole?: ThoughtFrameRole | null;
  relatedCanonicalKeys: string[];
  sourceRef: UnifiedSourceRef;
  relationProposals: ThoughtRelationProposal[];
};

/**
 * Aggregated source-local frame membership attached to one compiled node.
 *
 * A node can appear in multiple local frames across different writings even
 * when its global identity stays stable.
 */
export type ThoughtNodeFrameMembership = {
  documentId: string;
  frameId: string;
  frameLabel: string;
  subframeId: string | null;
  subframeLabel: string | null;
  frameRole: ThoughtFrameRole | null;
  occurrenceCount: number;
};

/**
 * Inspectable identity block inspired by ER pipelines such as LLMCER.
 *
 * This lets the repository show how different candidate labels ended up inside
 * one canonical node instead of hiding the merge inside opaque post-processing.
 */
export type ThoughtIdentityBlock = {
  id: string;
  canonicalKey: string;
  nodeType: ThoughtNodeType;
  candidateKeys: string[];
  titleHints: string[];
  claimIds: string[];
  mergeReasons: string[];
  mergeConfidence: "high" | "medium";
};

/**
 * One temporal state of a thought-node.
 *
 * This is the first Graphiti-like temporal layer: identity stays stable while
 * state summaries can change over time and invalidate earlier states.
 */
export type ThoughtNodeState = {
  id: string;
  nodeId: string;
  stateIndex: number;
  title: string;
  summary: string;
  status: ThoughtNodeStatus;
  validFrom: string | null;
  validUntil: string | null;
  claimIds: string[];
  sourceRefs: UnifiedSourceRef[];
  transitionType: "introduced" | "continued" | "revised";
  revisedByStateId: string | null;
};

/**
 * One temporal transition inside a node worldline.
 */
export type ThoughtWorldlineTransition = {
  fromStateId: string | null;
  toStateId: string;
  type: "introduced" | "continued" | "revised";
  triggerClaimId: string;
};

/**
 * Materialized node worldline inspired by propstore's reproducible worldline artifacts.
 */
export type ThoughtWorldline = {
  id: string;
  nodeId: string;
  firstSeen: string | null;
  lastSeen: string | null;
  currentStateId: string | null;
  stateIds: string[];
  claimIds: string[];
  invalidatedStateIds: string[];
  sourceKinds: SourceKind[];
  transitions: ThoughtWorldlineTransition[];
};

/**
 * First machine-readable representation of one compiled thought-node.
 */
export type ThoughtNode = {
  id: string;
  canonicalKey: string;
  nodeType: ThoughtNodeType;
  title: string;
  summary: string;
  status: ThoughtNodeStatus;
  firstSeen: string | null;
  lastSeen: string | null;
  currentStateId: string | null;
  sourceRefs: UnifiedSourceRef[];
  evidence: ThoughtNodeEvidence[];
  relatedNodeIds: string[];
  signalBySourceKind: Record<SourceKind, number>;
  aliases: string[];
  frameMemberships?: ThoughtNodeFrameMembership[];
};

/**
 * Machine-readable relation between compiled thought-nodes.
 */
export type ThoughtEdge = {
  id: string;
  from: string;
  to: string;
  type: ThoughtRelationType;
  weight: number;
  supportingSegmentIds: string[];
  supportingClaimIds: string[];
  rationales: string[];
};

/**
 * Whole compiled graph artifact written after one compiler run or resume step.
 */
export type ThoughtGraph = {
  generatedAt: string;
  runId: string;
  corpusHash: string;
  sourceCorpusPath: string;
  batchSize: number;
  totalBatchCount: number;
  completedBatchCount: number;
  nodeCount: number;
  edgeCount: number;
  claimCount: number;
  nodeStateCount: number;
  worldlineCount: number;
  identityBlockCount: number;
  nodes: ThoughtNode[];
  edges: ThoughtEdge[];
};

/**
 * Full inspectable artifact bundle emitted by the semantic compiler.
 */
export type ThoughtCompilationArtifacts = {
  graph: ThoughtGraph;
  claims: ThoughtClaim[];
  nodeStates: ThoughtNodeState[];
  worldlines: ThoughtWorldline[];
  identityBlocks: ThoughtIdentityBlock[];
  documentFrames?: ThoughtDocumentFrameArtifact | null;
};

/**
 * Larger browseable thought unit built from several granular thought nodes.
 *
 * This is the intermediate representation between the current granular graph
 * and the future wiki renderer. It keeps provenance back to the member nodes
 * so consolidation remains inspectable rather than magical.
 */
export type ConsolidatedThoughtNode = {
  id: string;
  canonicalKey: string;
  title: string;
  summary: string;
  nodeType: ThoughtNodeType;
  status: ThoughtNodeStatus;
  firstSeen: string | null;
  lastSeen: string | null;
  sourceRefs: UnifiedSourceRef[];
  relatedNodeIds: string[];
  aliases: string[];
  signalBySourceKind: Record<SourceKind, number>;
  memberNodeIds: string[];
  memberCanonicalKeys: string[];
  memberClaimIds: string[];
  memberStateIds: string[];
  currentStateIds: string[];
  memberWorldlineIds: string[];
  consolidationReasons: string[];
  frameMemberships?: ThoughtNodeFrameMembership[];
};

/**
 * Aggregated relation between consolidated thought units.
 */
export type ConsolidatedThoughtEdge = {
  id: string;
  from: string;
  to: string;
  type: ThoughtRelationType;
  weight: number;
  supportingSourceNodeIds: string[];
  supportingEdgeIds: string[];
  sourceRelationTypes: ThoughtRelationType[];
};

/**
 * Graph intended as the next input to the future wiki renderer.
 */
export type ConsolidatedThoughtGraph = {
  generatedAt: string;
  sourceRunId: string;
  sourceGraphPath: string;
  sourceNodeCount: number;
  sourceEdgeCount: number;
  nodeCount: number;
  edgeCount: number;
  nodes: ConsolidatedThoughtNode[];
  edges: ConsolidatedThoughtEdge[];
};

/**
 * Full artifact bundle for the graph-consolidation pass.
 */
export type ThoughtConsolidationArtifacts = {
  graph: ConsolidatedThoughtGraph;
  reviewCandidates?: ConsolidationReviewCandidate[];
  reviewDecisions?: ConsolidationReviewDecision[];
  synthesis?: ConsolidationSynthesisResult[];
  incremental?: ThoughtConsolidationIncrementalSummary;
  diagnostics?: ThoughtConsolidationDiagnostics;
  familyIndex?: ThoughtConsolidationFamilyIndex;
  nodeFamilyIndex?: ThoughtConsolidationNodeFamilyIndex;
  dependencyIndex?: ThoughtConsolidationDependencyIndex;
  affectedScope?: ThoughtConsolidationAffectedScope;
};

/**
 * Small CLI summary for one consolidation run.
 */
export type ThoughtConsolidationSummary = {
  runId?: string;
  status?: ThoughtConsolidationRunStatus;
  checkpointPath?: string;
  runStatePath?: string;
  sourceNodeCount: number;
  sourceEdgeCount: number;
  consolidatedNodeCount: number;
  consolidatedEdgeCount: number;
  nodesPath: string;
  edgesPath: string;
  graphPath: string;
  reviewCandidatesPath?: string;
  reviewDecisionsPath?: string;
  synthesisPath?: string;
  incremental?: ThoughtConsolidationIncrementalSummary;
  diagnosticsPath?: string;
  familyIndexPath?: string;
  nodeFamilyIndexPath?: string;
  dependencyIndexPath?: string;
  affectedScopePath?: string;
};

export type ThoughtConsolidationFamilyIndex = {
  version: number;
  generatedAt: string;
  sourceRunId: string;
  sourceGraphPath: string;
  sourceNodeCount: number;
  sourceEdgeCount: number;
  familyCount: number;
  families: ThoughtConsolidationFamilyRecord[];
};

export type ThoughtConsolidationFamilyRecord = {
  familyId: string;
  canonicalKey: string;
  title: string;
  summary: string;
  nodeType: ThoughtNodeType;
  status: ThoughtNodeStatus;
  memberNodeIds: string[];
  memberCanonicalKeys: string[];
  memberClaimIds: string[];
  memberStateIds: string[];
  currentStateIds: string[];
  memberWorldlineIds: string[];
  sourceSegmentIds: string[];
  sourceSegmentSemanticInputHashes: Record<string, string>;
  familyInputHash: string;
  representativeInputHash: string;
  synthesisInputHash: string;
  consolidationReasons: string[];
  incomingFamilyIds: string[];
  outgoingFamilyIds: string[];
  neighborFamilyIds: string[];
  incomingEdgeIds: string[];
  outgoingEdgeIds: string[];
  reviewCaseIds: string[];
};

export type ThoughtConsolidationNodeFamilyIndex = {
  version: number;
  generatedAt: string;
  sourceRunId: string;
  familyCount: number;
  granularNodeCount: number;
  byNodeId: Record<string, string>;
  byCanonicalKey: Record<string, string[]>;
};

export type ThoughtConsolidationDependencyIndex = {
  version: number;
  generatedAt: string;
  sourceRunId: string;
  familyCount: number;
  edgeCount: number;
  byFamilyId: Record<string, ThoughtConsolidationFamilyDependencies>;
  reviewCasesByFamilyId: Record<string, string[]>;
};

export type ThoughtConsolidationFamilyDependencies = {
  incomingFamilyIds: string[];
  outgoingFamilyIds: string[];
  neighborFamilyIds: string[];
  incomingEdgeIds: string[];
  outgoingEdgeIds: string[];
  supportingSourceNodeIds: string[];
  supportingEdgeIds: string[];
  reviewCaseIds: string[];
};

export type ThoughtConsolidationAffectedScope = {
  version: number;
  generatedAt: string;
  mode: "baseline" | "incremental" | "force_new_run";
  sourceRunId: string;
  previousSourceRunId: string | null;
  previousFamilyCount: number;
  currentFamilyCount: number;
  localRecomputeFamilyIds: string[];
  affectedFamilyIds: string[];
  reviewScopeFamilyIds: string[];
  synthesisScopeFamilyIds: string[];
  dependencyExpandedClosureFamilyIds: string[];
  reusedFamilyIds: string[];
  addedFamilyIds: string[];
  removedFamilyIds: string[];
  changedFamilyIds: string[];
  neighborExpandedFamilyIds: string[];
  affectedEdgeIds: string[];
  invalidatedReviewCaseIds: string[];
  invalidatedSynthesisFamilyIds: string[];
  broaderPathUsed: boolean;
  fallbackMode: "none" | "global_deterministic";
  fallbackReasons: string[];
  stats: {
    localRecomputeFamilyCount: number;
    localRecomputeFamilyShare: number;
    affectedFamilyCount: number;
    reusedFamilyCount: number;
    affectedFamilyShare: number;
    reviewScopeFamilyCount: number;
    synthesisScopeFamilyCount: number;
    dependencyExpandedClosureFamilyCount: number;
    dependencyExpandedClosureShare: number;
    affectedEdgeCount: number;
    invalidatedReviewCaseCount: number;
    invalidatedSynthesisCount: number;
  };
};

/**
 * Operator-facing reuse summary for one consolidation pass.
 */
export type ThoughtConsolidationIncrementalSummary = {
  mode: "incremental" | "force_new_run";
  reviewCandidateCount: number;
  reusedReviewDecisionCount: number;
  generatedReviewDecisionCount: number;
  synthesisClusterCount: number;
  reusedSynthesisCount: number;
  generatedSynthesisCount: number;
};

/**
 * Deterministic operator signal for deciding when to refresh consolidation only.
 */
export type ThoughtConsolidationDiagnostics = {
  generatedAt: string;
  mode: ThoughtConsolidationIncrementalSummary["mode"];
  sourceRunId: string;
  sourceNodeCount: number;
  sourceEdgeCount: number;
  consolidatedNodeCount: number;
  consolidatedEdgeCount: number;
  semanticInput: {
    totalPrimarySegmentCount: number;
    unchangedPrimarySegmentCount: number;
    addedPrimarySegmentCount: number;
    changedPrimarySegmentCount: number;
    removedPrimarySegmentCount: number;
    newPrimarySegmentShare: number;
  };
  reuse: {
    reviewCandidateCount: number;
    reusedReviewDecisionCount: number;
    generatedReviewDecisionCount: number;
    reviewDecisionReuseShare: number;
    synthesisClusterCount: number;
    reusedSynthesisCount: number;
    generatedSynthesisCount: number;
    synthesisReuseShare: number;
    generatedSynthesisShare: number;
  };
  affectedScope?: {
    mode: ThoughtConsolidationAffectedScope["mode"];
    localRecomputeFamilyCount: number;
    localRecomputeFamilyShare: number;
    affectedFamilyCount: number;
    reusedFamilyCount: number;
    affectedFamilyShare: number;
    reviewScopeFamilyCount: number;
    synthesisScopeFamilyCount: number;
    dependencyExpandedClosureFamilyCount: number;
    dependencyExpandedClosureShare: number;
    affectedEdgeCount: number;
    invalidatedReviewCaseCount: number;
    invalidatedSynthesisCount: number;
    broaderPathUsed: boolean;
    fallbackMode: ThoughtConsolidationAffectedScope["fallbackMode"];
    fallbackReasons: string[];
  };
  thresholds: {
    generatedSynthesisShare: number;
    generatedReviewShare: number;
    newSemanticItemShare: number;
  };
  recommendation: {
    broaderPathUsed: boolean;
    broaderConsolidationRerunRecommended: boolean;
    severity: "none" | "watch" | "recommend";
    reasons: string[];
  };
};

/**
 * One aligned family built from several writing-local frames across documents.
 *
 * This intentionally sits above local document frames and below any future
 * rendered vertical wiki. It is the first cross-writing parent layer.
 */
export type ThoughtFrameAlignmentFamily = {
  id: string;
  label: string;
  representativeFrameId: string;
  representativeDocumentId: string;
  anchorTokens: string[];
  memberFrameIds: string[];
  memberDocumentIds: string[];
  memberSubframeIds: string[];
  memberFrameLabels: string[];
  memberSubframeLabels: string[];
  memberNodeIds: string[];
  memberNodeTitles: string[];
  memberNodeTypes: ThoughtNodeType[];
  memberFrameRoles: ThoughtFrameRole[];
  supportingNodeCount: number;
  cohesionScore: number;
};

/**
 * Higher-order pattern above several aligned cross-writing frame families.
 *
 * This is intentionally still deterministic and inspectable. It should behave
 * like a stable structural parent proposal, not like a final wiki page title.
 */
export type ThoughtHigherOrderPattern = {
  id: string;
  label: string;
  representativeFamilyId: string;
  anchorTokens: string[];
  familyIds: string[];
  familyLabels: string[];
  documentIds: string[];
  nodeIds: string[];
  nodeTitles: string[];
  nodeTypes: ThoughtNodeType[];
  cohesionScore: number;
};

/**
 * Persisted cross-writing alignment artifact above local document frames.
 */
export type ThoughtFrameAlignmentArtifact = {
  generatedAt: string;
  sourceDocumentFramesPath: string;
  sourceConsolidatedGraphPath: string;
  sourceConsolidatedGraphSemanticHash?: string;
  sourceFrameCount: number;
  sourceSubframeCount: number;
  sourceConsolidatedNodeCount: number;
  familyCount: number;
  patternCount: number;
  families: ThoughtFrameAlignmentFamily[];
  patterns: ThoughtHigherOrderPattern[];
};

/**
 * Small CLI summary for one cross-writing alignment run.
 */
export type ThoughtFrameAlignmentSummary = {
  sourceFrameCount: number;
  sourceSubframeCount: number;
  sourceConsolidatedNodeCount: number;
  familyCount: number;
  patternCount: number;
  artifactPath: string;
  reportPath: string;
};

/**
 * Ambiguous pair of consolidated nodes that may need semantic adjudication.
 *
 * Deterministic consolidation handles clear cases first. This artifact captures
 * the unresolved remainder so Codex can review only the expensive edge cases.
 */
export type ConsolidationReviewCandidate = {
  caseId: string;
  leftNodeId: string;
  rightNodeId: string;
  leftTitle: string;
  rightTitle: string;
  leftSummary?: string;
  rightSummary?: string;
  leftCanonicalKeys: string[];
  rightCanonicalKeys: string[];
  leftNodeType: ThoughtNodeType;
  rightNodeType: ThoughtNodeType;
  leftAliases: string[];
  rightAliases: string[];
  leftDocumentIds: string[];
  rightDocumentIds: string[];
  sharedDocumentIds: string[];
  sharedDocumentOverlapRatio: number;
  titleScore: number;
  summaryScore?: number;
  aliasScore: number;
  canonicalScore: number;
  semanticWeight: number;
  revisionWeight: number;
  blockingWeight: number;
  sharedPositiveNeighborCount: number;
  positiveNeighborJaccard: number;
  reason: string;
};

/**
 * Codex verdict over one ambiguous consolidation case.
 */
export type ConsolidationReviewDecision = {
  caseId: string;
  decision: "merge_family" | "keep_separate";
  rationale: string;
};

/**
 * LLM-authored final phrasing for one consolidated cluster after merge decisions.
 */
export type ConsolidationSynthesisResult = {
  clusterId: string;
  title: string;
  summary: string;
};

/**
 * Lifecycle states for a persisted consolidation run.
 */
export type ThoughtConsolidationRunStatus =
  | "in_progress"
  | "paused_auth"
  | "paused_quota"
  | "failed"
  | "completed";

/**
 * Coarse failure kinds that matter to consolidation resume logic.
 */
export type ThoughtConsolidationFailureKind = "auth" | "quota" | "timeout" | "other" | null;

/**
 * Persisted checkpoint state for resumable LLM consolidation review/synthesis.
 */
export type ThoughtConsolidationRunState = {
  runId: string;
  sourceRunId: string;
  graphHash: string;
  reviewCandidateCount: number;
  reviewBatchSize: number;
  synthesisBatchSize: number;
  completedReviewBatchIds: string[];
  completedSynthesisBatchIds: string[];
  status: ThoughtConsolidationRunStatus;
  failureKind: ThoughtConsolidationFailureKind;
  failureMessage: string | null;
  model: string | null;
  reasoningEffort: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  reviewPassCount?: number;
  fixedPointReached?: boolean;
};

/**
 * Lifecycle states for a persisted compiler run.
 */
export type ThoughtCompilerRunStatus =
  | "in_progress"
  | "paused_manual"
  | "paused_auth"
  | "paused_quota"
  | "failed"
  | "completed";

/**
 * Coarse failure kinds that matter to resume logic.
 */
export type ThoughtCompilerFailureKind = "auth" | "quota" | "timeout" | "other" | null;

/**
 * Persisted checkpoint state for resumable batch compilation.
 */
export type ThoughtCompilerRunState = {
  runId: string;
  sourceCorpusPath: string;
  corpusHash: string;
  batchSize: number;
  softInputTokenBudget: number;
  totalBatchCount: number;
  completedBatchIds: string[];
  lastSuccessfulBatchId: string | null;
  lastSuccessfulInputId: string | null;
  status: ThoughtCompilerRunStatus;
  failureKind: ThoughtCompilerFailureKind;
  failureMessage: string | null;
  compilerContractVersion: number;
  model: string | null;
  reasoningEffort: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
};

/**
 * Final per-invocation summary returned to the CLI after compile or resume.
 */
export type ThoughtCompilerInvocationSummary = {
  runId: string;
  status: ThoughtCompilerRunStatus;
  success: boolean;
  corpusHash: string;
  totalBatchCount: number;
  completedBatchCount: number;
  processedBatchCount: number;
  reusedSemanticItemCount: number;
  pendingSemanticItemCount: number;
  remainingBatchCount: number;
  lastSuccessfulBatchId: string | null;
  failureKind: ThoughtCompilerFailureKind;
  failureMessage: string | null;
  checkpointPath: string;
  runStatePath: string;
  nodesPath: string;
  edgesPath: string;
  graphPath: string;
  semanticCachePath: string | null;
  segmentIndexPath: string | null;
  compileManifestPath: string | null;
  incremental: ThoughtCompilerIncrementalSummary;
};

export type ThoughtCompilerIncrementalMode =
  | "incremental_cache"
  | "exact_run_resume"
  | "force_new_run";

export type ThoughtSemanticReusePolicy = "strict" | "mixed";

export type ThoughtCompilerIncrementalSummary = {
  mode: ThoughtCompilerIncrementalMode;
  reusePolicy: ThoughtSemanticReusePolicy;
  semanticItems: {
    totalPrimarySegmentCount: number;
    reusedCount: number;
    reusedCurrentContractCount: number;
    reusedPriorContractCount: number;
    newCount: number;
  } | null;
  sourceDiff: SegmentIndexDiffSummary | null;
};

/**
 * Shared input bundle passed around the compiler once the unified corpus is loaded.
 */
export type ThoughtCompilerSource = {
  corpus: UnifiedCorpus;
  corpusHash: string;
  corpusPath: string;
};
