// Safe output: create-pull-request.
//
// Opens a pull request from a set of FILE CHANGES the agent produced in the guest
// workspace. The agent invokes this like any other MCP tool via its shim, passing the
// changed paths (--add/--delete); the generic shim reads those files (base64) from the
// workspace and ships them as `additions`/`deletions`. This host-side server — where
// the real token lives — resolves the base branch (repo default, or --base-branch),
// creates a head branch at the base tip, commits the changes as ONE signed commit
// (GraphQL createCommitOnBranch), and opens the PR.
//
// The head branch is GENERATED host-side (the agent never names it); the base is the
// repo default branch unless the author sets --base-branch. This is the guest->host
// data path (see docs/parity-gh-aw.md §2.0). NB: the guest supplies no base SHA — the
// change set is committed onto the base branch's current tip.

import { sanitizeText, sanitizeTitle } from "../sanitize.js";
import { withFooter } from "../footer.js";
import { checkAllowedDomains } from "../domains.js";
import { parseList } from "../glob.js";
import { applyChangeset, normalizeChangeset } from "../changeset.js";
import { generateBranchName, resolveBaseRef } from "../branches.js";

const fileChangeSchema = {
  additions: {
    type: "array",
    description: "Files to add or overwrite, each with its FULL new contents base64-encoded.",
    items: {
      type: "object",
      required: ["path", "contents"],
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1, description: "Repo-relative file path." },
        contents: { type: "string", description: "The file's full contents, base64-encoded." },
      },
    },
  },
  deletions: {
    type: "array",
    description: "Files to delete.",
    items: {
      type: "object",
      required: ["path"],
      additionalProperties: false,
      properties: { path: { type: "string", minLength: 1, description: "Repo-relative file path to delete." } },
    },
  },
};

export default {
  id: "create-pull-request",
  name: "create_pull_request",
  targetKind: "create",
  defaultMax: 1,
  description:
    "Open a pull request containing a set of file changes. Pass the files you changed with --add " +
    "<path> (repeatable) and any removals with --delete <path>; the branch is created and the changes " +
    "are committed host-side, and the PR opens against the repository's default branch. Supply --title " +
    "and --body. Do not use placeholder content; open the PR only when the changes are ready.",
  inputSchema: {
    type: "object",
    required: ["title", "body"],
    additionalProperties: false,
    properties: {
      title: { type: "string", minLength: 1, maxLength: 256, description: "Concise pull request title." },
      body: {
        type: "string",
        maxLength: 65536,
        description: "Pull request description in GitHub-flavored Markdown: what changed, why, testing notes.",
      },
      // Accept boolean or the string form the generic shim produces ("true"/"false").
      draft: { type: ["boolean", "string"], description: "Whether to open the PR as a draft. Defaults to true." },
      ...fileChangeSchema,
    },
  },

  async apply(args, ctx, github, config = {}) {
    const { additions, deletions } = normalizeChangeset(args);
    const title = sanitizeTitle(args.title);

    // Base = repo default branch (or author --base-branch) + its current tip SHA.
    const base = await resolveBaseRef(github, ctx, config);

    // Generate the head branch host-side and create its ref at the base tip.
    const branch = generateBranchName(config);
    await github.request("POST", `/repos/${ctx.owner}/${ctx.repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: base.sha,
    });

    // Commit the file changes as ONE signed commit on the new branch.
    await applyChangeset(github, {
      owner: ctx.owner,
      repo: ctx.repo,
      branch,
      expectedHeadOid: base.sha,
      additions,
      deletions,
      message: title,
    });

    // Open the PR.
    const body = withFooter(sanitizeText(args.body, { maxLength: 65536 }), config);
    checkAllowedDomains(body, parseList(config.allowedDomains));
    const draft = !(args.draft === false || String(args.draft).toLowerCase() === "false");
    const res = await github.request("POST", `/repos/${ctx.owner}/${ctx.repo}/pulls`, {
      title,
      body,
      head: branch,
      base: base.branch,
      draft,
    });

    // Author-supplied extras (never agent-settable): auto-apply labels + reviewers.
    const prNumber = res && res.number;
    if (prNumber) {
      const labels = parseList(config.labels);
      if (labels.length) {
        try {
          await github.request("POST", `/repos/${ctx.owner}/${ctx.repo}/issues/${prNumber}/labels`, { labels });
        } catch {
          /* best effort */
        }
      }
      const reviewers = parseList(config.reviewers);
      if (reviewers.length) {
        try {
          await github.request("POST", `/repos/${ctx.owner}/${ctx.repo}/pulls/${prNumber}/requested_reviewers`, { reviewers });
        } catch {
          /* best effort */
        }
      }
    }

    return res && res.html_url
      ? `Opened pull request: ${res.html_url}`
      : `Opened pull request on ${ctx.owner}/${ctx.repo} (${branch} -> ${base.branch}).`;
  },
};
