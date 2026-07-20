import { test } from "node:test";
import assert from "node:assert/strict";

import { filterConsoleLine, gradeConsoleText } from "../src/console-filter.js";
import { REPORT_INCOMPLETE_SENTINEL } from "../src/guest-assets.js";

// --- filterConsoleLine: injection guard ---

test("filterConsoleLine passes plain output through unchanged", () => {
  assert.equal(filterConsoleLine("hello world"), "hello world");
  assert.equal(filterConsoleLine("=== GUEST: starting copilot ==="), "=== GUEST: starting copilot ===");
  assert.equal(filterConsoleLine(""), "");
});

test("filterConsoleLine allows informational annotations verbatim (inline errors)", () => {
  for (const cmd of ["error", "warning", "notice", "debug", "group", "endgroup"]) {
    const line = `::${cmd}::something happened`;
    assert.equal(filterConsoleLine(line), line, `${cmd} should pass through`);
  }
  // Annotations with properties still pass.
  assert.equal(
    filterConsoleLine("::error file=app.js,line=1::boom"),
    "::error file=app.js,line=1::boom"
  );
});

test("filterConsoleLine neutralizes capability/state workflow commands", () => {
  for (const cmd of ["set-output", "save-state", "add-path", "set-env", "add-mask", "stop-commands", "echo"]) {
    const out = filterConsoleLine(`::${cmd}::payload`);
    assert.ok(out.startsWith("[microvm-agent blocked workflow command]"), `${cmd} blocked`);
    // The '::' token is broken so the runner won't interpret it.
    assert.ok(!/(^|\s)::[a-z]/.test(out.replace("[microvm-agent blocked workflow command] ", "")), `${cmd} '::' broken`);
  }
});

test("filterConsoleLine neutralizes ALL '::' on a blocked line (mid-line injection)", () => {
  const out = filterConsoleLine("::set-env::x=1::stop-commands::tok");
  assert.ok(!out.includes("::set-env::"));
  assert.ok(!out.includes("::stop-commands::"));
});

test("filterConsoleLine is case-insensitive on the command name", () => {
  const out = filterConsoleLine("::SET-OUTPUT::x");
  assert.ok(out.startsWith("[microvm-agent blocked workflow command]"));
});

// --- gradeConsoleText: three-layer result model ---

test("gradeConsoleText: never reached the agent -> failed", () => {
  assert.equal(gradeConsoleText("boot messages only"), "failed");
});

test("gradeConsoleText: started + AGENT_EXIT=0 -> completed", () => {
  const text = "=== GUEST: starting copilot ===\n...work...\n=== GUEST: AGENT_EXIT=0 ===\n";
  assert.equal(gradeConsoleText(text), "completed");
});

test("gradeConsoleText: started then crashed (AGENT_EXIT!=0) -> failed", () => {
  const text = "=== GUEST: starting copilot ===\nboom\n=== GUEST: AGENT_EXIT=1 ===\n";
  assert.equal(gradeConsoleText(text), "failed");
});

test("gradeConsoleText: started but no AGENT_EXIT (hang/timeout) -> failed", () => {
  const text = "=== GUEST: starting copilot ===\nstill working when reaped\n";
  assert.equal(gradeConsoleText(text), "failed");
});

test("gradeConsoleText: report-incomplete sentinel -> incomplete (even with exit 0)", () => {
  const text = `=== GUEST: starting copilot ===\n::error::cannot do it\n${REPORT_INCOMPLETE_SENTINEL}\n=== GUEST: AGENT_EXIT=0 ===\n`;
  assert.equal(gradeConsoleText(text), "incomplete");
});
