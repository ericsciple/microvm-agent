// Branch-name generation + base-branch resolution for create-pull-request, aligned
// with gh-aw's behavior (verified in its create_pull_request.cjs / ADR 30071):
//   - The head branch is GENERATED host-side — the agent never names the target
//     branch (consistent with "the target is not agent-selectable"). Shape:
//     `<branch-prefix><workflow>-<randomHex>`.
//   - The base branch defaults to the repo's DEFAULT branch (decoupled from the
//     triggering event), overridable by the author via `--base-branch`.

import { randomBytes } from "node:crypto";

/**
 * Generate a unique, safe head branch name. `--branch-prefix` is author-supplied.
 * @param {{branchPrefix?: string}} config
 * @param {Object} [env]
 * @returns {string}
 */
export function generateBranchName(config = {}, env = process.env) {
  const prefix = config.branchPrefix ? String(config.branchPrefix) : "";
  const wf = String(env.GITHUB_WORKFLOW || "agent")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "agent";
  const hex = randomBytes(4).toString("hex");
  return `${prefix}${wf}-${hex}`.replace(/[^A-Za-z0-9._/-]/g, "-");
}

/**
 * Resolve the base branch a pull request should target. Default = the repo's
 * default branch (one GET); `--base-branch` overrides (author-supplied only).
 * @param {{request: Function}} github
 * @param {{owner: string, repo: string}} ctx
 * @param {{baseBranch?: string}} config
 * @returns {Promise<string>}
 */
export async function resolveBaseBranch(github, ctx, config = {}) {
  if (config.baseBranch) return String(config.baseBranch);
  const repo = await github.request("GET", `/repos/${ctx.owner}/${ctx.repo}`);
  const def = repo && repo.default_branch;
  if (!def) throw new Error(`Could not resolve the default branch of ${ctx.owner}/${ctx.repo}.`);
  return def;
}

/**
 * Resolve the base branch AND its current tip commit SHA — the point the new head
 * branch is created from (and the `createCommitOnBranch` parent). The guest never
 * supplies a base SHA; the changes are committed onto the base branch's tip.
 * @param {{request: Function}} github
 * @param {{owner: string, repo: string}} ctx
 * @param {{baseBranch?: string}} config
 * @returns {Promise<{branch: string, sha: string}>}
 */
export async function resolveBaseRef(github, ctx, config = {}) {
  const branch = await resolveBaseBranch(github, ctx, config);
  const ref = await github.request("GET", `/repos/${ctx.owner}/${ctx.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const sha = ref && ref.object && ref.object.sha;
  if (!sha) throw new Error(`Could not resolve the tip of base branch '${branch}' in ${ctx.owner}/${ctx.repo}.`);
  return { branch, sha };
}
