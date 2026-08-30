import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getProjectPaths } from "../system/paths.js";
import type { UnifiedCorpus } from "../types/domain.js";
import {
  buildDocumentFrameHintLookup,
  buildConversationDocumentFramePrompt,
  buildWritingDocumentFramePrompt,
  extractSourceDocumentFrames,
  extractWritingDocumentFrames
} from "./document_frames.js";

function createWritingCorpus(): UnifiedCorpus {
  const texts = [
    "Pevný plán zavlažování zjednodušuje běžnou péči a dává výchozí rytmus.",
    "Přechod na senzory má pořizovací a provozní náklady, které je třeba vyhodnotit.",
    "Závěr se vrací k hlavnímu cíli: stabilní vlhkosti půdy bez plýtvání vodou."
  ];

  const segments = texts.map((text, index) => {
    const segmentIndex = index + 1;
    return {
      id: `writing:zavlazovani:paragraph:${segmentIndex}`,
      documentId: "writing:zavlazovani",
      sourceKind: "writing" as const,
      segmentKind: "writing_paragraph" as const,
      signalKind: "primary" as const,
      authorKind: "self" as const,
      authorLabel: "self",
      sequenceIndex: segmentIndex,
      time: "2024-03-18T00:00:00.000Z",
      timeUnix: Date.parse("2024-03-18T00:00:00.000Z"),
      timePrecision: "day" as const,
      sourcePriority: 100,
      segmentLabel: `Paragraph ${segmentIndex}`,
      text,
      textPreview: text,
      sourceRef: {
        sourceKind: "writing" as const,
        sourcePath: "/input/writings/zavlazovani.txt",
        documentId: "writing:zavlazovani",
        documentTitle: "Plán zavlažování",
        locator: `paragraph:${segmentIndex}`,
        sourceItemId: `paragraph:${segmentIndex}`
      }
    };
  });

  return {
    generatedAt: "2026-04-28T00:00:00.000Z",
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
        id: "writing:zavlazovani",
        sourceKind: "writing" as const,
        sourcePath: "/input/writings/zavlazovani.txt",
        slug: "zavlazovani",
        title: "Plán zavlažování",
        time: "2024-03-18T00:00:00.000Z",
        timeUnix: Date.parse("2024-03-18T00:00:00.000Z"),
        timePrecision: "day" as const,
        sourcePriority: 100,
        primaryText: texts.join("\n\n"),
        contextText: null,
        primarySegmentCount: segments.length,
        contextSegmentCount: 0,
        metadata: {
          fileLabel: "zavlazovani",
          wordCount: texts.join(" ").split(/\s+/).length
        }
      }
    ],
    segments,
    timeline: segments.map((segment, index) => ({
      chronologyIndex: index,
      segmentId: segment.id,
      documentId: segment.documentId,
      sourceKind: segment.sourceKind,
      segmentKind: segment.segmentKind,
      signalKind: segment.signalKind,
      authorKind: segment.authorKind,
      documentTitle: "Plán zavlažování",
      segmentLabel: segment.segmentLabel,
      time: segment.time,
      timeUnix: segment.timeUnix,
      timePrecision: segment.timePrecision,
      textPreview: segment.textPreview
    })),
    primaryTimeline: segments.map((segment, index) => ({
      chronologyIndex: index,
      segmentId: segment.id,
      documentId: segment.documentId,
      sourceKind: segment.sourceKind,
      segmentKind: segment.segmentKind,
      signalKind: segment.signalKind,
      authorKind: segment.authorKind,
      documentTitle: "Plán zavlažování",
      segmentLabel: segment.segmentLabel,
      time: segment.time,
      timeUnix: segment.timeUnix,
      timePrecision: segment.timePrecision,
      textPreview: segment.textPreview
    })),
    stats: {
      documentCount: 1,
      segmentCount: segments.length,
      primarySegmentCount: segments.length,
      contextSegmentCount: 0,
      documentsBySourceKind: {
        writing: 1,
        conversation: 0,
        chat: 0
      },
      segmentsBySourceKind: {
        writing: segments.length,
        conversation: 0,
        chat: 0
      }
    }
  };
}

function createConversationCorpus(): UnifiedCorpus {
  const texts = [
    "V testovacím skleníku je potřeba nastavit zálivku pro tři záhony.",
    "Nejdřív se ověří výchozí vlhkost a průtok vody.",
    "U prostředního záhonu může vadit jiný typ půdy; ten se otestuje zvlášť.",
    "Pak se postup vrátí k hlavnímu plánu a porovná údaje po první zálivce.",
    "Nakonec se interval upraví tak, aby všechny záhony zůstaly v cílovém rozsahu."
  ];

  const segments = texts.map((text, index) => {
    const segmentIndex = index * 2 + 1;
    return {
      id: `conversation:testovaci-sklenik:turn:${segmentIndex}`,
      documentId: "conversation:testovaci-sklenik",
      sourceKind: "conversation" as const,
      segmentKind: "conversation_user_turn" as const,
      signalKind: "primary" as const,
      authorKind: "self" as const,
      authorLabel: "self",
      sequenceIndex: segmentIndex,
      time: "2024-03-18T10:00:00.000Z",
      timeUnix: Date.parse("2024-03-18T10:00:00.000Z") + index * 60_000,
      timePrecision: "second" as const,
      sourcePriority: 80,
      segmentLabel: `User turn ${segmentIndex}`,
      text,
      textPreview: text,
      sourceRef: {
        sourceKind: "conversation" as const,
        sourcePath: "/input/conversations/synthetic-conversation.json",
        documentId: "conversation:testovaci-sklenik",
        documentTitle: "Testovací skleník",
        locator: `turn:${segmentIndex}`,
        sourceItemId: `turn:${segmentIndex}`,
        conversationId: "testovaci-sklenik",
        bundleName: "synthetic-conversation.json",
        turnId: `turn:${segmentIndex}`
      }
    };
  });

  return {
    generatedAt: "2026-04-28T00:00:00.000Z",
    options: {
      ownerNames: ["Alex"],
      includeOtherContext: true,
      includeAssistantContext: true,
      includeToolContext: false,
      contextWindow: 1,
      includedSourceKinds: ["conversation"]
    },
    documents: [
      {
        id: "conversation:testovaci-sklenik",
        sourceKind: "conversation" as const,
        sourcePath: "/input/conversations/synthetic-conversation.json",
        slug: "testovaci-sklenik",
        title: "Testovací skleník",
        time: "2024-03-18T10:00:00.000Z",
        timeUnix: Date.parse("2024-03-18T10:00:00.000Z"),
        timePrecision: "second" as const,
        sourcePriority: 80,
        primaryText: texts.join("\n\n"),
        contextText: null,
        primarySegmentCount: segments.length,
        contextSegmentCount: 0,
        metadata: {
          conversationId: "testovaci-sklenik",
          bundleName: "synthetic-conversation.json",
          turnCount: segments.length
        }
      }
    ],
    segments,
    timeline: segments.map((segment, index) => ({
      chronologyIndex: index,
      segmentId: segment.id,
      documentId: segment.documentId,
      sourceKind: segment.sourceKind,
      segmentKind: segment.segmentKind,
      signalKind: segment.signalKind,
      authorKind: segment.authorKind,
      documentTitle: "Testovací skleník",
      segmentLabel: segment.segmentLabel,
      time: segment.time,
      timeUnix: segment.timeUnix,
      timePrecision: segment.timePrecision,
      textPreview: segment.textPreview
    })),
    primaryTimeline: segments.map((segment, index) => ({
      chronologyIndex: index,
      segmentId: segment.id,
      documentId: segment.documentId,
      sourceKind: segment.sourceKind,
      segmentKind: segment.segmentKind,
      signalKind: segment.signalKind,
      authorKind: segment.authorKind,
      documentTitle: "Testovací skleník",
      segmentLabel: segment.segmentLabel,
      time: segment.time,
      timeUnix: segment.timeUnix,
      timePrecision: segment.timePrecision,
      textPreview: segment.textPreview
    })),
    stats: {
      documentCount: 1,
      segmentCount: segments.length,
      primarySegmentCount: segments.length,
      contextSegmentCount: 0,
      documentsBySourceKind: {
        writing: 0,
        conversation: 1,
        chat: 0
      },
      segmentsBySourceKind: {
        writing: 0,
        conversation: segments.length,
        chat: 0
      }
    }
  };
}

function createPaths(): ReturnType<typeof getProjectPaths> {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "second-brain-document-frames-"));
  writeFileSync(path.join(tempRoot, "package.json"), "{}\n", "utf8");
  mkdirSync(path.join(tempRoot, "input"), { recursive: true });
  return getProjectPaths(tempRoot);
}

test("buildWritingDocumentFramePrompt asks for broad document frames rather than paragraph labels", () => {
  const corpus = createWritingCorpus();
  const document = corpus.documents[0]!;
  const prompt = buildWritingDocumentFramePrompt(
    {
      ...document,
      sourceKind: "writing"
    },
    corpus.segments.filter(
      (segment): segment is (typeof corpus.segments)[number] & { sourceKind: "writing" } =>
        segment.documentId === document.id && segment.sourceKind === "writing"
    )
  );

  assert.match(prompt, /širší document frames/i);
  assert.match(prompt, /lokální outline celého textu/i);
  assert.match(prompt, /Nevyráběj mikro-label pro každý odstavec/);
  assert.match(prompt, /outlineRole/);
  assert.match(prompt, /souvislý lokální blok segmentů/i);
  assert.match(prompt, /segmentIds musí být přesné identifikátory/);
});

test("buildConversationDocumentFramePrompt asks for broad thread phases rather than per-turn labels", () => {
  const corpus = createConversationCorpus();
  const document = corpus.documents[0]!;
  const prompt = buildConversationDocumentFramePrompt(
    {
      ...document,
      sourceKind: "conversation"
    },
    corpus.segments.filter(
      (segment): segment is (typeof corpus.segments)[number] & { sourceKind: "conversation" } =>
        segment.documentId === document.id && segment.sourceKind === "conversation"
    )
  );

  assert.match(prompt, /širší document frames uvnitř jedné uživatelské conversation/i);
  assert.match(prompt, /lokální outline celého threadu/i);
  assert.match(prompt, /Nevyráběj mikro-label pro každý user turn/i);
  assert.match(prompt, /Jednosegmentový subframe je výjimka/i);
  assert.match(prompt, /Toleruj krátké odbočky bez nutnosti vytvářet nový frame/i);
  assert.match(prompt, /outlineRole/);
});

test("extractWritingDocumentFrames repairs overlaps into one primary parent frame per segment", () => {
  const corpus = createWritingCorpus();
  const paths = createPaths();

  try {
    const artifact = extractWritingDocumentFrames(
      corpus,
      "synthetic-hash",
      "/output/normalized/unified/corpus.json",
      paths,
      {
        execSemanticBatch: <T,>() =>
          ({
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              documentId: "writing:zavlazovani",
              documentSummary:
                "Text drží jednu hlavní linii od pevného plánu přes náklady přechodu k senzorové kontrole vlhkosti.",
              frames: [
                {
                  label: "Plán a měření",
                  summary: "Širší rámec pro nastavení zálivky a průběžné měření půdy.",
                  outlineRole: "opening",
                  outlineRationale: "Text nejdřív otevírá výchozí plán zavlažování.",
                  returnTargetSegmentId: null,
                  segmentIds: [
                    "writing:zavlazovani:paragraph:1",
                    "writing:zavlazovani:paragraph:2"
                  ],
                  subframes: [
                    {
                      label: "Přechodové náklady",
                      summary: "Větev o nákladech přechodu na senzorové řízení.",
                      segmentIds: ["writing:zavlazovani:paragraph:2"]
                    }
                  ]
                },
                {
                  label: "Stabilní vlhkost",
                  summary: "Rámec o cílové vlhkosti a omezení plýtvání vodou.",
                  outlineRole: "conclusion",
                  outlineRationale: "Text uzavírá celek požadovaným stavem půdy.",
                  returnTargetSegmentId: null,
                  segmentIds: [
                    "writing:zavlazovani:paragraph:2",
                    "writing:zavlazovani:paragraph:3"
                  ],
                  subframes: []
                }
              ]
            } as T
          })
      }
    );

	    assert.equal(artifact.frameCount, 2);
	    assert.equal(artifact.subframeCount, 1);
        assert.equal(artifact.outlines?.length, 1);
        assert.equal(artifact.outlines?.[0]?.steps[0]?.role, "opening");
        assert.equal(artifact.outlines?.[0]?.steps[1]?.role, "conclusion");

	    const hintLookup = buildDocumentFrameHintLookup(artifact);
    assert.equal(hintLookup.get("writing:zavlazovani:paragraph:1")?.label, "Plán a měření");
    assert.equal(hintLookup.get("writing:zavlazovani:paragraph:2")?.label, "Plán a měření");
    assert.equal(
      hintLookup.get("writing:zavlazovani:paragraph:3")?.label,
      "Stabilní vlhkost"
    );
    assert.equal(
      hintLookup.get("writing:zavlazovani:paragraph:2")?.subframeHints[0]?.label,
      "Přechodové náklady"
    );
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("extractWritingDocumentFrames suppresses paragraph-like subframes when they just mirror single paragraphs", () => {
  const corpus = createWritingCorpus();
  const paths = createPaths();

  try {
    const artifact = extractWritingDocumentFrames(
      corpus,
      "synthetic-hash",
      "/output/normalized/unified/corpus.json",
      paths,
      {
        execSemanticBatch: <T,>() =>
          ({
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              documentId: "writing:zavlazovani",
              documentSummary: "Jedna hlavní linie spojuje plán, přechod na senzory a cílovou vlhkost.",
              frames: [
                {
                  label: "Plán zavlažování",
                  summary: "Širší rámec plánu, měření a cílové vlhkosti.",
                  outlineRole: "opening",
                  outlineRationale: "Text drží jednu souvislou hlavní linii.",
                  returnTargetSegmentId: null,
                  segmentIds: [
                    "writing:zavlazovani:paragraph:1",
                    "writing:zavlazovani:paragraph:2",
                    "writing:zavlazovani:paragraph:3"
                  ],
                  subframes: [
                    {
                      label: "Výchozí plán",
                      summary: "První odstavec.",
                      segmentIds: ["writing:zavlazovani:paragraph:1"]
                    },
                    {
                      label: "Přechod",
                      summary: "Druhý odstavec.",
                      segmentIds: ["writing:zavlazovani:paragraph:2"]
                    },
                    {
                      label: "Stabilní vlhkost",
                      summary: "Třetí odstavec.",
                      segmentIds: ["writing:zavlazovani:paragraph:3"]
                    }
                  ]
                }
              ]
            } as T
          })
      }
    );

    assert.equal(artifact.frameCount, 1);
    assert.equal(artifact.subframeCount, 0);
    assert.deepEqual(artifact.frames[0]?.subframeIds, []);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("extractWritingDocumentFrames trims non-contiguous subframes to the longest local run", () => {
  const corpus = createWritingCorpus();
  const paths = createPaths();

  try {
    const artifact = extractWritingDocumentFrames(
      corpus,
      "synthetic-hash",
      "/output/normalized/unified/corpus.json",
      paths,
      {
        execSemanticBatch: <T,>() =>
          ({
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              documentId: "writing:zavlazovani",
              documentSummary: "Text drží jednu linii a nesouvislý subframe se má zúžit na lokální blok.",
              frames: [
                {
                  label: "Plán zavlažování",
                  summary: "Širší rámec plánu, měření a cílové vlhkosti.",
                  outlineRole: "opening",
                  outlineRationale: "Text nejdřív rozvíjí jeden společný rámec.",
                  returnTargetSegmentId: null,
                  segmentIds: [
                    "writing:zavlazovani:paragraph:1",
                    "writing:zavlazovani:paragraph:2",
                    "writing:zavlazovani:paragraph:3"
                  ],
                  subframes: [
                    {
                      label: "Rozptýlené měření",
                      summary: "Nesouvisle posbírané motivy.",
                      segmentIds: [
                        "writing:zavlazovani:paragraph:1",
                        "writing:zavlazovani:paragraph:3"
                      ]
                    }
                  ]
                }
              ]
            } as T
          })
      }
    );

    assert.equal(artifact.subframeCount, 1);
    assert.deepEqual(artifact.subframes[0]?.segmentIds, ["writing:zavlazovani:paragraph:1"]);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("extractWritingDocumentFrames materializes local outline roles and return links above frames", () => {
  const corpus = createWritingCorpus();
  const paths = createPaths();

  try {
    const artifact = extractWritingDocumentFrames(
      corpus,
      "synthetic-hash",
      "/output/normalized/unified/corpus.json",
      paths,
      {
        execSemanticBatch: <T,>() =>
          ({
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              documentId: "writing:zavlazovani",
              documentSummary:
                "Text otevře pevný plán, odbočí k nákladům přechodu a pak se vrátí k cílové vlhkosti.",
              frames: [
                {
                  label: "Výchozí plán",
                  summary: "Úvodní rámec pevného plánu zavlažování.",
                  outlineRole: "opening",
                  outlineRationale: "Text nejdřív otevírá výchozí způsob zavlažování.",
                  returnTargetSegmentId: null,
                  segmentIds: ["writing:zavlazovani:paragraph:1"],
                  subframes: []
                },
                {
                  label: "Náklady přechodu",
                  summary: "Odbočka k pořizovacím a provozním nákladům senzorů.",
                  outlineRole: "branch",
                  outlineRationale: "Text se dočasně větví k přechodovým nákladům.",
                  returnTargetSegmentId: null,
                  segmentIds: ["writing:zavlazovani:paragraph:2"],
                  subframes: []
                },
                {
                  label: "Stabilní vlhkost",
                  summary: "Závěr, který se vrací k cílovému stavu půdy.",
                  outlineRole: "return",
                  outlineRationale: "Pozdní část se vrací k cíli výchozího plánu.",
                  returnTargetSegmentId: "writing:zavlazovani:paragraph:1",
                  segmentIds: ["writing:zavlazovani:paragraph:3"],
                  subframes: []
                }
              ]
            } as T
          })
      }
    );

    const outline = artifact.outlines?.[0];
    assert.ok(outline);
    assert.equal(outline?.steps.length, 3);
    assert.deepEqual(
      outline?.steps.map((step) => step.role),
      ["opening", "branch", "return"]
    );
    assert.equal(outline?.steps[2]?.returnsToFrameId, outline?.steps[0]?.frameId);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("extractSourceDocumentFrames materializes conversation-local branch and return structure", () => {
  const corpus = createConversationCorpus();
  const paths = createPaths();

  try {
    const artifact = extractSourceDocumentFrames(
      corpus,
      "synthetic-hash",
      "/output/normalized/unified/corpus.json",
      paths,
      {
        execSemanticBatch: <T,>() =>
          ({
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              documentId: "conversation:testovaci-sklenik",
              documentSummary:
                "Thread otevře plán zálivky, odbočí k odlišnému záhonu a pak se vrátí k měření celé sestavy.",
              frames: [
                {
                  label: "Výchozí plán zálivky",
                  summary: "Úvodní vymezení záhonů, vlhkosti a průtoku.",
                  outlineRole: "opening",
                  outlineRationale: "Thread nejdřív vymezuje hlavní postup a výchozí měření.",
                  returnTargetSegmentId: null,
                  segmentIds: [
                    "conversation:testovaci-sklenik:turn:1",
                    "conversation:testovaci-sklenik:turn:3"
                  ],
                  subframes: []
                },
                {
                  label: "Prostřední záhon jako místní větev",
                  summary: "Dočasná odbočka k odlišnému typu půdy v jednom záhonu.",
                  outlineRole: "branch",
                  outlineRationale: "Thread se na chvíli větví k jednomu lokálnímu měření.",
                  returnTargetSegmentId: null,
                  segmentIds: ["conversation:testovaci-sklenik:turn:5"],
                  subframes: []
                },
                {
                  label: "Návrat k celkovému měření",
                  summary: "Pozdní část se vrací k porovnání všech záhonů po zálivce.",
                  outlineRole: "return",
                  outlineRationale: "Závěr se vrací k dříve otevřenému hlavnímu problému a zpřesňuje jeho prioritu.",
                  returnTargetSegmentId: "conversation:testovaci-sklenik:turn:1",
                  segmentIds: [
                    "conversation:testovaci-sklenik:turn:7",
                    "conversation:testovaci-sklenik:turn:9"
                  ],
                  subframes: [
                    {
                      label: "Upravený interval jako konkrétní závěr",
                      summary: "Thread převádí výsledky měření do konkrétního intervalu zálivky.",
                      segmentIds: [
                        "conversation:testovaci-sklenik:turn:7",
                        "conversation:testovaci-sklenik:turn:9"
                      ]
                    }
                  ]
                }
              ]
            } as T
          })
      }
    );

    assert.equal(artifact.documentCount, 1);
    assert.equal(artifact.frames[0]?.sourceKind, "conversation");
    assert.equal(artifact.subframes[0]?.sourceKind, "conversation");
    assert.equal(artifact.outlines?.[0]?.sourceKind, "conversation");
    assert.deepEqual(
      artifact.outlines?.[0]?.steps.map((step) => step.role),
      ["opening", "branch", "return"]
    );
    assert.equal(artifact.outlines?.[0]?.steps[2]?.returnsToFrameId, artifact.frames[0]?.id);

    const hintLookup = buildDocumentFrameHintLookup(artifact);
    assert.equal(
      hintLookup.get("conversation:testovaci-sklenik:turn:5")?.label,
      "Prostřední záhon jako místní větev"
    );
    assert.equal(
      hintLookup.get("conversation:testovaci-sklenik:turn:9")?.subframeHints[0]?.label,
      "Upravený interval jako konkrétní závěr"
    );
    assert.deepEqual(artifact.subframes[0]?.segmentIds, [
      "conversation:testovaci-sklenik:turn:7",
      "conversation:testovaci-sklenik:turn:9"
    ]);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("extractSourceDocumentFrames checkpoints each document before a later failure", () => {
  const writing = createWritingCorpus();
  const conversation = createConversationCorpus();
  const corpus: UnifiedCorpus = {
    ...writing,
    options: {
      ...writing.options,
      includedSourceKinds: ["writing", "conversation"]
    },
    documents: [...writing.documents, ...conversation.documents],
    segments: [...writing.segments, ...conversation.segments],
    timeline: [...writing.timeline, ...conversation.timeline],
    primaryTimeline: [...writing.primaryTimeline, ...conversation.primaryTimeline],
    stats: {
      documentCount: 2,
      segmentCount: writing.stats.segmentCount + conversation.stats.segmentCount,
      primarySegmentCount:
        writing.stats.primarySegmentCount + conversation.stats.primarySegmentCount,
      contextSegmentCount: 0,
      documentsBySourceKind: { writing: 1, conversation: 1, chat: 0 },
      segmentsBySourceKind: {
        writing: writing.stats.segmentsBySourceKind.writing,
        conversation: conversation.stats.segmentsBySourceKind.conversation,
        chat: 0
      }
    }
  };
  const paths = createPaths();
  let firstAttemptCalls = 0;

  try {
    assert.throws(
      () =>
        extractSourceDocumentFrames(
          corpus,
          "synthetic-hash",
          "/output/normalized/unified/corpus.json",
          paths,
          {
            execSemanticBatch: <T,>() => {
              firstAttemptCalls += 1;
              if (firstAttemptCalls === 2) {
                throw new Error("simulated later frame failure");
              }
              return {
                args: [],
                exitCode: 0,
                stdout: "",
                stderr: "",
                finalMessage: "",
                jsonEvents: [],
                parsed: {
                  documentId: "conversation:testovaci-sklenik",
                  documentSummary: "Thread o testovacím skleníku.",
                  frames: [
                    {
                      label: "Testovací zálivka",
                      summary: "Jedna souvislá lokální linie.",
                      outlineRole: "opening",
                      outlineRationale: "Thread otevírá plán testovací zálivky.",
                      returnTargetSegmentId: null,
                      segmentIds: conversation.segments.map((segment) => segment.id),
                      subframes: []
                    }
                  ]
                } as T
              };
            }
          }
        ),
      /simulated later frame failure/
    );

    const cachePath = path.join(
      paths.stateDir,
      "semantic-cache",
      "document_frame_cache.json"
    );
    assert.equal(existsSync(cachePath), true);
    assert.equal(Object.keys(JSON.parse(readFileSync(cachePath, "utf8")).entries).length, 1);

    let resumedCalls = 0;
    const artifact = extractSourceDocumentFrames(
      corpus,
      "synthetic-hash",
      "/output/normalized/unified/corpus.json",
      paths,
      {
        execSemanticBatch: <T,>() => {
          resumedCalls += 1;
          return {
            args: [],
            exitCode: 0,
            stdout: "",
            stderr: "",
            finalMessage: "",
            jsonEvents: [],
            parsed: {
              documentId: "writing:zavlazovani",
              documentSummary: "Text o plánu zavlažování.",
              frames: [
                {
                  label: "Plán zavlažování",
                  summary: "Jedna souvislá lokální linie.",
                  outlineRole: "opening",
                  outlineRationale: "Text otevírá výchozí plán zavlažování.",
                  returnTargetSegmentId: null,
                  segmentIds: writing.segments.map((segment) => segment.id),
                  subframes: []
                }
              ]
            } as T
          };
        }
      }
    );

    assert.equal(resumedCalls, 1);
    assert.equal(artifact.documentCount, 2);
    assert.equal(artifact.frameCount, 2);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});
