import { createHash } from "node:crypto";

/**
 * Canonical JSON serialization for cache identities.
 *
 * Object keys and set-like arrays are sorted so transport ordering and pretty
 * printing cannot invalidate expensive semantic work. Callers must only pass
 * arrays whose order is not itself meaningful.
 */
export function stableSetJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSetJson(item)).sort().join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSetJson(item)}`)
    .join(",")}}`;
}

/** Hash a canonical set-like payload with SHA-256. */
export function hashStableSet(value: unknown): string {
  return createHash("sha256").update(stableSetJson(value)).digest("hex");
}

/** Hash a string exactly as stored on disk. */
export function hashExactText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
