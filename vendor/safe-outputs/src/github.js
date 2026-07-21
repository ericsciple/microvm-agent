// Minimal GitHub REST client (zero dependencies, built-in fetch).
//
// The client holds the job token and runs host-side; the sandboxed agent never
// sees it. Only the small set of calls the safe outputs need are exercised, but
// `request()` is generic.

const DEFAULT_API_URL = "https://api.github.com";

/**
 * @param {Object} [options]
 * @param {string} [options.token] - the GitHub token (job token)
 * @param {string} [options.apiUrl] - API base URL (GHES-aware via GITHUB_API_URL)
 * @param {Function} [options.fetchImpl] - fetch implementation (for tests)
 */
export function createGitHubClient({ token, apiUrl, fetchImpl } = {}) {
  const authToken = token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!authToken) {
    throw new Error("No GitHub token available (set GITHUB_TOKEN).");
  }
  const base = apiUrl || process.env.GITHUB_API_URL || DEFAULT_API_URL;
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("No fetch implementation available (Node >= 18 provides a global fetch).");
  }

  async function request(method, path, body) {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${authToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "safe-outputs",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const message = data && data.message ? data.message : res.statusText;
      throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${message}`);
    }
    return data;
  }

  // GraphQL v4 (Discussions and other GraphQL-only surfaces). Same fetch/auth as REST;
  // GraphQL returns HTTP 200 even on errors, so we check the `errors` array.
  async function graphql(query, variables = {}) {
    const url = process.env.GITHUB_GRAPHQL_URL || `${base.replace(/\/$/, "")}/graphql`;
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "safe-outputs",
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!res.ok) {
      throw new Error(`GitHub GraphQL failed: ${res.status} ${res.statusText}`);
    }
    if (data.errors && data.errors.length) {
      throw new Error(`GitHub GraphQL error: ${data.errors.map((e) => e.message).join("; ")}`);
    }
    return data.data;
  }

  return { request, graphql };
}
