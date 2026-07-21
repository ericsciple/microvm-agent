// Safe output: update-pull-request.
//
// Edits the triggering pull request's title/body/state (mirror of update-issue on
// the /pulls endpoint). Class A REST. At least one field must be supplied.

import { sanitizeText, sanitizeTitle } from "../sanitize.js";
import { withFooter } from "../footer.js";
import { checkAllowedDomains } from "../domains.js";
import { parseList } from "../glob.js";

export default {
  id: "update-pull-request",
  name: "update_pull_request",
  targetKind: "issue",
  defaultMax: 1,
  description:
    "Update the title, body, or open/closed state of the pull request this workflow is running on. " +
    "The target is fixed to the triggering pull request unless the workflow widens it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", minLength: 1, maxLength: 256, description: "New pull request title." },
      body: { type: "string", maxLength: 65536, description: "New pull request body (GitHub-flavored Markdown)." },
      state: { type: "string", enum: ["open", "closed"], description: "New state." },
    },
  },

  async apply(args, ctx, github, config = {}) {
    const patch = {};
    if (args.title !== undefined) patch.title = sanitizeTitle(args.title);
    if (args.body !== undefined) {
      patch.body = withFooter(sanitizeText(args.body, { maxLength: 65536 }), config);
      checkAllowedDomains(patch.body, parseList(config.allowedDomains));
    }
    if (args.state !== undefined) patch.state = args.state;
    if (Object.keys(patch).length === 0) {
      throw new Error("Provide at least one of: title, body, state.");
    }
    await github.request("PATCH", `/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.issueNumber}`, patch);
    return `Updated pull request ${ctx.owner}/${ctx.repo}#${ctx.issueNumber} (${Object.keys(patch).join(", ")}).`;
  },
};
