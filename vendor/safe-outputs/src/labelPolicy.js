// Shared label allow/block/count policy for label operations (add-labels,
// remove-labels). Author-supplied flags; the agent supplies only the label names.

import { matchesGlob, parseList } from "./glob.js";
import { resolveMax } from "./limits.js";

/**
 * Enforce --allowed / --blocked (glob) and the per-call cap (--max, doubling as the
 * label-count cap for label ops). Throws an actionable tool error on violation.
 * @param {string[]} labels
 * @param {{allowed?: string, blocked?: string, max?: string}} config
 * @param {number} defaultMax
 */
export function enforceLabelPolicy(labels, config = {}, defaultMax = 3) {
  const allowed = parseList(config.allowed);
  if (allowed.length) {
    const disallowed = labels.filter((l) => !allowed.some((p) => matchesGlob(l, p)));
    if (disallowed.length) {
      throw new Error(
        `These labels are not permitted by this workflow: ${disallowed.map((l) => `'${l}'`).join(", ")}. ` +
          `Allowed: ${allowed.map((l) => `'${l}'`).join(", ")}.`
      );
    }
  }

  const blocked = parseList(config.blocked);
  if (blocked.length) {
    const hit = labels.filter((l) => blocked.some((p) => matchesGlob(l, p)));
    if (hit.length) {
      throw new Error(`These labels are blocked by this workflow: ${hit.map((l) => `'${l}'`).join(", ")}.`);
    }
  }

  const max = resolveMax(config.max, defaultMax);
  if (max !== undefined && labels.length > max) {
    throw new Error(
      `Too many labels: ${labels.length} requested but this workflow allows at most ${max} per call.`
    );
  }
}
