import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ConsolidatedThoughtGraph,
  ThoughtClaim,
  ThoughtDocumentFrameArtifact,
  ThoughtGraph,
  ThoughtIdentityBlock,
  ThoughtNode,
  ThoughtNodeState,
  ThoughtWorldline
} from "../compiler/types.js";
import type { UnifiedCorpus } from "../types/domain.js";
import { getProjectPaths } from "../system/paths.js";
import { renderValidationWiki } from "./render.js";

function writeJson(target: string, payload: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

test("renderValidationWiki writes browseable thought pages, references, and manifests", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-wiki-"));

  try {
    writeFileSync(path.join(tempRoot, "package.json"), "{}\n", "utf8");
    mkdirSync(path.join(tempRoot, "input", "writings"), { recursive: true });
    writeFileSync(
      path.join(tempRoot, "input", "writings", "senzory_vrstva_01_10_2024.txt"),
      "Senzory jako vrstva\n\nSenzory tvoří novou řídicí vrstvu skleníku.",
      "utf8"
    );
    writeFileSync(
      path.join(tempRoot, "input", "writings", "kontrola_zalivky_02_05_2024.txt"),
      "Jak řídit zálivku\n\nJak má senzorová zpětná vazba řídit zálivku?",
      "utf8"
    );

    const paths = getProjectPaths(tempRoot);
    const corpusPath = path.join(paths.normalizedUnifiedDir, "corpus.json");
    const thoughtGraphPath = path.join(paths.compiledDir, "thought_graph.json");

    const corpus: UnifiedCorpus = {
      generatedAt: "2026-04-22T10:00:00.000Z",
      options: {
        ownerNames: ["Alex"],
        includeOtherContext: true,
        includeAssistantContext: true,
        includeToolContext: false,
        contextWindow: 1,
        includedSourceKinds: ["writing"]
      },
      documents: [
        {
          id: "writing:senzory-vrstva",
          sourceKind: "writing",
          sourcePath: path.join(tempRoot, "input", "writings", "senzory_vrstva_01_10_2024.txt"),
          slug: "senzory-vrstva",
          title: "Senzory jako vrstva",
          time: "2024-01-10T00:00:00.000Z",
          timeUnix: 1704844800000,
          timePrecision: "day",
          sourcePriority: 100,
          primaryText: "Senzory jako vrstva\n\nSenzory tvoří novou řídicí vrstvu skleníku.",
          contextText: null,
          primarySegmentCount: 1,
          contextSegmentCount: 0,
          metadata: {
            fileLabel: "senzory_vrstva",
            lineCount: 3,
            wordCount: 8
          }
        },
        {
          id: "writing:kontrola-zalivky",
          sourceKind: "writing",
          sourcePath: path.join(tempRoot, "input", "writings", "kontrola_zalivky_02_05_2024.txt"),
          slug: "kontrola-zalivky",
          title: "Jak řídit zálivku",
          time: "2024-02-05T00:00:00.000Z",
          timeUnix: 1707091200000,
          timePrecision: "day",
          sourcePriority: 100,
          primaryText: "Jak řídit zálivku\n\nJak má senzorová zpětná vazba řídit zálivku?",
          contextText: null,
          primarySegmentCount: 1,
          contextSegmentCount: 0,
          metadata: {
            fileLabel: "kontrola_zalivky",
            lineCount: 3,
            wordCount: 9
          }
        }
      ],
      segments: [
        {
          id: "writing:senzory-vrstva:paragraph:1",
          documentId: "writing:senzory-vrstva",
          sourceKind: "writing",
          segmentKind: "writing_paragraph",
          signalKind: "primary",
          authorKind: "self",
          authorLabel: "self",
          sequenceIndex: 1,
          time: "2024-01-10T00:00:00.000Z",
          timeUnix: 1704844800000,
          timePrecision: "day",
          sourcePriority: 100,
          segmentLabel: "Paragraph 1",
          text: "[real_time_user_audio_video_asset_pointer]\nSenzory tvoří novou řídicí vrstvu skleníku.",
          textPreview: "[real_time_user_audio_video_asset_pointer] Senzory tvoří novou řídicí vrstvu skleníku.",
          sourceRef: {
            sourceKind: "writing",
            sourcePath: path.join(tempRoot, "input", "writings", "senzory_vrstva_01_10_2024.txt"),
            documentId: "writing:senzory-vrstva",
            documentTitle: "Senzory jako vrstva",
            locator: "paragraph:1",
            sourceItemId: "paragraph:1"
          }
        },
        {
          id: "writing:kontrola-zalivky:paragraph:1",
          documentId: "writing:kontrola-zalivky",
          sourceKind: "writing",
          segmentKind: "writing_paragraph",
          signalKind: "primary",
          authorKind: "self",
          authorLabel: "self",
          sequenceIndex: 1,
          time: "2024-02-05T00:00:00.000Z",
          timeUnix: 1707091200000,
          timePrecision: "day",
          sourcePriority: 100,
          segmentLabel: "Paragraph 1",
          text: "Jak má senzorová zpětná vazba řídit zálivku?",
          textPreview: "Jak má senzorová zpětná vazba řídit zálivku?",
          sourceRef: {
            sourceKind: "writing",
            sourcePath: path.join(tempRoot, "input", "writings", "kontrola_zalivky_02_05_2024.txt"),
            documentId: "writing:kontrola-zalivky",
            documentTitle: "Jak řídit zálivku",
            locator: "paragraph:1",
            sourceItemId: "paragraph:1"
          }
        }
      ],
      timeline: [],
      primaryTimeline: [],
      stats: {
        documentCount: 2,
        segmentCount: 2,
        primarySegmentCount: 2,
        contextSegmentCount: 0,
        documentsBySourceKind: {
          writing: 2,
          conversation: 0,
          chat: 0
        },
        segmentsBySourceKind: {
          writing: 2,
          conversation: 0,
          chat: 0
        }
      }
    };

    const nodes: ThoughtNode[] = [
      {
        id: "thought:senzory-jako-vrstva",
        canonicalKey: "senzory-jako-vrstva",
        nodeType: "thesis",
        title: "Senzory jako vrstva",
        summary: "Senzory tvoří řídicí vrstvu skleníku.",
        status: "active",
        firstSeen: "2024-01-10T00:00:00.000Z",
        lastSeen: "2024-01-10T00:00:00.000Z",
        currentStateId: "state:senzory-jako-vrstva:1",
        sourceRefs: [
          {
            sourceKind: "writing",
            sourcePath: path.join(tempRoot, "input", "writings", "senzory_vrstva_01_10_2024.txt"),
            documentId: "writing:senzory-vrstva",
            documentTitle: "Senzory jako vrstva",
            locator: "paragraph:1",
            sourceItemId: "paragraph:1"
          }
        ],
        evidence: [
          {
            inputId: "writing:senzory-vrstva:paragraph:1",
            batchId: "batch-0001",
            sourceKind: "writing",
            sourceRef: {
              sourceKind: "writing",
              sourcePath: path.join(tempRoot, "input", "writings", "senzory_vrstva_01_10_2024.txt"),
              documentId: "writing:senzory-vrstva",
              documentTitle: "Senzory jako vrstva",
              locator: "paragraph:1",
              sourceItemId: "paragraph:1"
            },
            rationale: "Opakovaně se objevuje jako nosná formulace."
          }
        ],
        relatedNodeIds: ["thought:jak-ridit-zalivku"],
        signalBySourceKind: {
          writing: 1,
          conversation: 0,
          chat: 0
        },
        aliases: ["Senzory jako nová řídicí vrstva"]
      },
      {
        id: "thought:jak-ridit-zalivku",
        canonicalKey: "jak-ridit-zalivku",
        nodeType: "question",
        title: "Jak řídit zálivku",
        summary: "Otázka senzorové zpětné vazby zůstává samostatným problémem.",
        status: "unresolved",
        firstSeen: "2024-02-05T00:00:00.000Z",
        lastSeen: "2024-02-05T00:00:00.000Z",
        currentStateId: "state:jak-ridit-zalivku:1",
        sourceRefs: [
          {
            sourceKind: "writing",
            sourcePath: path.join(tempRoot, "input", "writings", "kontrola_zalivky_02_05_2024.txt"),
            documentId: "writing:kontrola-zalivky",
            documentTitle: "Jak řídit zálivku",
            locator: "paragraph:1",
            sourceItemId: "paragraph:1"
          }
        ],
        evidence: [
          {
            inputId: "writing:kontrola-zalivky:paragraph:1",
            batchId: "batch-0001",
            sourceKind: "writing",
            sourceRef: {
              sourceKind: "writing",
              sourcePath: path.join(tempRoot, "input", "writings", "kontrola_zalivky_02_05_2024.txt"),
              documentId: "writing:kontrola-zalivky",
              documentTitle: "Jak řídit zálivku",
              locator: "paragraph:1",
              sourceItemId: "paragraph:1"
            },
            rationale: "Otázka zůstává otevřená."
          }
        ],
        relatedNodeIds: ["thought:senzory-jako-vrstva"],
        signalBySourceKind: {
          writing: 1,
          conversation: 0,
          chat: 0
        },
        aliases: ["Senzorová kontrola zálivky"]
      }
    ];

    const claims: ThoughtClaim[] = [
      {
        id: "claim:senzory-jako-vrstva:1",
        nodeId: "thought:senzory-jako-vrstva",
        canonicalKey: "senzory-jako-vrstva",
        inputId: "writing:senzory-vrstva:paragraph:1",
        batchId: "batch-0001",
        chronologyIndex: 1,
        time: "2024-01-10T00:00:00.000Z",
        sourceKind: "writing",
        nodeType: "thesis",
        status: "active",
        title: "Senzory jako vrstva",
        summary: "Senzory tvoří řídicí vrstvu skleníku.",
        claim: "Senzory tvoří novou řídicí vrstvu skleníku.",
        rationale: "Formulace je explicitní a stabilní.",
        relatedCanonicalKeys: ["jak-ridit-zalivku"],
        sourceRef: {
          sourceKind: "writing",
          sourcePath: path.join(tempRoot, "input", "writings", "senzory_vrstva_01_10_2024.txt"),
          documentId: "writing:senzory-vrstva",
          documentTitle: "Senzory jako vrstva",
          locator: "paragraph:1",
          sourceItemId: "paragraph:1"
        },
        relationProposals: []
      },
      {
        id: "claim:jak-ridit-zalivku:1",
        nodeId: "thought:jak-ridit-zalivku",
        canonicalKey: "jak-ridit-zalivku",
        inputId: "writing:kontrola-zalivky:paragraph:1",
        batchId: "batch-0001",
        chronologyIndex: 2,
        time: "2024-02-05T00:00:00.000Z",
        sourceKind: "writing",
        nodeType: "question",
        status: "unresolved",
        title: "Jak řídit zálivku",
        summary: "Otázka senzorové zpětné vazby zůstává samostatným problémem.",
        claim: "Jak má senzorová zpětná vazba řídit zálivku?",
        rationale: "Otázka je položena přímo v textu.",
        relatedCanonicalKeys: ["senzory-jako-vrstva"],
        sourceRef: {
          sourceKind: "writing",
          sourcePath: path.join(tempRoot, "input", "writings", "kontrola_zalivky_02_05_2024.txt"),
          documentId: "writing:kontrola-zalivky",
          documentTitle: "Jak řídit zálivku",
          locator: "paragraph:1",
          sourceItemId: "paragraph:1"
        },
        relationProposals: []
      }
    ];

    const nodeStates: ThoughtNodeState[] = [
      {
        id: "state:senzory-jako-vrstva:1",
        nodeId: "thought:senzory-jako-vrstva",
        stateIndex: 1,
        title: "Senzory jako vrstva",
        summary: "Senzory tvoří řídicí vrstvu skleníku.",
        status: "active",
        validFrom: "2024-01-10T00:00:00.000Z",
        validUntil: null,
        claimIds: ["claim:senzory-jako-vrstva:1"],
        sourceRefs: [
          {
            sourceKind: "writing",
            sourcePath: path.join(tempRoot, "input", "writings", "senzory_vrstva_01_10_2024.txt"),
            documentId: "writing:senzory-vrstva",
            documentTitle: "Senzory jako vrstva",
            locator: "paragraph:1",
            sourceItemId: "paragraph:1"
          }
        ],
        transitionType: "introduced",
        revisedByStateId: null
      },
      {
        id: "state:jak-ridit-zalivku:1",
        nodeId: "thought:jak-ridit-zalivku",
        stateIndex: 1,
        title: "Jak řídit zálivku",
        summary: "Otázka senzorové zpětné vazby zůstává samostatným problémem.",
        status: "unresolved",
        validFrom: "2024-02-05T00:00:00.000Z",
        validUntil: null,
        claimIds: ["claim:jak-ridit-zalivku:1"],
        sourceRefs: [
          {
            sourceKind: "writing",
            sourcePath: path.join(tempRoot, "input", "writings", "kontrola_zalivky_02_05_2024.txt"),
            documentId: "writing:kontrola-zalivky",
            documentTitle: "Jak řídit zálivku",
            locator: "paragraph:1",
            sourceItemId: "paragraph:1"
          }
        ],
        transitionType: "introduced",
        revisedByStateId: null
      }
    ];

    const worldlines: ThoughtWorldline[] = [
      {
        id: "worldline:senzory-jako-vrstva",
        nodeId: "thought:senzory-jako-vrstva",
        firstSeen: "2024-01-10T00:00:00.000Z",
        lastSeen: "2024-01-10T00:00:00.000Z",
        currentStateId: "state:senzory-jako-vrstva:1",
        stateIds: ["state:senzory-jako-vrstva:1"],
        claimIds: ["claim:senzory-jako-vrstva:1"],
        invalidatedStateIds: [],
        sourceKinds: ["writing"],
        transitions: [
          {
            fromStateId: null,
            toStateId: "state:senzory-jako-vrstva:1",
            type: "introduced",
            triggerClaimId: "claim:senzory-jako-vrstva:1"
          }
        ]
      },
      {
        id: "worldline:jak-ridit-zalivku",
        nodeId: "thought:jak-ridit-zalivku",
        firstSeen: "2024-02-05T00:00:00.000Z",
        lastSeen: "2024-02-05T00:00:00.000Z",
        currentStateId: "state:jak-ridit-zalivku:1",
        stateIds: ["state:jak-ridit-zalivku:1"],
        claimIds: ["claim:jak-ridit-zalivku:1"],
        invalidatedStateIds: [],
        sourceKinds: ["writing"],
        transitions: [
          {
            fromStateId: null,
            toStateId: "state:jak-ridit-zalivku:1",
            type: "introduced",
            triggerClaimId: "claim:jak-ridit-zalivku:1"
          }
        ]
      }
    ];

    const identityBlocks: ThoughtIdentityBlock[] = [
      {
        id: "identity:senzory-jako-vrstva",
        canonicalKey: "senzory-jako-vrstva",
        nodeType: "thesis",
        candidateKeys: ["senzory-jako-vrstva"],
        titleHints: ["Senzory jako vrstva"],
        claimIds: ["claim:senzory-jako-vrstva:1"],
        mergeReasons: ["single claim family"],
        mergeConfidence: "high"
      },
      {
        id: "identity:jak-ridit-zalivku",
        canonicalKey: "jak-ridit-zalivku",
        nodeType: "question",
        candidateKeys: ["jak-ridit-zalivku"],
        titleHints: ["Jak řídit zálivku"],
        claimIds: ["claim:jak-ridit-zalivku:1"],
        mergeReasons: ["single claim family"],
        mergeConfidence: "high"
      }
    ];

    const thoughtGraph: ThoughtGraph = {
      generatedAt: "2026-04-22T10:00:00.000Z",
      runId: "thought-compiler-test",
      corpusHash: "hash",
      sourceCorpusPath: corpusPath,
      batchSize: 8,
      totalBatchCount: 1,
      completedBatchCount: 1,
      nodeCount: 2,
      edgeCount: 1,
      claimCount: 2,
      nodeStateCount: 2,
      worldlineCount: 2,
      identityBlockCount: 2,
      nodes,
      edges: [
        {
          id: "semantic_related:thought:senzory-jako-vrstva:thought:jak-ridit-zalivku",
          from: "thought:senzory-jako-vrstva",
          to: "thought:jak-ridit-zalivku",
          type: "semantic_related",
          weight: 1,
          supportingSegmentIds: ["writing:senzory-vrstva:paragraph:1"],
          supportingClaimIds: ["claim:senzory-jako-vrstva:1"],
          rationales: ["Obě stránky patří do stejné linie řízení zálivky."]
        }
      ]
    };

    const consolidatedGraph: ConsolidatedThoughtGraph = {
      generatedAt: "2026-04-22T10:05:00.000Z",
      sourceRunId: "thought-compiler-test",
      sourceGraphPath: thoughtGraphPath,
      sourceNodeCount: 2,
      sourceEdgeCount: 1,
      nodeCount: 2,
      edgeCount: 1,
      nodes: [
        {
          id: "consolidated:0001:senzory-jako-vrstva",
          canonicalKey: "senzory-jako-vrstva",
          title: "Senzory jako vrstva",
          summary: "Senzory tvoří řídicí vrstvu skleníku.",
          nodeType: "thesis",
          status: "active",
          firstSeen: "2024-01-10T00:00:00.000Z",
          lastSeen: "2024-01-10T00:00:00.000Z",
          sourceRefs: [
            {
              sourceKind: "writing",
              sourcePath: path.join(tempRoot, "input", "writings", "senzory_vrstva_01_10_2024.txt"),
              documentId: "writing:senzory-vrstva",
              documentTitle: "Senzory jako vrstva",
              locator: "paragraph:1",
              sourceItemId: "paragraph:1"
            }
          ],
          relatedNodeIds: ["consolidated:0002:jak-ridit-zalivku"],
          aliases: ["Senzory jako nová řídicí vrstva"],
          signalBySourceKind: {
            writing: 1,
            conversation: 0,
            chat: 0
          },
          memberNodeIds: ["thought:senzory-jako-vrstva"],
          memberCanonicalKeys: ["senzory-jako-vrstva"],
          memberClaimIds: ["claim:senzory-jako-vrstva:1"],
          memberStateIds: ["state:senzory-jako-vrstva:1"],
          currentStateIds: ["state:senzory-jako-vrstva:1"],
          memberWorldlineIds: ["worldline:senzory-jako-vrstva"],
          consolidationReasons: ["single_node"]
        },
        {
          id: "consolidated:0002:jak-ridit-zalivku",
          canonicalKey: "jak-ridit-zalivku",
          title: "Jak řídit zálivku",
          summary: "Otázka senzorové zpětné vazby zůstává samostatným problémem.",
          nodeType: "question",
          status: "unresolved",
          firstSeen: "2024-02-05T00:00:00.000Z",
          lastSeen: "2024-02-05T00:00:00.000Z",
          sourceRefs: [
            {
              sourceKind: "writing",
              sourcePath: path.join(tempRoot, "input", "writings", "kontrola_zalivky_02_05_2024.txt"),
              documentId: "writing:kontrola-zalivky",
              documentTitle: "Jak řídit zálivku",
              locator: "paragraph:1",
              sourceItemId: "paragraph:1"
            }
          ],
          relatedNodeIds: ["consolidated:0001:senzory-jako-vrstva"],
          aliases: ["Senzorová kontrola zálivky"],
          signalBySourceKind: {
            writing: 1,
            conversation: 0,
            chat: 0
          },
          memberNodeIds: ["thought:jak-ridit-zalivku"],
          memberCanonicalKeys: ["jak-ridit-zalivku"],
          memberClaimIds: ["claim:jak-ridit-zalivku:1"],
          memberStateIds: ["state:jak-ridit-zalivku:1"],
          currentStateIds: ["state:jak-ridit-zalivku:1"],
          memberWorldlineIds: ["worldline:jak-ridit-zalivku"],
          consolidationReasons: ["single_node"]
        }
      ],
      edges: [
        {
          id: "semantic_related:consolidated:0001:senzory-jako-vrstva:consolidated:0002:jak-ridit-zalivku",
          from: "consolidated:0001:senzory-jako-vrstva",
          to: "consolidated:0002:jak-ridit-zalivku",
          type: "semantic_related",
          weight: 1,
          supportingSourceNodeIds: ["thought:senzory-jako-vrstva", "thought:jak-ridit-zalivku"],
          supportingEdgeIds: ["semantic_related:thought:senzory-jako-vrstva:thought:jak-ridit-zalivku"],
          sourceRelationTypes: ["semantic_related"]
        }
      ]
    };

    const documentFrames: ThoughtDocumentFrameArtifact = {
      generatedAt: "2026-04-22T10:02:00.000Z",
      sourceCorpusPath: corpusPath,
      corpusHash: "hash",
      documentCount: 1,
      frameCount: 1,
      subframeCount: 1,
      frames: [
        {
          id: "frame:writing:senzory-vrstva:01-jedna-vyvojova-linie-o-mereni-a-rizeni-zalivky",
          documentId: "writing:senzory-vrstva",
          sourceKind: "writing",
          label: "Jedna synteticka linie o mereni a rizeni zalivky",
          summary: "Hlavni lokalni ramec pro dlouhy vertical filename test.",
          scope: "document",
          segmentIds: ["writing:senzory-vrstva:paragraph:1"],
          startSequenceIndex: 1,
          endSequenceIndex: 1,
          subframeIds: [
            "subframe:writing:senzory-vrstva:02-napeti-mezi-pevnym-planem-a-merenim-vlhkosti"
          ]
        }
      ],
      subframes: [
        {
          id: "subframe:writing:senzory-vrstva:02-napeti-mezi-pevnym-planem-a-merenim-vlhkosti",
          frameId:
            "frame:writing:senzory-vrstva:01-jedna-vyvojova-linie-o-mereni-a-rizeni-zalivky",
          documentId: "writing:senzory-vrstva",
          sourceKind: "writing",
          label:
            "Napeti mezi pevnym planem a merenim vlhkosti ve zjevne syntetickem prikladu",
          summary: "Podramec s umyslne dlouhym nazvem pro regresni test.",
          segmentIds: ["writing:senzory-vrstva:paragraph:1"],
          startSequenceIndex: 1,
          endSequenceIndex: 1
        }
      ],
      outlines: [
        {
          id: "outline:writing:senzory-vrstva",
          documentId: "writing:senzory-vrstva",
          sourceKind: "writing",
          label: "Senzory jako vrstva",
          summary: "Minimalni outline pro vertical wiki render.",
          frameIds: [
            "frame:writing:senzory-vrstva:01-jedna-vyvojova-linie-o-mereni-a-rizeni-zalivky"
          ],
          steps: [
            {
              frameId:
                "frame:writing:senzory-vrstva:01-jedna-vyvojova-linie-o-mereni-a-rizeni-zalivky",
              orderIndex: 0,
              role: "opening",
              returnsToFrameId: null,
              rationale: "Jeden krok staci pro render test."
            }
          ]
        }
      ]
    };

    writeJson(corpusPath, corpus);
    writeJson(path.join(paths.compiledDir, "thought_claims.json"), claims);
    writeJson(path.join(paths.compiledDir, "thought_nodes.json"), nodes);
    writeJson(path.join(paths.compiledDir, "thought_node_states.json"), nodeStates);
    writeJson(path.join(paths.compiledDir, "thought_identity_blocks.json"), identityBlocks);
    writeJson(path.join(paths.compiledDir, "thought_worldlines.json"), worldlines);
    writeJson(path.join(paths.compiledDir, "thought_document_frames.json"), documentFrames);
    writeJson(thoughtGraphPath, thoughtGraph);
    writeJson(path.join(paths.compiledDir, "consolidated_thought_graph.json"), consolidatedGraph);

    const summary = renderValidationWiki(paths);

    assert.equal(summary.thoughtPageCount, 2);
    assert.equal(summary.referencePageCount, 2);
    assert.ok(existsSync(summary.indexPath));
    assert.ok(existsSync(summary.manifestPath));
    assert.ok(existsSync(summary.searchIndexPath));

    const rootIndex = readFileSync(summary.indexPath, "utf8");
    assert.match(rootIndex, /Všechny myšlenky/);
    assert.match(rootIndex, /Diagnostika grafu/);

    const thesisPagePath = path.join(paths.wikiThesesDir, "senzory-jako-vrstva.md");
    const thesisPage = readFileSync(thesisPagePath, "utf8");
    assert.match(thesisPage, /Senzory tvoří novou řídicí vrstvu skleníku\./);
    assert.match(thesisPage, /## Co se zde konkrétně tvrdí/);
    assert.match(thesisPage, /> Senzory tvoří novou řídicí vrstvu skleníku\./);
    assert.match(thesisPage, /## Související myšlenky/);
    assert.doesNotMatch(thesisPage, /## Snapshot/);
    assert.doesNotMatch(thesisPage, /## Appendix: Compiler Notes/);
    assert.match(thesisPage, /\.\.\/references\/writing-writing-senzory-vrstva\.md#ref-paragraph-1/);

    const referencePagePath = path.join(paths.wikiReferencesDir, "writing-writing-senzory-vrstva.md");
    const referencePage = readFileSync(referencePagePath, "utf8");
    assert.match(referencePage, /> Senzory tvoří novou řídicí vrstvu skleníku\./);
    assert.doesNotMatch(referencePage, /real_time_user_audio_video_asset_pointer/);
    assert.match(referencePage, /\.\.\/theses\/senzory-jako-vrstva\.md/);

    const manifest = JSON.parse(readFileSync(summary.manifestPath, "utf8")) as {
      pageCount: number;
      pages: Array<{ path: string }>;
    };
    assert.equal(manifest.pageCount, summary.pageCount);
    assert.ok(manifest.pages.some((page) => page.path === "indexes/graph.md"));
    const verticalSubframePage = manifest.pages.find((page) =>
      page.path.startsWith("vertical/subframes/")
    );
    assert.ok(verticalSubframePage);
    assert.ok(path.basename(verticalSubframePage.path).length < 140);
    assert.ok(existsSync(path.join(paths.wikiDir, verticalSubframePage.path)));

    const searchIndex = JSON.parse(readFileSync(summary.searchIndexPath, "utf8")) as Array<{
      title: string;
      path: string;
    }>;
    assert.ok(searchIndex.some((entry) => entry.title === "Senzory jako vrstva"));
    assert.ok(searchIndex.some((entry) => entry.path === "questions/jak-ridit-zalivku.md"));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
