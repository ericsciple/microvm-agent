// Safe output: create-pull-request-review-comment.
//
// Adds an inline review comment on a specific line of the triggering pull request's
// diff (Class A REST). The body is sanitized. The agent supplies the path + line;
// the commit is bound to the PR's current head SHA host-side.

import { sanitizeText } from "../sanitize.js";
import { withFooter } from "../footer.js";
import { checkAllowedDomains } from "../domains.js";
import { parseList } from "../glob.js";

export default {
  id: "create-pull-request-review-comment",
  name: "create_pull_request_review_comment",
  targetKind: "issue",
  defaultMax: 10,
  description:
    "Add an inline review comment on a specific file and line of the pull request this workflow is " +
    "running on. The target is fixed to the triggering pull request unless the workflow widens it.",
  inputSchema: {
    type: "object",
    required: ["path", "line", "body"],
    additionalProperties: false,
    properties: {
      path: { type: "string", minLength: 1, description: "File path in the diff to comment on." },
      line: { type: "integer", minimum: 1, description: "Line number in the file's diff (RIGHT side)." },
      start_line: { type: "integer", minimum: 1, description: "For a multi-line comment, the first line." },
      side: { type: "string", enum: ["LEFT", "RIGHT"], description: "Diff side (defaults to RIGHT)." },
      body: { type: "string", minLength: 1, maxLength: 65536, description: "Comment body (GitHub-flavored Markdown)." },
    },
  },

  async apply(args, ctx, github, config = {}) {
    // Bind the comment to the PR's current head SHA host-side (the agent never picks it).
    const pr = await github.request("GET", `/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.issueNumber}`);
    const commitId = pr && pr.head && pr.head.sha;
    if (!commitId) throw new Error(`Could not resolve the head commit of ${ctx.owner}/${ctx.repo}#${ctx.issueNumber}.`);

    const body = withFooter(sanitizeText(args.body, { maxLength: 65536 }), config);
    checkAllowedDomains(body, parseList(config.allowedDomains));
    const payload = {
      body,
      commit_id: commitId,
      path: args.path,
      line: args.line,
      side: args.side || "RIGHT",
    };
    if (args.start_line !== undefined) payload.start_line = args.start_line;
    const res = await github.request(
      "POST",
      `/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.issueNumber}/comments`,
      payload
    );
    return res && res.html_url
      ? `Added a review comment: ${res.html_url}`
      : `Added a review comment on ${ctx.owner}/${ctx.repo}#${ctx.issueNumber} (${args.path}:${args.line}).`;
  },
};
