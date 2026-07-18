// Translate host PATH entries that live under the tool cache into the guest's
// tool-cache mount point.
//
// The tool cache is mounted at a different path in the guest (/__t) than on the
// host (e.g. /opt/hostedtoolcache), mirroring Actions container jobs. A step run
// before this action (e.g. setup-node) may have prepended tool-cache bin dirs to
// PATH like `/opt/hostedtoolcache/node/20.x/x64/bin`. We do NOT copy the whole
// host PATH into the guest (host-specific dirs that don't exist there are noise);
// we take ONLY the entries under the host tool-cache dir, rewrite their prefix to
// the guest mount point, and return them so they can be prepended to the guest
// PATH — but only when the tool cache is actually mounted.

/**
 * @param {string} pathEnv - the host PATH value (colon-separated)
 * @param {string} hostToolCache - host tool-cache dir (e.g. /opt/hostedtoolcache)
 * @param {string} guestToolCache - guest mount point (e.g. /__t)
 * @returns {string[]} translated guest PATH entries (deduped, order preserved)
 */
export function translateToolCachePathEntries(pathEnv, hostToolCache, guestToolCache) {
  if (!pathEnv || !hostToolCache || !guestToolCache) return [];
  const prefix = stripTrailingSlash(hostToolCache);
  const seen = new Set();
  const out = [];
  for (const raw of pathEnv.split(":")) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry === prefix || entry.startsWith(prefix + "/")) {
      const translated = guestToolCache + entry.slice(prefix.length);
      if (!seen.has(translated)) {
        seen.add(translated);
        out.push(translated);
      }
    }
  }
  return out;
}

function stripTrailingSlash(p) {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}
