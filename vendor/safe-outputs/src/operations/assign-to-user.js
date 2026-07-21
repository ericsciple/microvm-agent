// Safe output: assign-to-user.
//
// Adds assignees to the triggering issue/PR (Class A REST). The author can gate the
// permitted assignees with --allowed (glob patterns); default = allow any.

import { matchesGlob, parseList } from "../glob.js";

export default {
  id: "assign-to-user",
  name: "assign_to_user",
  targetKind: "issue",
  defaultMax: 1,
  description:
    "Assign one or more users to the issue or pull request this workflow is running on. " +
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
        description: "GitHub usernames to assign.",
      },
    },
  },

  async apply(args, ctx, github, config = {}) {
    const allowed = parseList(config.allowed);
    if (allowed.length) {
      const bad = args.assignees.filter((u) => !allowed.some((p) => matchesGlob(u, p)));
      if (bad.length) {
        throw new Error(
          `These assignees are not permitted by this workflow: ${bad.map((u) => `'${u}'`).join(", ")}. ` +
            `Allowed: ${allowed.map((u) => `'${u}'`).join(", ")}.`
        );
      }
    }
    await github.request(
      "POST",
      `/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.issueNumber}/assignees`,
      { assignees: args.assignees }
    );
    const list = args.assignees.map((u) => `'${u}'`).join(", ");
    return `Assigned ${list} to ${ctx.owner}/${ctx.repo}#${ctx.issueNumber}.`;
  },
};
