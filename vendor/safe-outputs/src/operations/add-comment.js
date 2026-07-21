// Safe output: add-comment.
//
// Advertises the `add_comment` tool. The schema exposes ONLY the comment body —
// never the target object. The target is bound from the event context, so the
// agent can only comment on the triggering issue/PR. The body is sanitized
// before it is posted (see sanitize.js).

import { sanitizeText, countLinks } from "../sanitize.js";
import { withFooter } from "../footer.js";
import { checkAllowedDomains } from "../domains.js";
import { parseList } from "../glob.js";

export default {
  id: "add-comment",
  name: "add_comment",
  targetKind: "issue",
  defaultMax: 1,
  description:
    "Post a comment on the issue or pull request this workflow is running on. " +
    "The target is fixed to the triggering issue/PR unless the workflow widens it.",
  inputSchema: {
    type: "object",
    required: ["body"],
    additionalProperties: false,
    properties: {
      body: {
        type: "string",
        minLength: 1,
        maxLength: 65536,
        description: "The comment body, in GitHub-flavored Markdown.",
      },
    },
  },

  /**
   * @param {{body: string}} args - validated arguments
   * @param {{owner: string, repo: string, issueNumber: number}} ctx - bound context
   * @param {{request: Function}} github - GitHub client
   * @param {{maxLinks?: string}} [config] - scope-widening flags
   * @returns {Promise<string>} human-readable summary
   */
  async apply(args, ctx, github, config = {}) {
    let body = sanitizeText(args.body, { maxLength: 65536 });

    if (config.maxLinks !== undefined) {
      const maxLinks = Number.parseInt(config.maxLinks, 10);
      const count = countLinks(body);
      if (Number.isFinite(maxLinks) && count > maxLinks) {
        throw new Error(
          `Too many links: the comment contains ${count} but this workflow allows at most ${maxLinks}.`
        );
      }
    }

    body = withFooter(body, config);

    checkAllowedDomains(body, parseList(config.allowedDomains));

    const res = await github.request(
      "POST",
      `/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.issueNumber}/comments`,
      { body }
    );
    const where = `${ctx.owner}/${ctx.repo}#${ctx.issueNumber}`;
    return res && res.html_url
      ? `Posted comment on ${where}: ${res.html_url}`
      : `Posted comment on ${where}.`;
  },
};
