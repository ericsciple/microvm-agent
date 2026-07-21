// Safe output: close-pull-request.
//
// Closes (without merging) the triggering pull request, with an optional closing
// comment. Mirror of close-issue but on the /pulls endpoint. Class A REST.

import { sanitizeText } from "../sanitize.js";
import { withFooter } from "../footer.js";
import { checkAllowedDomains } from "../domains.js";
import { parseList } from "../glob.js";

export default {
  id: "close-pull-request",
  name: "close_pull_request",
  targetKind: "issue",
  defaultMax: 1,
  description:
    "Close (without merging) the pull request this workflow is running on, optionally with a " +
    "comment explaining why. The target is fixed to the triggering pull request unless the workflow widens it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      body: {
        type: "string",
        maxLength: 65536,
        description: "Optional closing comment, in GitHub-flavored Markdown.",
      },
    },
  },

  async apply(args, ctx, github, config = {}) {
    const allowBody = config.allowBody !== "false" && config.allowBody !== false;
    if (allowBody && args.body) {
      const body = withFooter(sanitizeText(args.body, { maxLength: 65536 }), config);
      checkAllowedDomains(body, parseList(config.allowedDomains));
      await github.request(
        "POST",
        `/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.issueNumber}/comments`,
        { body }
      );
    }
    await github.request("PATCH", `/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.issueNumber}`, {
      state: "closed",
    });
    return `Closed pull request ${ctx.owner}/${ctx.repo}#${ctx.issueNumber}.`;
  },
};
