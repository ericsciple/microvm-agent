// Safe output: update-issue.
//
// Advertises the `update_issue` tool. The schema exposes only the *intent* —
// what to change (title, body, open/closed state) — never which issue. The
// target is bound from the event context, so the agent can only edit the
// triggering issue/PR. Body and title are sanitized before they are written.

import { sanitizeText, sanitizeTitle } from "../sanitize.js";
import { checkAllowedDomains } from "../domains.js";
import { parseList } from "../glob.js";

export default {
  id: "update-issue",
  name: "update_issue",
  targetKind: "issue",
  defaultMax: 1,
  description:
    "Update the title, body, or open/closed state of the issue this workflow is running on. " +
    "The target is fixed to the triggering issue — you cannot choose a different one. " +
    "Provide only the fields you want to change; at least one is required.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      title: {
        type: "string",
        minLength: 1,
        description: "New title for the issue.",
      },
      body: {
        type: "string",
        maxLength: 65536,
        description: "New issue body, in GitHub-flavored Markdown. Replaces the existing body.",
      },
      state: {
        type: "string",
        enum: ["open", "closed"],
        description: "Set the issue state: 'closed' to close it, 'open' to reopen it.",
      },
    },
  },

  /**
   * @param {{title?: string, body?: string, state?: string}} args - validated arguments
   * @param {{owner: string, repo: string, issueNumber: number}} ctx - bound context
   * @param {{request: Function}} github - GitHub client
   * @returns {Promise<string>} human-readable summary
   */
  async apply(args, ctx, github, config = {}) {
    const patch = {};
    const changed = [];
    if (args.title !== undefined) {
      patch.title = sanitizeTitle(args.title);
      changed.push("title");
    }
    if (args.body !== undefined) {
      patch.body = sanitizeText(args.body, { maxLength: 65536 });
      checkAllowedDomains(patch.body, parseList(config.allowedDomains));
      changed.push("body");
    }
    if (args.state !== undefined) {
      patch.state = args.state;
      changed.push(`state=${args.state}`);
    }

    await github.request(
      "PATCH",
      `/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.issueNumber}`,
      patch
    );
    return `Updated ${ctx.owner}/${ctx.repo}#${ctx.issueNumber} (${changed.join(", ")}).`;
  },
};