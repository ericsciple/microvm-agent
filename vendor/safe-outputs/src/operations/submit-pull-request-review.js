// Safe output: submit-pull-request-review.
//
// Submits a review on the triggering pull request (Class A REST). The review body
// is sanitized. The author can restrict which review events are permitted via
// --allowed-events (default: only COMMENT — approving/requesting changes is opt-in).

import { sanitizeText } from "../sanitize.js";
import { withFooter } from "../footer.js";
import { checkAllowedDomains } from "../domains.js";
import { parseList } from "../glob.js";

const EVENTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"];

export default {
  id: "submit-pull-request-review",
  name: "submit_pull_request_review",
  targetKind: "issue",
  defaultMax: 1,
  description:
    "Submit a review (comment, approve, or request changes) on the pull request this workflow is " +
    "running on. The target is fixed to the triggering pull request unless the workflow widens it.",
  inputSchema: {
    type: "object",
    required: ["event"],
    additionalProperties: false,
    properties: {
      event: {
        type: "string",
        enum: EVENTS,
        description: "The review action: APPROVE, REQUEST_CHANGES, or COMMENT.",
      },
      body: {
        type: "string",
        maxLength: 65536,
        description: "Review body (required for COMMENT and REQUEST_CHANGES).",
      },
    },
  },

  async apply(args, ctx, github, config = {}) {
    // Default: only COMMENT is allowed; the author opts into APPROVE/REQUEST_CHANGES.
    const allowed = parseList(config.allowedEvents);
    const permitted = allowed.length ? allowed.map((e) => e.toUpperCase()) : ["COMMENT"];
    if (!permitted.includes(args.event)) {
      throw new Error(
        `Review event '${args.event}' is not permitted by this workflow. Allowed: ${permitted.join(", ")}.`
      );
    }
    if ((args.event === "COMMENT" || args.event === "REQUEST_CHANGES") && !args.body) {
      throw new Error(`A body is required for a ${args.event} review.`);
    }
    const payload = { event: args.event };
    if (args.body !== undefined) {
      payload.body = withFooter(sanitizeText(args.body, { maxLength: 65536 }), config);
      checkAllowedDomains(payload.body, parseList(config.allowedDomains));
    }
    await github.request(
      "POST",
      `/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.issueNumber}/reviews`,
      payload
    );
    return `Submitted a ${args.event} review on ${ctx.owner}/${ctx.repo}#${ctx.issueNumber}.`;
  },
};
