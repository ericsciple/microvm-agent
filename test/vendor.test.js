import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The safe-outputs CLI is vendored into the action (scripts/vendor-safe-outputs.sh) and
// put on PATH at runtime, so `command: "safe-outputs"` works in-the-box. These tests guard
// that the vendored copy is present, marked ESM, and actually runnable — a missing/broken
// vendor would silently break every safe output.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(ROOT, "vendor", "safe-outputs");
const CLI = path.join(VENDOR, "src", "cli.js");

test("vendored safe-outputs CLI exists", () => {
  assert.ok(fs.existsSync(CLI), `expected vendored CLI at ${CLI} (run scripts/vendor-safe-outputs.sh)`);
});

test("vendored copy has a package.json marking it ESM", () => {
  const pkgPath = path.join(VENDOR, "package.json");
  assert.ok(fs.existsSync(pkgPath), "vendored package.json missing");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  assert.equal(pkg.type, "module", "vendored package.json must set type=module (safe-outputs is ESM)");
});

test("vendored copy records the pinned ref in .complete", () => {
  const marker = path.join(VENDOR, ".complete");
  assert.ok(fs.existsSync(marker), ".complete marker missing (vendoring did not finish)");
  assert.ok(fs.readFileSync(marker, "utf8").trim().length > 0, ".complete should record the vendored ref");
});

test("vendored copy carries no test files (lean)", () => {
  const stray = fs
    .readdirSync(path.join(VENDOR, "src"), { recursive: true })
    .filter((f) => String(f).endsWith(".test.js"));
  assert.deepEqual(stray, [], "vendored src should not include .test.js files");
});

test("vendored CLI runs and lists operations", () => {
  // `--help` prints usage to stderr and exits 0; capture both streams.
  const r = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  assert.match(out, /Runs an MCP \(stdio\) server for one safe output/);
  assert.match(out, /add-labels/);
  assert.match(out, /create-pull-request/);
});
