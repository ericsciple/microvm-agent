// Opt-in URL domain allow-listing for safe-output bodies (gh-aw's `allowed-domains`).
//
// When the workflow author configures `--allowed-domains`, any http(s) link whose
// host isn't allowed is a policy violation. Because we run inline, we REJECT (an
// actionable tool error the agent can fix) rather than silently redacting. When no
// allow-list is configured, we don't domain-filter at all (default behavior).

const LINK = /\bhttps?:\/\/[^\s)<>\]"']+/gi;

function hostAllowed(host, pattern) {
  const p = String(pattern).toLowerCase().trim();
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return host === base || host.endsWith("." + base);
  }
  return host === p;
}

/**
 * Throw if `text` contains a link whose domain isn't in `allowed`. No-op when the
 * allow-list is empty.
 * @param {string} text
 * @param {string[]} allowed - domains (supports leading `*.` wildcard)
 */
export function checkAllowedDomains(text, allowed) {
  if (!allowed || !allowed.length) return;
  const urls = String(text).match(LINK) || [];
  const bad = new Set();
  for (const u of urls) {
    let host;
    try {
      host = new URL(u).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!allowed.some((d) => hostAllowed(host, d))) bad.add(host);
  }
  if (bad.size) {
    throw new Error(
      `These link domains are not permitted by this workflow: ${[...bad].join(", ")}. ` +
        `Allowed domains: ${allowed.join(", ")}.`
    );
  }
}
