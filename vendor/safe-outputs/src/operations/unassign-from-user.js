// Safe output: unassign-from-user.
//
// Removes assignees from the triggering issue/PR (Class A REST). Mirror of
// assign-to-user (DELETE /assignees).

export default {
  id: "unassign-from-user",
  name: "unassign_from_user",
  targetKind: "issue",
  defaultMax: 1,
  description:
    "Remove one or more assignees from the issue or pull request this workflow is running on. " +
    "The target is fixed to the triggering issue/PR unless the workflow widens it.",
  inputSchema: {
    type: "object",
    required: ["assignees"],
    additionalProperties: false,
    properties: {
      assignees: {
        type: "array",
        minItems: 1,
        items: { type: "string" },
        description: "GitHub usernames to unassign.",
      },
    },
  },

  async apply(args, ctx, github) {
    await github.request(
      "DELETE",
      `/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.issueNumber}/assignees`,
      { assignees: args.assignees }
    );
    const list = args.assignees.map((u) => `'${u}'`).join(", ");
    return `Unassigned ${list} from ${ctx.owner}/${ctx.repo}#${ctx.issueNumber}.`;
  },
};
