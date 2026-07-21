// Tiny glob matcher for label allow/block lists (gh-aw supports `*` wildcard
// patterns, e.g. `*[bot]`). Only `*` is special; everything else is literal.

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} value
 * @param {string} pattern - may contain `*` wildcards
 * @returns {boolean}
 */
export function matchesGlob(value, pattern) {
  const re = new RegExp("^" + String(pattern).split("*").map(escapeRegex).join(".*") + "$");
  return re.test(String(value));
}

/**
 * Parse a comma-separated flag value into a trimmed, non-empty list.
 * @param {string|undefined} raw
 * @returns {string[]}
 */
export function parseList(raw) {
  if (raw === undefined || raw === true) return [];
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
