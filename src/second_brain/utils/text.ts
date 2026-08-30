/**
 * Convert a label into a stable ASCII slug for IDs and filenames.
 */
export function slugify(value: string): string {
  // Slugs are ASCII-only on purpose so file names and IDs stay stable across
  // shells, operating systems, and downstream export targets.
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/**
 * Count words with a lightweight whitespace split.
 */
export function countWords(text: string): number {
  // Early metrics do not need linguistic sophistication; a whitespace split is
  // enough for diagnostics and rough sizing.
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }

  return trimmed.split(/\s+/).length;
}

/**
 * Return the first non-empty line from a text block.
 */
export function firstNonEmptyLine(text: string): string | null {
  // Essays often start with a title line, so this is a practical fallback for
  // deriving a readable label before any richer parsing exists.
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}
