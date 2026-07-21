// Safe output: push-to-pull-request-branch.
//
// Commits a set of FILE CHANGES onto the head branch of the triggering pull request
// (Class C — the guest→host data path). The agent (via the guest-side
// `push-to-pull-request-branch` helper) computes the change set with git; this
// host-side server resolves the PR's current head branch + head SHA, then commits
// the changes as one SIGNED commit (GraphQL `createCommitOnBranch`). Whole-file
// semantics — `additions` carry full contents, so they overwrite regardless of the
// guest's base.

import { applyChangeset, normalizeChangeset } from "../changeset.js";

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
  id: "push-to-pull-request-branch",
  name: "push_to_pull_request_branch",
  targetKind: "issue",
  defaultMax: 1,
  description:
    "Commit a set of file changes onto the head branch of the pull request this workflow is running " +
    "on. Pass the files you changed with --add <path> (repeatable) and removals with --delete <path>, " +
    "plus a commit --message. The target is fixed to the triggering pull request unless the workflow widens it.",
  inputSchema: {
    type: "object",
    required: ["message"],
    additionalProperties: false,
    properties: {
      message: { type: "string", minLength: 1, maxLength: 256, description: "Commit message headline." },
      ...fileChangeSchema,
    },
  },

  async apply(args, ctx, github) {
    const { additions, deletions } = normalizeChangeset(args);

    // Resolve the PR's current head branch + head SHA host-side (the agent never
    // names the branch); expectedHeadOid guards against a racing update.
    const pr = await github.request("GET", `/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.issueNumber}`);
    const branch = pr && pr.head && pr.head.ref;
    const headOid = pr && pr.head && pr.head.sha;
    if (!branch || !headOid) {
      throw new Error(`Could not resolve the head branch of ${ctx.owner}/${ctx.repo}#${ctx.issueNumber}.`);
    }

    const commit = await applyChangeset(github, {
      owner: ctx.owner,
      repo: ctx.repo,
      branch,
      expectedHeadOid: headOid,
      additions,
      deletions,
      message: args.message,
    });

    return `Pushed a commit to ${branch} (${ctx.owner}/${ctx.repo}#${ctx.issueNumber})${commit.url ? `: ${commit.url}` : "."}`;
  },
};
