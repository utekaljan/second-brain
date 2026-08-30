import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import type { ThoughtCompilerBatch, ThoughtNode } from "./types.js";

const THOUGHT_COMPILER_DEFAULTS = SECOND_BRAIN_DEFAULTS.thoughtCompiler;
const OUTPUT_LANGUAGE = SECOND_BRAIN_DEFAULTS.language;

/**
 * Small reusable hint bundle from already-compiled nodes.
 *
 * This is intentionally tiny so later batches can reuse canonical names
 * without polluting the prompt with the whole graph.
 */
type ExistingNodeHint = Pick<ThoughtNode, "canonicalKey" | "title" | "nodeType">;

/**
 * Turn already-compiled nodes into a compact hint list for later batches.
 */
export function buildExistingNodeHints(nodes: ThoughtNode[]): ExistingNodeHint[] {
  return nodes
    .slice()
    // Evidence count is a cheap proxy for "how established is this node
    // already". We want the most reusable identities, not a random sample.
    .sort((left, right) => right.evidence.length - left.evidence.length)
    .slice(0, THOUGHT_COMPILER_DEFAULTS.maxExistingNodeHints)
    .map((node) => ({
      canonicalKey: node.canonicalKey,
      title: node.title,
      nodeType: node.nodeType
    }));
}

/**
 * Build the model prompt for one semantic batch.
 *
 * The prefix is kept stable on purpose so repeated runs can benefit from
 * prompt caching and so output behavior stays comparable across reruns.
 */
export function buildThoughtBatchPrompt(
  batch: ThoughtCompilerBatch,
  options?: { existingNodeHints?: ExistingNodeHint[] }
): string {
  const existingNodeHints = options?.existingNodeHints ?? [];
  // The payload stays intentionally small and regular. This makes prompt
  // caching more plausible and keeps manual debugging of one batch realistic.
  const payload = {
    batchId: batch.batchId,
    items: batch.items.map((item) => ({
      inputId: item.inputId,
      sourceKind: item.sourceKind,
      documentTitle: item.documentTitle,
      chronologyIndex: item.chronologyIndex,
      time: item.time,
      segmentLabel: item.segmentLabel,
      text: item.text,
      localContext: item.localContext ?? null,
      documentFrameHint: item.documentFrameHint ?? null
    })),
    existingNodeHints
  };

  return [
    "Komponuješ kandidáty thought-node z uživatelských normalizovaných primárních segmentů.",
    "Systém je zaměřený na mysl uživatele: preferuj vracející se otázky, osobní teze, témata, napětí a vývojové linie v jeho myšlení.",
    "Neanalyzuj to jako extrakci klíčových slov. Každý segment čti sémanticky.",
    `Pro každý inputId vrať nejvýše ${THOUGHT_COMPILER_DEFAULTS.maxCandidatesPerInput} trvalejší kandidáty node, nebo prázdné pole nodeCandidates, pokud segment nenese dost silný trvalejší signál.`,
    "U osobních authored writings je běžné, že jeden odstavec nese víc než jeden trvalý signál. Nezplošťuj jej automaticky do jedné obecné teze.",
    "Když odstavec současně obsahuje hlavní tezi, napětí, korekci, otázku nebo vývojovou linku, vrať pro tyto vrstvy samostatné kandidáty.",
    "Stejnou dekompozici proveď u delších reflektivních conversation turnů. Délka sama není důvod k více node, ale před vrácením jednoho umbrella node výslovně zkontroluj, zda turn nespojuje několik samostatně trvalých tezí, otázek, napětí, korekcí nebo důsledků.",
    `Pokud delší conversation turn skutečně obsahuje více nezávislých trvalých signálů, vrať 2-${THOUGHT_COMPILER_DEFAULTS.maxCandidatesPerInput} přesné kandidáty. Neslučuj například uživatelovu tezi, její mez nebo protiargument a navazující otevřenou otázku jen proto, že jsou v jednom turnu.`,
    "U velmi dlouhého reflektivního turnu systematicky projdi alespoň hlavní tvrzení, jeho hranici nebo protiargument, otevřenou otázku a důsledek. Vrať jen vrstvy, které jsou samostatně trvalé, ale neskonči u prvního nalezeného tématu.",
    "Naopak krátké provozní pokyny, žádosti o vyhledání či přeformátování, poděkování a čistě přechodové dialogové věty mohou zůstat bez kandidáta. Nevyráběj hustotu ze šumu.",
    "Stručnou explicitní otázku nebo korekci nevynechávej jen kvůli délce, pokud sama zakládá trvalou vývojovou linii nebo mění interpretaci předchozího tvrzení.",
    "Za trvalý krátký signál považuj zejména otázku, která určuje centrální diagnózu threadu nebo hledá rozhodující protiargument, i když je formulována jako přímá žádost o odpověď.",
    "Krátká oprava typu chybí ti určité kritérium je trvalý signál tehdy, když toto kritérium mění rámec hodnocení; zachyť kritérium nebo napětí, ne samotný dialogový akt opravy.",
    "Výslovný uživatelův požadavek číst několik postojů jako jednu vývojovou linii je silný thread signál, nikoli provozní instrukce k formátování.",
    "Lepší je několik přesných stabilních node než jeden široký umbrella node, který skryje vnitřní strukturu autorova myšlení.",
    "Výstup musí obsahovat přesně jednu položku pro každý inputId v batchi.",
    "Pokud je to zjevně stejný thought-node, znovu použij canonicalKey z existingNodeHints.",
    "canonicalKey musí být krátký, ASCII, ve formátu kebab-case a stabilní mezi běhy.",
    `Všechny přirozenojazyčné výstupní hodnoty piš v jazyce ${OUTPUT_LANGUAGE.outputLabel} (${OUTPUT_LANGUAGE.output}). Nepřekládej uživatelovo myšlení do angličtiny.`,
    "Pole title, summary a rationale mají být v tomto výchozím jazyce. Zachovej uživatelovu terminologii co nejpřesněji.",
    // These instructions mirror the structured-output schema. Being explicit
    // here avoids live failures where the model omits keys that the schema now
    // requires on every candidate object.
    "Pole claim vracej vždy. Pokud se nehodí, použij null. Jinak ho vyplň jako krátkou tvrzovací nebo otázkovou formulaci jádra daného node.",
    "Pole identityAliases vracej vždy jako pole. Když nemáš dobré aliasy, vrať prázdné pole [].",
    "Pole documentFrameId, documentSubframeId a frameRole vracej vždy. Když pro daný segment není lokální frame hint nebo se node nedá smysluplně zařadit, použij null.",
    "Pole relationProposals vracej vždy jako pole. Když není zřejmý vztah, vrať prázdné pole []. Povolené typy jsou semantic_related, supports, tensions_with, revises, supersedes, context_split.",
    "context_split použij tehdy, když dvě formulace mohou koexistovat v odlišném rámci nebo podmínkách a nejde o přímý rozpor.",
    "tensions_with použij tehdy, když mezi dvěma myšlenkami cítíš skutečné napětí nebo nevyřešený rozpor.",
    "revises nebo supersedes používej opatrně a jen když segment opravdu naznačuje pozdější opravu nebo překonání jiné formulace.",
    "Když segment nese documentFrameHint, ber jej jako širší lokální rodičovský rámec daného zdroje. Nevymýšlej nový parent label mimo poskytnutý hint.",
    "Pokud v documentFrameHint existují subframeHints, použij documentSubframeId jen když node opravdu patří do jedné z těchto vnitřních větví.",
    "frameRole má popsat místní roli node uvnitř daného frame: main_claim, subclaim, question, tension, revision_branch.",
    "summary má popisovat samotný node, ne batch.",
    "rationale má vysvětlit, proč daný segment podporuje právě tento node.",
    "relatedCanonicalKeys mají obsahovat jen canonical keys, které s daným segmentovým signálem skutečně souvisejí.",
    "Vrať pouze JSON. Žádný doprovodný text mimo schema.",
    "",
    "Batch payload:",
    JSON.stringify(payload, null, 2)
  ].join("\n");
}
