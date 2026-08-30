import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import type { ProjectPaths } from "../system/paths.js";
import type { UnifiedCorpus, UnifiedDocument, UnifiedSegment } from "../types/domain.js";
import type {
  ConsolidatedThoughtNode,
  ThoughtDocumentFrameArtifact,
  ThoughtDocumentFrameSourceKind,
  ThoughtNode
} from "../compiler/types.js";

/**
 * Deterministic quality audit for source-local writing and conversation frames.
 *
 * This sits after compile and before any cross-document vertical work. It
 * checks shared structural invariants and source-specific fragmentation risks.
 */

type AuditSeverity = "error" | "warning";

type AuditIssue = {
  code:
    | "main_frame_count_out_of_range"
    | "main_frame_uncovered_segments"
    | "main_frame_multi_assignment"
    | "main_frame_non_contiguous"
    | "main_frame_singleton_pressure"
    | "subframe_outside_parent"
    | "subframe_non_contiguous"
    | "paragraph_like_subframe_pressure"
    | "conversation_turn_like_subframe_pressure"
    | "outline_missing"
    | "outline_duplicate"
    | "outline_frame_mismatch"
    | "outline_step_order_invalid"
    | "outline_return_invalid";
  severity: AuditSeverity;
  message: string;
};

type DocumentAudit = {
  documentId: string;
  title: string;
  sourceKind: ThoughtDocumentFrameSourceKind;
  primarySegmentCount: number;
  frameCount: number;
  subframeCount: number;
  outlineCount: number;
  singletonMainFrameCount: number;
  singletonSubframeCount: number;
  paragraphLikeFrameCount: number;
  uncoveredSegmentIds: string[];
  multiplyAssignedSegmentIds: string[];
  nonContiguousFrameIds: string[];
  nonContiguousSubframeIds: string[];
  outOfParentSubframeIds: string[];
  invalidOutlineFrameIds: string[];
  invalidOutlineReturnFrameIds: string[];
  issues: AuditIssue[];
};

type AuditRuleSummary = {
  id: string;
  description: string;
  healthyShape: string;
  passes: number;
  warnings: number;
  errors: number;
};

export type DocumentFrameAuditReport = {
  generatedAt: string;
  inputArtifacts: {
    unifiedCorpusPath: string;
    documentFramesPath: string;
    thoughtNodesPath: string | null;
    consolidatedThoughtNodesPath: string | null;
  };
  expectations: {
    mainFrameCountRange: string;
    mainFramesShouldBeContiguous: boolean;
    subframesShouldStayWithinParent: boolean;
    subframesAreDiagnosticOnly: boolean;
  };
  summary: {
    writingDocumentCount: number;
    conversationDocumentCount: number;
    totalPrimarySegments: number;
    totalFrames: number;
    totalSubframes: number;
    totalOutlines: number;
    frameCountDistribution: Record<string, number>;
    frameCountDistributionBySourceKind: Record<
      ThoughtDocumentFrameSourceKind,
      Record<string, number>
    >;
    documentsWithErrors: number;
    documentsWithWarningsOnly: number;
    cleanDocuments: number;
    documentsWithErrorsBySourceKind: Record<ThoughtDocumentFrameSourceKind, number>;
    documentsWithWarningsOnlyBySourceKind: Record<ThoughtDocumentFrameSourceKind, number>;
    cleanDocumentsBySourceKind: Record<ThoughtDocumentFrameSourceKind, number>;
    granularNodesWithFrameMemberships: number;
    granularNodeCount: number;
    granularFramePropagationBySourceKind: Record<
      ThoughtDocumentFrameSourceKind,
      { eligibleNodeCount: number; nodesWithMemberships: number }
    >;
    consolidatedNodesWithFrameMemberships: number;
    consolidatedNodeCount: number;
    consolidatedFramePropagationBySourceKind: Record<
      ThoughtDocumentFrameSourceKind,
      { eligibleNodeCount: number; nodesWithMemberships: number }
    >;
  };
  ruleSummaries: AuditRuleSummary[];
  documents: DocumentAudit[];
  outputs: {
    jsonPath: string;
    markdownPath: string;
  };
};

type LoadedArtifacts = {
  corpusPath: string;
  corpus: UnifiedCorpus;
  documentFramesPath: string;
  documentFrames: ThoughtDocumentFrameArtifact;
  thoughtNodesPath: string | null;
  thoughtNodes: ThoughtNode[];
  consolidatedNodesPath: string | null;
  consolidatedNodes: ConsolidatedThoughtNode[];
};

function normalizeTokenCounts(values: number[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Object.fromEntries(
    Array.from(counts.entries()).sort((left, right) => Number(left[0]) - Number(right[0]))
  );
}

function buildIssue(code: AuditIssue["code"], severity: AuditSeverity, message: string): AuditIssue {
  return { code, severity, message };
}

function isContiguous(indices: number[]): boolean {
  if (indices.length <= 1) {
    return true;
  }

  const ordered = indices.slice().sort((left, right) => left - right);
  for (let index = 1; index < ordered.length; index += 1) {
    if ((ordered[index] ?? 0) !== (ordered[index - 1] ?? 0) + 1) {
      return false;
    }
  }

  return true;
}

function loadJson<T>(target: string): T {
  return JSON.parse(readFileSync(target, "utf8")) as T;
}

function loadAuditArtifacts(paths: ProjectPaths): LoadedArtifacts {
  const corpusPath = path.join(paths.normalizedUnifiedDir, "corpus.json");
  const documentFramesPath = path.join(
    paths.compiledDir,
    SECOND_BRAIN_DEFAULTS.thoughtCompiler.compiledDocumentFramesFilename
  );
  const thoughtNodesPath = path.join(
    paths.compiledDir,
    SECOND_BRAIN_DEFAULTS.thoughtCompiler.compiledNodesFilename
  );
  const consolidatedNodesPath = path.join(
    paths.compiledDir,
    SECOND_BRAIN_DEFAULTS.thoughtConsolidation.compiledNodesFilename
  );

  if (!existsSync(corpusPath)) {
    throw new Error(`Missing unified corpus at ${corpusPath}. Run normalization first.`);
  }

  if (!existsSync(documentFramesPath)) {
    throw new Error(
      `Missing document frame artifact at ${documentFramesPath}. Run compile-thought-nodes first.`
    );
  }

  return {
    corpusPath,
    corpus: loadJson<UnifiedCorpus>(corpusPath),
    documentFramesPath,
    documentFrames: loadJson<ThoughtDocumentFrameArtifact>(documentFramesPath),
    thoughtNodesPath: existsSync(thoughtNodesPath) ? thoughtNodesPath : null,
    thoughtNodes: existsSync(thoughtNodesPath) ? loadJson<ThoughtNode[]>(thoughtNodesPath) : [],
    consolidatedNodesPath: existsSync(consolidatedNodesPath) ? consolidatedNodesPath : null,
    consolidatedNodes: existsSync(consolidatedNodesPath)
      ? loadJson<ConsolidatedThoughtNode[]>(consolidatedNodesPath)
      : []
  };
}

function buildDocumentAudit(
  document: UnifiedDocument,
  segments: UnifiedSegment[],
  frameArtifact: ThoughtDocumentFrameArtifact
): DocumentAudit {
  const frames = frameArtifact.frames
    .filter((frame) => frame.documentId === document.id)
    .sort((left, right) => left.startSequenceIndex - right.startSequenceIndex);
  const subframes = frameArtifact.subframes.filter((subframe) => subframe.documentId === document.id);
  const outlines = (frameArtifact.outlines ?? []).filter((outline) => outline.documentId === document.id);
  // Conversation primary turns can have gaps where assistant context rows sit.
  // Contiguity therefore means adjacent primary items, not adjacent raw indices.
  const primaryPositionBySegmentId = new Map(segments.map((segment, index) => [segment.id, index]));
  const assignmentCountBySegmentId = new Map<string, number>();
  const issues: AuditIssue[] = [];
  const uncoveredSegmentIds: string[] = [];
  const multiplyAssignedSegmentIds: string[] = [];
  const nonContiguousFrameIds: string[] = [];
  const nonContiguousSubframeIds: string[] = [];
  const outOfParentSubframeIds: string[] = [];
  const invalidOutlineFrameIds: string[] = [];
  const invalidOutlineReturnFrameIds: string[] = [];

  for (const frame of frames) {
    for (const segmentId of frame.segmentIds) {
      assignmentCountBySegmentId.set(segmentId, (assignmentCountBySegmentId.get(segmentId) ?? 0) + 1);
    }
  }

  for (const segment of segments) {
    const count = assignmentCountBySegmentId.get(segment.id) ?? 0;
    if (count === 0) {
      uncoveredSegmentIds.push(segment.id);
    } else if (count > 1) {
      multiplyAssignedSegmentIds.push(segment.id);
    }
  }

  const singletonMainFrameCount = frames.filter((frame) => frame.segmentIds.length === 1).length;
  const singletonSubframeCount = subframes.filter((subframe) => subframe.segmentIds.length === 1).length;
  let paragraphLikeFrameCount = 0;

  if (frames.length < 1 || frames.length > SECOND_BRAIN_DEFAULTS.thoughtCompiler.maxFramesPerWriting) {
    issues.push(
      buildIssue(
        "main_frame_count_out_of_range",
        "error",
        `${document.id} má ${frames.length} main frames, očekávaný rozsah je 1-${SECOND_BRAIN_DEFAULTS.thoughtCompiler.maxFramesPerWriting}.`
      )
    );
  }

  if (uncoveredSegmentIds.length > 0) {
    issues.push(
      buildIssue(
        "main_frame_uncovered_segments",
        "error",
        `${document.id} nechává ${uncoveredSegmentIds.length} primary segmentů bez main frame.`
      )
    );
  }

  if (multiplyAssignedSegmentIds.length > 0) {
    issues.push(
      buildIssue(
        "main_frame_multi_assignment",
        "error",
        `${document.id} přiřazuje ${multiplyAssignedSegmentIds.length} segmentů do více main frames.`
      )
    );
  }

  for (const frame of frames) {
    const frameIndices = frame.segmentIds
      .map((segmentId) => primaryPositionBySegmentId.get(segmentId))
      .filter((value): value is number => typeof value === "number");

    if (!isContiguous(frameIndices)) {
      nonContiguousFrameIds.push(frame.id);
    }

    const frameSubframes = subframes.filter((subframe) => subframe.frameId === frame.id);
    const singleSegmentSubframeCount = frameSubframes.filter(
      (subframe) => subframe.segmentIds.length === 1
    ).length;
    const uniqueSubframeSegments = new Set(frameSubframes.flatMap((subframe) => subframe.segmentIds));
    const subframeCoverageRatio =
      frame.segmentIds.length === 0 ? 0 : uniqueSubframeSegments.size / frame.segmentIds.length;
    const singleSegmentSubframeRatio =
      frameSubframes.length === 0 ? 0 : singleSegmentSubframeCount / frameSubframes.length;

    if (
      frame.segmentIds.length >= 3 &&
      frameSubframes.length >= 2 &&
      subframeCoverageRatio >= 0.67 &&
      singleSegmentSubframeRatio >= 0.67
    ) {
      paragraphLikeFrameCount += 1;
    }

    for (const subframe of frameSubframes) {
      const subframeIndices = subframe.segmentIds
        .map((segmentId) => primaryPositionBySegmentId.get(segmentId))
        .filter((value): value is number => typeof value === "number");
      if (!isContiguous(subframeIndices)) {
        nonContiguousSubframeIds.push(subframe.id);
      }

      const outsideParent = subframe.segmentIds.some((segmentId) => !frame.segmentIds.includes(segmentId));
      if (outsideParent) {
        outOfParentSubframeIds.push(subframe.id);
      }
    }
  }

  if (nonContiguousFrameIds.length > 0) {
    issues.push(
      buildIssue(
        "main_frame_non_contiguous",
        "warning",
        `${document.id} má ${nonContiguousFrameIds.length} main frames, které pokrývají nesouvislé bloky.`
      )
    );
  }

  if (segments.length >= 4 && singletonMainFrameCount >= 2) {
    issues.push(
      buildIssue(
        "main_frame_singleton_pressure",
        "warning",
        `${document.id} má ${singletonMainFrameCount} jednosegmentových main frames, což vypadá jemněji než širší argumentační rámec.`
      )
    );
  }

  if (outOfParentSubframeIds.length > 0) {
    issues.push(
      buildIssue(
        "subframe_outside_parent",
        "error",
        `${document.id} má ${outOfParentSubframeIds.length} subframes mimo segmentový rozsah parent frame.`
      )
    );
  }

  if (nonContiguousSubframeIds.length > 0) {
    issues.push(
      buildIssue(
        "subframe_non_contiguous",
        "warning",
        `${document.id} má ${nonContiguousSubframeIds.length} subframes s nesouvislým rozsahem.`
      )
    );
  }

  if (document.sourceKind === "writing" && paragraphLikeFrameCount > 0) {
    issues.push(
      buildIssue(
        "paragraph_like_subframe_pressure",
        "warning",
        `${document.id} má ${paragraphLikeFrameCount} frames, kde subframes vypadají spíš jako paragraph relabeling než jako větší lokální větve.`
      )
    );
  }

  if (
    document.sourceKind === "conversation" &&
    subframes.length >= 3 &&
    singletonSubframeCount / subframes.length >= 0.75
  ) {
    issues.push(
      buildIssue(
        "conversation_turn_like_subframe_pressure",
        "warning",
        `${document.id} má ${singletonSubframeCount}/${subframes.length} jednosegmentových subframes; prověř, zda nejde o přeznačení jednotlivých user turns.`
      )
    );
  }

  if (outlines.length === 0) {
    issues.push(buildIssue("outline_missing", "error", `${document.id} nemá source-local outline.`));
  } else if (outlines.length > 1) {
    issues.push(
      buildIssue(
        "outline_duplicate",
        "error",
        `${document.id} má ${outlines.length} source-local outlines místo právě jednoho.`
      )
    );
  } else {
    const outline = outlines[0];
    const expectedFrameIds = frames.map((frame) => frame.id);
    const actualFrameIds = outline?.frameIds ?? [];
    const stepFrameIds = outline?.steps.map((step) => step.frameId) ?? [];
    const expectedFrameIdSet = new Set(expectedFrameIds);

    for (const frameId of new Set([...actualFrameIds, ...stepFrameIds, ...expectedFrameIds])) {
      const expectedCount = expectedFrameIds.filter((candidate) => candidate === frameId).length;
      const outlineCount = actualFrameIds.filter((candidate) => candidate === frameId).length;
      const stepCount = stepFrameIds.filter((candidate) => candidate === frameId).length;
      if (expectedCount !== 1 || outlineCount !== 1 || stepCount !== 1) {
        invalidOutlineFrameIds.push(frameId);
      }
    }

    if (invalidOutlineFrameIds.length > 0) {
      issues.push(
        buildIssue(
          "outline_frame_mismatch",
          "error",
          `${document.id} má ${invalidOutlineFrameIds.length} chybějících, cizích nebo duplicitních frame odkazů v outline.`
        )
      );
    }

    const invalidStepOrder =
      (outline?.steps.length ?? 0) !== expectedFrameIds.length ||
      (outline?.steps ?? []).some(
        (step, index) =>
          step.orderIndex !== index ||
          step.frameId !== actualFrameIds[index] ||
          (index === 0 && step.role !== "opening")
      );
    if (invalidStepOrder) {
      issues.push(
        buildIssue(
          "outline_step_order_invalid",
          "error",
          `${document.id} má neúplné nebo nekonzistentně seřazené outline steps.`
        )
      );
    }

    for (const [index, step] of (outline?.steps ?? []).entries()) {
      const earlierFrameIds = new Set((outline?.steps ?? []).slice(0, index).map((candidate) => candidate.frameId));
      const returnIsInvalid =
        (step.role === "return" && !step.returnsToFrameId) ||
        (step.returnsToFrameId !== null &&
          (step.role !== "return" ||
            !expectedFrameIdSet.has(step.returnsToFrameId) ||
            !earlierFrameIds.has(step.returnsToFrameId)));
      if (returnIsInvalid) {
        invalidOutlineReturnFrameIds.push(step.frameId);
      }
    }

    if (invalidOutlineReturnFrameIds.length > 0) {
      issues.push(
        buildIssue(
          "outline_return_invalid",
          "error",
          `${document.id} má ${invalidOutlineReturnFrameIds.length} neplatných return/revisit vazeb.`
        )
      );
    }
  }

  return {
    documentId: document.id,
    title: document.title,
    sourceKind: document.sourceKind as ThoughtDocumentFrameSourceKind,
    primarySegmentCount: segments.length,
    frameCount: frames.length,
    subframeCount: subframes.length,
    outlineCount: outlines.length,
    singletonMainFrameCount,
    singletonSubframeCount,
    paragraphLikeFrameCount,
    uncoveredSegmentIds,
    multiplyAssignedSegmentIds,
    nonContiguousFrameIds,
    nonContiguousSubframeIds,
    outOfParentSubframeIds,
    invalidOutlineFrameIds,
    invalidOutlineReturnFrameIds,
    issues
  };
}

function buildRuleSummaries(documents: DocumentAudit[]): AuditRuleSummary[] {
  const make = (
    id: AuditRuleSummary["id"],
    description: string,
    healthyShape: string,
    predicate: (document: DocumentAudit) => AuditIssue[]
  ): AuditRuleSummary => {
    let passes = 0;
    let warnings = 0;
    let errors = 0;

    for (const document of documents) {
      const matches = predicate(document);
      if (matches.length === 0) {
        passes += 1;
        continue;
      }

      if (matches.some((issue) => issue.severity === "error")) {
        errors += 1;
      } else {
        warnings += 1;
      }
    }

    return { id, description, healthyShape, passes, warnings, errors };
  };

  return [
    make(
      "main_frame_count_range",
      "Každý source-local dokument má mít malý počet broad main frames.",
      `1-${SECOND_BRAIN_DEFAULTS.thoughtCompiler.maxFramesPerWriting} main frames na dokument.`,
      (document) =>
        document.issues.filter((issue) => issue.code === "main_frame_count_out_of_range")
    ),
    make(
      "main_frame_total_coverage",
      "Všechny primary segmenty mají být pokryté main frames.",
      "Žádné uncovered ani multiply assigned segmenty.",
      (document) =>
        document.issues.filter(
          (issue) =>
            issue.code === "main_frame_uncovered_segments" ||
            issue.code === "main_frame_multi_assignment"
        )
    ),
    make(
      "main_frame_contiguity",
      "Main frames mají reprezentovat souvislé lokální bloky primary segmentů.",
      "Bez non-contiguous frame ranges.",
      (document) =>
        document.issues.filter(
          (issue) =>
            issue.code === "main_frame_non_contiguous" ||
            issue.code === "main_frame_singleton_pressure"
        )
    ),
    make(
      "subframe_parent_integrity",
      "Subframes mají zůstat uvnitř parent frame a držet souvislý lokální blok.",
      "Subset parent segments + contiguity.",
      (document) =>
        document.issues.filter(
          (issue) =>
            issue.code === "subframe_outside_parent" || issue.code === "subframe_non_contiguous"
        )
    ),
    make(
      "subframe_paragraph_pressure",
      "Writing subframes mají být lokální větve, ne přeznačené odstavce.",
      "Jen omezený počet paragraph-like writing subframe patterns.",
      (document) =>
        document.sourceKind === "writing"
          ? document.issues.filter((issue) => issue.code === "paragraph_like_subframe_pressure")
          : []
    ),
    make(
      "subframe_turn_pressure",
      "Conversation subframes nemají být systematické labely jednotlivých user turns.",
      "Singleton subframes jsou výjimka pro skutečně významnou lokální větev.",
      (document) =>
        document.sourceKind === "conversation"
          ? document.issues.filter(
              (issue) => issue.code === "conversation_turn_like_subframe_pressure"
            )
          : []
    ),
    make(
      "outline_integrity",
      "Každý source-local dokument má právě jeden úplný a seřazený outline.",
      "Jedna outline, přesně jeden step na frame a validní odkazy na dřívější returns.",
      (document) =>
        document.issues.filter((issue) => issue.code.startsWith("outline_"))
    )
  ];
}

function renderMarkdown(report: DocumentFrameAuditReport): string {
  const flaggedDocuments = report.documents.filter((document) => document.issues.length > 0);
  const cleanDocuments = report.documents.filter((document) => document.issues.length === 0);

  const lines: string[] = [
    "# Audit Document Frames",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Unified corpus: \`${report.inputArtifacts.unifiedCorpusPath}\``,
    `- Document frames: \`${report.inputArtifacts.documentFramesPath}\``,
    `- Thought nodes: \`${report.inputArtifacts.thoughtNodesPath ?? "missing"}\``,
    `- Consolidated nodes: \`${report.inputArtifacts.consolidatedThoughtNodesPath ?? "missing"}\``,
    "",
    "## Audit Rules",
    "",
    "1. `main_frame_count_range`: každý writing nebo conversation má mít `1-3` broad main frames.",
    "2. `main_frame_total_coverage`: všechny primary segmenty mají být pokryté právě jedním main frame.",
    "3. `main_frame_contiguity`: main frames mají být souvislé bloky primary segmentů, ne rozpadlé rozsahy.",
    "4. `subframe_parent_integrity`: subframes mají zůstat uvnitř parent frame a být souvislé.",
    "5. `subframe_paragraph_pressure`: writing subframes nemají přeznačovat jednotlivé odstavce.",
    "6. `subframe_turn_pressure`: conversation subframes nemají systematicky přeznačovat jednotlivé user turns.",
    "7. `outline_integrity`: každý dokument má právě jednu úplnou, seřazenou outline s validními returns.",
    "8. `frame_membership_propagation`: granular i consolidated nodes mají nést memberships pro každý zdrojový druh, ze kterého čerpají.",
    "",
    "## Expected Healthy Shape",
    "",
    "- source-local vertical layer má zachytit několik větších lokálních rámců, ne paragraph/turn-level label dump",
    "- subframes jsou diagnostická pomocná vrstva, ne povinná samostatná ontology",
    "- outline drží jeden writing nebo conversation pohromadě jako lokální celek",
    "- frame memberships musí přežít až do consolidated artifacts, jinak nelze hodnotit vertical behavior po merge",
    "",
    "## Summary",
    "",
    `- Writings: ${report.summary.writingDocumentCount}`,
    `- Conversations: ${report.summary.conversationDocumentCount}`,
    `- Primary segments: ${report.summary.totalPrimarySegments}`,
    `- Main frames: ${report.summary.totalFrames}`,
    `- Subframes: ${report.summary.totalSubframes}`,
    `- Outlines: ${report.summary.totalOutlines}`,
    `- Frame count distribution: ${Object.entries(report.summary.frameCountDistribution)
      .map(([key, value]) => `${key}→${value}`)
      .join(", ")}`,
    `- Documents with errors: ${report.summary.documentsWithErrors}`,
    `- Documents with warnings only: ${report.summary.documentsWithWarningsOnly}`,
    `- Clean documents: ${report.summary.cleanDocuments}`,
    `- Granular frame propagation: ${report.summary.granularNodesWithFrameMemberships}/${report.summary.granularNodeCount}`,
    `- Granular writing propagation: ${report.summary.granularFramePropagationBySourceKind.writing.nodesWithMemberships}/${report.summary.granularFramePropagationBySourceKind.writing.eligibleNodeCount}`,
    `- Granular conversation propagation: ${report.summary.granularFramePropagationBySourceKind.conversation.nodesWithMemberships}/${report.summary.granularFramePropagationBySourceKind.conversation.eligibleNodeCount}`,
    `- Consolidated frame propagation: ${report.summary.consolidatedNodesWithFrameMemberships}/${report.summary.consolidatedNodeCount}`,
    `- Consolidated writing propagation: ${report.summary.consolidatedFramePropagationBySourceKind.writing.nodesWithMemberships}/${report.summary.consolidatedFramePropagationBySourceKind.writing.eligibleNodeCount}`,
    `- Consolidated conversation propagation: ${report.summary.consolidatedFramePropagationBySourceKind.conversation.nodesWithMemberships}/${report.summary.consolidatedFramePropagationBySourceKind.conversation.eligibleNodeCount}`,
    "",
    "## Rule Outcomes",
    "",
    "| Rule | Pass | Warning | Error |",
    "| --- | ---: | ---: | ---: |"
  ];

  for (const rule of report.ruleSummaries) {
    lines.push(`| ${rule.id} | ${rule.passes} | ${rule.warnings} | ${rule.errors} |`);
  }

  lines.push("", "## Flagged Documents", "");

  if (flaggedDocuments.length === 0) {
    lines.push("Žádné flagged documents.");
  } else {
    for (const document of flaggedDocuments) {
      lines.push(`### ${document.title}`);
      lines.push("");
      lines.push(
        `- Document: \`${document.documentId}\` · source: ${document.sourceKind} · segments: ${document.primarySegmentCount} · frames: ${document.frameCount} · subframes: ${document.subframeCount} · outlines: ${document.outlineCount}`
      );
      if (document.uncoveredSegmentIds.length > 0) {
        lines.push(`- Uncovered segments: ${document.uncoveredSegmentIds.join(", ")}`);
      }
      if (document.multiplyAssignedSegmentIds.length > 0) {
        lines.push(`- Multiply assigned segments: ${document.multiplyAssignedSegmentIds.join(", ")}`);
      }
      lines.push("- Issues:");
      for (const issue of document.issues) {
        lines.push(`  - [${issue.severity}] \`${issue.code}\`: ${issue.message}`);
      }
      lines.push("");
    }
  }

  lines.push("## Clean Samples", "");
  if (cleanDocuments.length === 0) {
    lines.push("Žádné clean sample documents.");
  } else {
    for (const document of cleanDocuments.slice(0, 8)) {
      lines.push(
        `- ${document.title} (\`${document.documentId}\`) · ${document.sourceKind} · segments ${document.primarySegmentCount} · frames ${document.frameCount} · subframes ${document.subframeCount}`
      );
    }
  }

  lines.push("", "## Verdict", "");
  if (report.summary.documentsWithErrors > 0) {
    lines.push(
      "Source-local frame layer má strukturální porušení. Před zmrazením semantic contractu je potřeba opravit error-level problémy."
    );
  } else if (report.summary.documentsWithWarningsOnly > 0) {
    lines.push(
      "Source-local frame layer je strukturálně zdravá; warnings označují dokumenty, kde je potřeba kvalitativně ověřit jemnost frames nebo subframes."
    );
  } else {
    lines.push(
      "Source-local writing i conversation frame layer prošla bez strukturálních a kvalitativních flagů."
    );
  }

  return `${lines.join("\n")}\n`;
}

export function buildDocumentFrameAuditReport(
  paths: ProjectPaths,
  artifacts: LoadedArtifacts
): DocumentFrameAuditReport {
  const sourceLocalDocuments = artifacts.corpus.documents.filter(
    (document): document is UnifiedDocument & { sourceKind: ThoughtDocumentFrameSourceKind } =>
      document.sourceKind === "writing" || document.sourceKind === "conversation"
  );
  const primarySourceLocalSegments = artifacts.corpus.segments.filter(
    (segment): segment is UnifiedSegment & { sourceKind: ThoughtDocumentFrameSourceKind } =>
      (segment.sourceKind === "writing" || segment.sourceKind === "conversation") &&
      segment.signalKind === "primary"
  );
  const segmentsByDocumentId = new Map<string, UnifiedSegment[]>();

  for (const segment of primarySourceLocalSegments) {
    const bucket = segmentsByDocumentId.get(segment.documentId) ?? [];
    bucket.push(segment);
    segmentsByDocumentId.set(segment.documentId, bucket);
  }

  const documents = sourceLocalDocuments.map((document) =>
    buildDocumentAudit(
      document,
      (segmentsByDocumentId.get(document.id) ?? []).slice().sort((left, right) => left.sequenceIndex - right.sequenceIndex),
      artifacts.documentFrames
    )
  );

  const documentsWithErrors = documents.filter((document) =>
    document.issues.some((issue) => issue.severity === "error")
  ).length;
  const documentsWithWarningsOnly = documents.filter(
    (document) =>
      document.issues.length > 0 && document.issues.every((issue) => issue.severity === "warning")
  ).length;
  const cleanDocuments = documents.filter((document) => document.issues.length === 0).length;
  const granularNodesWithFrameMemberships = artifacts.thoughtNodes.filter(
    (node) => (node.frameMemberships?.length ?? 0) > 0
  ).length;
  const consolidatedNodesWithFrameMemberships = artifacts.consolidatedNodes.filter(
    (node) => (node.frameMemberships?.length ?? 0) > 0
  ).length;
  const sourceKindByDocumentId = new Map(
    sourceLocalDocuments.map((document) => [document.id, document.sourceKind])
  );
  const countPropagation = (
    nodes: Array<ThoughtNode | ConsolidatedThoughtNode>,
    sourceKind: ThoughtDocumentFrameSourceKind
  ): { eligibleNodeCount: number; nodesWithMemberships: number } => {
    const eligibleNodes = nodes.filter((node) => (node.signalBySourceKind[sourceKind] ?? 0) > 0);
    return {
      eligibleNodeCount: eligibleNodes.length,
      nodesWithMemberships: eligibleNodes.filter((node) =>
        (node.frameMemberships ?? []).some(
          (membership) => sourceKindByDocumentId.get(membership.documentId) === sourceKind
        )
      ).length
    };
  };
  const countBySourceKind = (
    predicate: (document: DocumentAudit) => boolean
  ): Record<ThoughtDocumentFrameSourceKind, number> => ({
    writing: documents.filter(
      (document) => document.sourceKind === "writing" && predicate(document)
    ).length,
    conversation: documents.filter(
      (document) => document.sourceKind === "conversation" && predicate(document)
    ).length
  });

  const report: DocumentFrameAuditReport = {
    generatedAt: new Date().toISOString(),
    inputArtifacts: {
      unifiedCorpusPath: artifacts.corpusPath,
      documentFramesPath: artifacts.documentFramesPath,
      thoughtNodesPath: artifacts.thoughtNodesPath,
      consolidatedThoughtNodesPath: artifacts.consolidatedNodesPath
    },
    expectations: {
      mainFrameCountRange: `1-${SECOND_BRAIN_DEFAULTS.thoughtCompiler.maxFramesPerWriting}`,
      mainFramesShouldBeContiguous: true,
      subframesShouldStayWithinParent: true,
      subframesAreDiagnosticOnly: true
    },
    summary: {
      writingDocumentCount: sourceLocalDocuments.filter(
        (document) => document.sourceKind === "writing"
      ).length,
      conversationDocumentCount: sourceLocalDocuments.filter(
        (document) => document.sourceKind === "conversation"
      ).length,
      totalPrimarySegments: primarySourceLocalSegments.length,
      totalFrames: artifacts.documentFrames.frames.filter(
        (frame) => frame.sourceKind === "writing" || frame.sourceKind === "conversation"
      ).length,
      totalSubframes: artifacts.documentFrames.subframes.filter(
        (subframe) => subframe.sourceKind === "writing" || subframe.sourceKind === "conversation"
      ).length,
      totalOutlines: (artifacts.documentFrames.outlines ?? []).filter(
        (outline) => outline.sourceKind === "writing" || outline.sourceKind === "conversation"
      ).length,
      frameCountDistribution: normalizeTokenCounts(documents.map((document) => document.frameCount)),
      frameCountDistributionBySourceKind: {
        writing: normalizeTokenCounts(
          documents
            .filter((document) => document.sourceKind === "writing")
            .map((document) => document.frameCount)
        ),
        conversation: normalizeTokenCounts(
          documents
            .filter((document) => document.sourceKind === "conversation")
            .map((document) => document.frameCount)
        )
      },
      documentsWithErrors,
      documentsWithWarningsOnly,
      cleanDocuments,
      documentsWithErrorsBySourceKind: countBySourceKind((document) =>
        document.issues.some((issue) => issue.severity === "error")
      ),
      documentsWithWarningsOnlyBySourceKind: countBySourceKind(
        (document) =>
          document.issues.length > 0 &&
          document.issues.every((issue) => issue.severity === "warning")
      ),
      cleanDocumentsBySourceKind: countBySourceKind((document) => document.issues.length === 0),
      granularNodesWithFrameMemberships,
      granularNodeCount: artifacts.thoughtNodes.length,
      granularFramePropagationBySourceKind: {
        writing: countPropagation(artifacts.thoughtNodes, "writing"),
        conversation: countPropagation(artifacts.thoughtNodes, "conversation")
      },
      consolidatedNodesWithFrameMemberships,
      consolidatedNodeCount: artifacts.consolidatedNodes.length,
      consolidatedFramePropagationBySourceKind: {
        writing: countPropagation(artifacts.consolidatedNodes, "writing"),
        conversation: countPropagation(artifacts.consolidatedNodes, "conversation")
      }
    },
    ruleSummaries: buildRuleSummaries(documents),
    documents,
    outputs: {
      jsonPath: path.join(paths.stateAuditsDir, "document-frame-audit.json"),
      markdownPath: path.join(paths.stateAuditsDir, "document-frame-audit.md")
    }
  };

  return report;
}

export function runDocumentFrameAudit(paths: ProjectPaths): DocumentFrameAuditReport {
  const artifacts = loadAuditArtifacts(paths);
  const report = buildDocumentFrameAuditReport(paths, artifacts);
  mkdirSync(paths.stateAuditsDir, { recursive: true });
  writeFileSync(report.outputs.jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(report.outputs.markdownPath, renderMarkdown(report), "utf8");
  return report;
}
