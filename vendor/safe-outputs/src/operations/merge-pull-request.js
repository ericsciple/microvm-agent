// Safe output: merge-pull-request.
//
// Merges the triggering pull request (Class A REST). The target PR is bound
// host-side from the event payload (its number); the agent only chooses the merge
// method and optional commit title/message. Author can restrict the method.

export default {
  id: "merge-pull-request",
  name: "merge_pull_request",
  targetKind: "issue",
  defaultMax: 1,
  description:
    "Merge the pull request this workflow is running on. The target PR is fixed to the " +
    "triggering pull request unless the workflow widens it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      merge_method: {
        type: "string",
        enum: ["merge", "squash", "rebase"],
        description: "How to merge (defaults to 'merge', or the workflow's configured method).",
      },
      commit_title: { type: "string", maxLength: 256, description: "Optional merge commit title." },
      commit_message: { type: "string", maxLength: 65536, description: "Optional merge commit message." },
    },
  },

  async apply(args, ctx, github, config = {}) {
    // An author --merge-method pins the method; otherwise the agent chooses (default 'merge').
    const method = config.mergeMethod || args.merge_method || "merge";
    const allowed = ["merge", "squash", "rebase"];
    if (!allowed.includes(method)) {
      throw new Error(`Invalid merge method '${method}'. Expected one of: ${allowed.join(", ")}.`);
    }
    const payload = { merge_method: method };
    if (args.commit_title) payload.commit_title = args.commit_title;
    if (args.commit_message) payload.commit_message = args.commit_message;

    const res = await github.request(
      "PUT",
      `/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.issueNumber}/merge`,
      payload
    );
    return res && res.merged
      ? `Merged ${ctx.owner}/${ctx.repo}#${ctx.issueNumber} (${method}).`
      : `Merge requested for ${ctx.owner}/${ctx.repo}#${ctx.issueNumber}.`;
  },
};
