// Event context binding.
//
// A safe output is bound to the *triggering* issue or pull request: the agent
// says "add these labels", never "to which issue". That target comes from the
// workflow event payload on disk (GITHUB_EVENT_PATH), plus GITHUB_REPOSITORY,
// which are available host-side where these servers run. The sandboxed agent
// never sees them.

import { readFileSync } from "node:fs";

/**
 * Load the triggering context from the environment.
 * @param {Object} [env] - environment (defaults to process.env)
 * @param {Function} [readFile] - readFileSync-compatible reader (for tests)
 * @returns {{owner?: string, repo?: string, issueNumber?: number, headBranch?: string, baseBranch?: string, payload: object}}
 */
export function loadContext(env = process.env, readFile = readFileSync) {
  let payload = {};
  const eventPath = env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      payload = JSON.parse(readFile(eventPath, "utf8"));
    } catch (e) {
      throw new Error(`Failed to read event payload from GITHUB_EVENT_PATH (${eventPath}): ${e.message}`);
    }
  }

  let owner;
  let repo;
  if (env.GITHUB_REPOSITORY && env.GITHUB_REPOSITORY.includes("/")) {
    [owner, repo] = env.GITHUB_REPOSITORY.split("/");
  } else if (payload.repository) {
    owner = payload.repository.owner && payload.repository.owner.login;
    repo = payload.repository.name;
  }

  // Both issues and pull requests are addressed via the issues API for labels
  // and comments, so a single "issueNumber" covers both.
  const issueNumber =
    (payload.issue && payload.issue.number) ??
    (payload.pull_request && payload.pull_request.number) ??
    undefined;

  // The branch that holds the agent's committed changes (set host-side by the
  // harness) and the branch a pull request should target. These are context, not
  // agent input, so create-pull-request can bind them without letting the agent
  // choose a different head/base.
  const headBranch = env.GITHUB_HEAD_BRANCH || undefined;
  const baseBranch = env.GITHUB_BASE_BRANCH || undefined;

  return { owner, repo, issueNumber, headBranch, baseBranch, payload };
}

/**
 * Assert that we have enough context to act on the triggering issue/PR.
 * Throws an actionable error otherwise.
 */
export function requireIssueContext(ctx) {
  if (!ctx.owner || !ctx.repo) {
    throw new Error("Could not determine the repository from GITHUB_REPOSITORY or the event payload.");
  }
  if (!ctx.issueNumber) {
    throw new Error(
      "This safe output acts on the triggering issue or pull request, but the event payload has no issue/PR number. " +
        "Run it on an issue or pull_request event."
    );
  }
  return ctx;
}

/**
 * Assert that we have enough context to open a pull request. The head branch is
 * bound host-side (the branch the harness committed the agent's work to); the
 * agent never chooses it.
 */
export function requirePullRequestContext(ctx) {
  if (!ctx.owner || !ctx.repo) {
    throw new Error("Could not determine the repository from GITHUB_REPOSITORY or the event payload.");
  }
  if (!ctx.headBranch) {
    throw new Error(
      "No source branch is bound for this pull request. The harness must set GITHUB_HEAD_BRANCH to the branch " +
        "holding the agent's committed changes."
    );
  }
  if (!ctx.baseBranch) {
    throw new Error(
      "No base branch is bound for this pull request. The harness must set GITHUB_BASE_BRANCH to the branch the " +
        "pull request should target (e.g. the repository's default branch)."
    );
  }
  return ctx;
}
