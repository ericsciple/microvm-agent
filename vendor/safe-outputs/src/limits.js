// Run-wide call-count limit (gh-aw's `max` semantics: at most N calls to this tool
// per run, not N items per call).
//
// Our server is spawned fresh per call (stateless), so the count lives in a file. The
// harness gives each configured MCP server instance a private, per-(step, instance)
// dir via MCP_STATE_DIR; each attempt appends one claim line and takes its ordinal.
// Atomic small POSIX appends make this lock-free and never over-count: at most `max`
// claims can have ordinal <= max, so at most `max` writes proceed.
//
// Only reached after schema validation + right before the write, so a validation
// reject burns no budget; a claimed-but-then-failed write consumes its slot (matches
// gh-aw, which increments before the write and does not refund).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the effective cap. `-1` = unlimited. Falls back to `defaultMax`.
 * @returns {number|undefined} the cap, or undefined for "no limit"
 */
export function resolveMax(raw, defaultMax) {
  if (raw === undefined) return defaultMax;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return defaultMax;
  if (n < 0) return undefined; // -1 (or any negative) = unlimited
  return n;
}

/**
 * Claim one call against the run-wide cap. Throws an actionable tool error when the
 * cap is exceeded. No-op when there is no cap.
 * @param {string} opId
 * @param {{max?: string|number}} [config]
 * @param {number} [defaultMax]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function claimCall(opId, config = {}, defaultMax = undefined, env = process.env) {
  const max = resolveMax(config.max, defaultMax);
  if (max === undefined) return; // unlimited / no cap
  const dir =
    env.MCP_STATE_DIR ||
    path.join(env.RUNNER_TEMP || os.tmpdir(), "safe-outputs-state");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // If we can't create the state dir, don't block the write — best effort.
    return;
  }
  const file = path.join(dir, `calls-${opId}.log`);
  fs.appendFileSync(file, "1\n"); // atomic claim; one line per attempt
  const ordinal = countLines(file);
  if (ordinal > max) {
    throw new Error(
      `This safe output has reached its per-run limit of ${max} call${max === 1 ? "" : "s"}.`
    );
  }
}

function countLines(file) {
  const text = fs.readFileSync(file, "utf8");
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}
