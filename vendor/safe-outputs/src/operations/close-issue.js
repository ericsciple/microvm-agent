// Safe output: close-issue.
//
// Closes the triggering issue/PR (or a widened target), with an optional closing
// comment. The comment body is sanitized + gets the footer; `--allow-body=false`
// discards any agent-supplied body.

import { sanitizeText } from "../sanitize.js";
import { withFooter } from "../footer.js";
import { checkAllowedDomains } from "../domains.js";
import { parseList } from "../glob.js";

export default {
  id: "close-issue",
  name: "close_issue",
  targetKind: "issue",
  defaultMax: 1,
  description:
    "Close the issue this workflow is running on, optionally with a closing comment " +
    "explaining the resolution. The target is fixed to the triggering issue unless the workflow widens it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      body: {
        type: "string",
        maxLength: 65536,
        description: "Optional closing comment, in GitHub-flavored Markdown.",
      },
      state_reason: {
        type: "string",
        enum: ["completed", "not_planned"],
        description: "Why the issue is being closed (defaults to 'completed').",
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

    await github.request("PATCH", `/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.issueNumber}`, {
      state: "closed",
      state_reason: args.state_reason || "completed",
    });
    return `Closed ${ctx.owner}/${ctx.repo}#${ctx.issueNumber}.`;
  },
};
