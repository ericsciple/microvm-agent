// Host-side handling of the UNTRUSTED guest serial console.
//
// The guest's stdout is streamed to the Action's step log, but the runner interprets
// ANY `::command::` line on stdout — so a compromised/hallucinating guest could inject
// capability workflow commands (::set-output::, ::add-path::, ::save-state::,
// ::stop-commands::, …). We pass through only the informational, no-capability
// annotations (so agent errors/warnings surface INLINE) and neutralize the rest.
//
// Grading (gradeConsoleText) reads the RAW captured console (ground truth), not the
// filtered live stream.

import { REPORT_INCOMPLETE_SENTINEL } from "./guest-assets.js";

// Workflow commands the guest may emit verbatim: informational only, no capability or
// state change. Everything else is neutralized.
export const ALLOWED_GUEST_COMMANDS = new Set([
  "error",
  "warning",
  "notice",
  "debug",
  "group",
  "endgroup",
]);

/**
 * Pass a guest console line through unchanged unless it is a workflow command that
 * isn't on the informational allowlist, in which case neutralize every `::` in the
 * line (insert a zero-width space between the colons) so the runner won't interpret it.
 * @param {string} line
 * @returns {string}
 */
export function filterConsoleLine(line) {
  const m = line.match(/^\s*::([A-Za-z][A-Za-z0-9_-]*)/);
  if (!m) return line; // not a workflow command → pass through
  if (ALLOWED_GUEST_COMMANDS.has(m[1].toLowerCase())) return line; // safe annotation
  return "[microvm-agent blocked workflow command] " + line.replace(/::/g, ":\u200b:");
}

/**
 * Grade a run from the captured (raw) guest console text. Three layers:
 *  1. never reached the agent ("starting copilot" absent) → "failed";
 *  2. the agent self-declared it couldn't finish (report-incomplete sentinel) → "incomplete";
 *  3. the guest agent's own exit code (AGENT_EXIT): non-zero, or never reported
 *     (crash/hang/timeout before it printed) → "failed"; exactly 0 → "completed".
 * @param {string} text
 * @returns {"failed"|"incomplete"|"completed"}
 */
export function gradeConsoleText(text) {
  if (!/GUEST: starting copilot/.test(text)) return "failed";
  if (text.includes(REPORT_INCOMPLETE_SENTINEL)) return "incomplete";
  const m = text.match(/GUEST: AGENT_EXIT=(\d+)/);
  if (!m || Number(m[1]) !== 0) return "failed";
  return "completed";
}
