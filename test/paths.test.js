import { test } from "node:test";
import assert from "node:assert/strict";
import { translateToolCachePathEntries } from "../src/paths.js";

const HOST = "/opt/hostedtoolcache";
const GUEST = "/__t";

test("translates only entries under the host tool cache, rewriting the prefix", () => {
  const pathEnv = ["/usr/local/bin", `${HOST}/node/20.1.0/x64/bin`, "/usr/bin", `${HOST}/go/1.22/x64/bin`].join(":");
  assert.deepEqual(translateToolCachePathEntries(pathEnv, HOST, GUEST), [
    "/__t/node/20.1.0/x64/bin",
    "/__t/go/1.22/x64/bin",
  ]);
});

test("returns nothing when no PATH entry is under the tool cache", () => {
  assert.deepEqual(translateToolCachePathEntries("/usr/bin:/bin", HOST, GUEST), []);
});

test("does not match a sibling directory sharing a prefix", () => {
  const pathEnv = `/opt/hostedtoolcache-other/bin:${HOST}/node/x/bin`;
  assert.deepEqual(translateToolCachePathEntries(pathEnv, HOST, GUEST), ["/__t/node/x/bin"]);
});

test("dedupes repeated entries and preserves order", () => {
  const pathEnv = `${HOST}/a/bin:${HOST}/a/bin:${HOST}/b/bin`;
  assert.deepEqual(translateToolCachePathEntries(pathEnv, HOST, GUEST), ["/__t/a/bin", "/__t/b/bin"]);
});

test("tolerates a trailing slash on the host tool cache", () => {
  assert.deepEqual(translateToolCachePathEntries(`${HOST}/n/bin`, HOST + "/", GUEST), ["/__t/n/bin"]);
});

test("empty/absent inputs yield no entries", () => {
  assert.deepEqual(translateToolCachePathEntries("", HOST, GUEST), []);
  assert.deepEqual(translateToolCachePathEntries(`${HOST}/n/bin`, "", GUEST), []);
});
