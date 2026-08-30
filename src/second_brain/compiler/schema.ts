import { SECOND_BRAIN_DEFAULTS } from "../config.js";

const THOUGHT_COMPILER_DEFAULTS = SECOND_BRAIN_DEFAULTS.thoughtCompiler;

/**
 * Structured-output contract for one Codex semantic batch.
 *
 * Keeping this in code makes the execution path inspectable and lets tests
 * validate the exact shape the compiler expects back from Codex.
 */
export const THOUGHT_BATCH_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    batchId: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          inputId: { type: "string" },
          nodeCandidates: {
            type: "array",
            maxItems: THOUGHT_COMPILER_DEFAULTS.maxCandidatesPerInput,
            items: {
              type: "object",
              properties: {
                canonicalKey: { type: "string" },
                title: { type: "string" },
                nodeType: {
                  type: "string",
                  enum: ["question", "thesis", "theme", "tension", "thread"]
                },
                status: {
                  type: "string",
                  enum: ["active", "tentative", "unresolved", "revised"]
                },
                summary: { type: "string" },
                rationale: { type: "string" },
                // OpenAI structured outputs currently require every declared
                // property to appear in `required`. Optionality therefore has to
                // be expressed as `null` or empty arrays, not by omitting keys.
                claim: { type: ["string", "null"] },
                identityAliases: {
                  type: "array",
                  items: { type: "string" }
                },
                documentFrameId: { type: ["string", "null"] },
                documentSubframeId: { type: ["string", "null"] },
                frameRole: {
                  type: ["string", "null"],
                  enum: [
                    "main_claim",
                    "subclaim",
                    "question",
                    "tension",
                    "revision_branch",
                    null
                  ]
                },
                relatedCanonicalKeys: {
                  type: "array",
                  items: { type: "string" }
                },
                relationProposals: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      targetCanonicalKey: { type: "string" },
                      type: {
                        type: "string",
                        enum: [
                          "semantic_related",
                          "supports",
                          "tensions_with",
                          "revises",
                          "supersedes",
                          "context_split"
                        ]
                      },
                      rationale: { type: "string" }
                    },
                    required: ["targetCanonicalKey", "type", "rationale"],
                    additionalProperties: false
                  }
                }
              },
              required: [
                "canonicalKey",
                "title",
                "nodeType",
                "status",
                "summary",
                "rationale",
                "claim",
                "identityAliases",
                "documentFrameId",
                "documentSubframeId",
                "frameRole",
                "relatedCanonicalKeys",
                "relationProposals"
              ],
              additionalProperties: false
            }
          }
        },
        required: ["inputId", "nodeCandidates"],
        additionalProperties: false
      }
    }
  },
  required: ["batchId", "items"],
  additionalProperties: false
} as const;
