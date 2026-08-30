import { createHash } from "node:crypto";

/**
 * Consolidated family IDs must survive unrelated inserts elsewhere in the
 * graph, so they derive from durable membership identity rather than position.
 */
export function buildStableConsolidatedFamilyId(options: {
  canonicalKey: string;
  memberNodeIds: string[];
}): string {
  const memberNodeIds = Array.from(new Set(options.memberNodeIds)).sort((left, right) =>
    left.localeCompare(right)
  );
  const membershipHash = createHash("sha256")
    .update(JSON.stringify(memberNodeIds))
    .digest("hex")
    .slice(0, 12);

  return `consolidated:${membershipHash}:${options.canonicalKey}`;
}
