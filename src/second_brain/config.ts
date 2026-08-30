/**
 * Central project defaults live here so future runs do not have to rediscover
 * operational constants across multiple modules.
 *
 * Keep repo-wide runtime defaults near the top of src/second_brain so CLI
 * commands, compiler orchestration, and future config loading all read from
 * one stable place.
 */
export const SECOND_BRAIN_DEFAULTS = {
  // Chat ownership is project-specific. Configure it explicitly with --owner
  // instead of publishing a personal identity as a repository default.
  ownerNames: [],
  // The repository should compile thought structure in Czech by default and
  // only fall back to another language when the user changes that explicitly.
  language: {
    output: "cs",
    outputLabel: "Czech"
  },
  // All Codex/LLM runtime defaults that are currently wired into the repo live
  // here so debugging cost/performance can be tuned without digging through orchestration code.
  codex: {
    binaryPath: "codex",
    // Production semantic runs use the accepted 5.5/high profile. Any isolated
    // evaluation must opt into a different model explicitly.
    defaultModel: "gpt-5.5",
    defaultReasoningEffort: "high",
    // Semantic analysis only needs to read the checked-out corpus. Callers that
    // intentionally need filesystem writes must opt into a broader sandbox.
    defaultSandboxMode: "read-only",
    defaultEphemeral: true,
    // Public usage assumes a normal Git checkout. Keep the CLI safety check on
    // unless a caller explicitly opts out for an isolated non-Git workspace.
    defaultSkipGitRepoCheck: false,
    defaultJsonOutput: false,
    defaultColor: "never",
    // Guard against local Codex CLI / remote inference hangs. The client retries
    // one timed-out call once, then fails the current batch so checkpoint resume
    // can continue from the last completed unit.
    callTimeoutMs: 60 * 60 * 1000,
    timeoutAttemptLimit: 2,
    defaultConfigOverrides: {}
  },
  thoughtCompiler: {
    // These are deliberately central because batch sizing and artifact naming
    // are the two things we repeatedly tweak during compiler iteration.
    batchSize: 32,
    // Mixed reuse keeps unchanged old semantic work alive when the operator
    // updates the active model for later additive corpus growth.
    semanticReusePolicy: "mixed",
    softInputTokenBudget: 8_000,
    hardPromptTokenBudget: 14_000,
    charactersPerToken: 4,
    perSegmentOverheadTokens: 40,
    maxLocalContextCharacters: 2_000,
    maxCandidatesPerInput: 3,
    maxExistingNodeHints: 60,
    maxFramesPerWriting: 3,
    maxSubframesPerFrame: 3,
    checkpointFilename: "thought-node-compiler.json",
    compiledDocumentFramesFilename: "thought_document_frames.json",
    compiledClaimsFilename: "thought_claims.json",
    compiledNodesFilename: "thought_nodes.json",
    compiledNodeStatesFilename: "thought_node_states.json",
    compiledIdentityBlocksFilename: "thought_identity_blocks.json",
    compiledWorldlinesFilename: "thought_worldlines.json",
    compiledEdgesFilename: "thought_edges.json",
    compiledGraphFilename: "thought_graph.json",
    runStateFilename: "run.json",
    batchOutputFilenamePrefix: "batch-",
    batchOutputFilenameSuffix: ".json",
    batchSchemaFilename: "thought-batch.schema.json"
  },
  thoughtConsolidation: {
    // This pass is intentionally conservative: it should merge obvious families
    // of granular nodes, not flatten the whole graph into a few vague blobs.
    lexicalMergeThreshold: 0.72,
    lexicalSummaryThreshold: 0.6,
    relationAssistedTitleThreshold: 0.4,
    relationAssistedSummaryThreshold: 0.45,
    deterministicSharedNeighborThreshold: 2,
    revisionLexicalThreshold: 0.18,
    revisionSharedNeighborThreshold: 3,
    revisionSharedNeighborJaccardThreshold: 0.25,
    ambiguitySemanticWeightThreshold: 6,
    ambiguityLexicalThreshold: 0.18,
    ambiguitySharedNeighborThreshold: 2,
    ambiguitySharedNeighborJaccardThreshold: 0.25,
    reviewCandidateLexicalAnchorThreshold: 0.08,
    reviewCandidateTitleAnchorThreshold: 0.16,
    sameSourceLexicalThreshold: 0.1,
    sameSourceDocumentOverlapThreshold: 0.5,
    sameSourceReviewLexicalThreshold: 0.12,
    sameSourceReviewTitleThreshold: 0.18,
    sameSourceReviewDocumentOverlapThreshold: 0.75,
    // Final synthesized titles can expose duplicate families that never had a
    // direct graph edge. Review those pairs, but only inside shared sources.
    sameSourceTitleOnlyReviewThreshold: 0.55,
    sameSourceTitleOnlyMinimumTokens: 2,
    // Distinct titles can still hide duplicate semantic units. High summary
    // overlap is a review surface, not an automatic deterministic merge.
    summaryOnlyReviewThreshold: 0.72,
    summaryOnlyMinimumTokens: 5,
    reviewAcceptSummaryThreshold: 0.72,
    crossTypeNearTitleDisambiguationThreshold: 0.72,
    graphNeighborhoodReviewLexicalThreshold: 0.08,
    graphNeighborhoodReviewTitleThreshold: 0.16,
    graphNeighborhoodReviewDocumentOverlapThreshold: 0.5,
    graphNeighborhoodReviewSharedNeighborThreshold: 3,
    graphNeighborhoodReviewSharedNeighborJaccardThreshold: 0.35,
    reviewAcceptLexicalThreshold: 0.1,
    reviewAcceptSharedNeighborThreshold: 4,
    reviewAcceptSharedNeighborJaccardThreshold: 0.35,
    reviewBatchSize: 6,
    synthesisBatchSize: 6,
    // A review merge can expose another ambiguity only after the graph is
    // rebuilt. Completion therefore means a bounded fixed point, not one pass.
    maxReviewFixedPointPasses: 4,
    driftGeneratedSynthesisShareThreshold: 0.4,
    driftGeneratedReviewShareThreshold: 0.5,
    driftNewSemanticItemShareThreshold: 0.35,
    affectedFamilyShareFallbackThreshold: 0.35,
    affectedFamilyCountFallbackThreshold: 60,
    checkpointFilename: "thought-consolidation.json",
    runStateFilename: "run.json",
    compiledNodesFilename: "consolidated_thought_nodes.json",
    compiledEdgesFilename: "consolidated_thought_edges.json",
    compiledGraphFilename: "consolidated_thought_graph.json",
    reviewCandidatesFilename: "consolidation_review_candidates.json",
    reviewDecisionsFilename: "consolidation_review_decisions.json",
    synthesisFilename: "consolidation_synthesis.json"
  },
  thoughtFrameAlignment: {
    // Cross-writing alignment should be conservative: local writing frames are
    // already broad, so this layer should only create higher-order parents when
    // there is real evidence across documents, not just vague lexical affinity.
    familySharedNodeThreshold: 2,
    familyLexicalThreshold: 0.16,
    familyContextualThreshold: 0.22,
    familyRelatedNodeThreshold: 1,
    patternSharedNodeThreshold: 1,
    patternLexicalThreshold: 0.18,
    patternContextualThreshold: 0.24,
    patternRelatedNodeThreshold: 2,
    maxAnchorTokens: 5,
    compiledArtifactFilename: "thought_frame_alignment.json",
    markdownReportFilename: "thought_frame_alignment.md"
  },
  thoughtMacroMap: {
    // This is an experimental overlay above the accepted graph. Its contract
    // can evolve without invalidating granular compile or consolidation state.
    contractVersion: "thought-macro-map-v5-curated",
    compiledArtifactFilename: "thought_macro_map.json",
    markdownReportFilename: "thought_macro_map.md",
    stateDirname: "macro_map",
    minConstellationCount: 8,
    maxConstellationCount: 24,
    minConstellationMemberCount: 3,
    // Preserve the calibrated absolute ceiling for smaller graphs while
    // allowing large corpora to grow without treating normal scale as collapse.
    maxConstellationMemberCount: 900,
    maxConstellationMemberShare: 0.25,
    atlasRepresentativeLimit: 360,
    atlasRepresentativesPerDocument: 2,
    atlasMinimumDocumentNodeCount: 3,
    // Additive corpora keep the accepted atlas. This threshold is diagnostic;
    // it must not silently trigger a global remap during normal master runs.
    atlasMaxTopologyDriftShare: 0.15,
    membershipBatchSize: 48,
    maxMembershipsPerNode: 2,
    maxCoreMembersPerConstellation: 12,
    maxCurrentPositionsPerConstellation: 8,
    trajectoryEvidencePerConstellation: 24,
    semanticValidationAttempts: 2,
    highSalienceThreshold: 70,
    maxPairwiseConstellationJaccard: 0.35,
    evidenceHighlightCount: 6
  }
} as const;
