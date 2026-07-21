// Safe output: request-reviewers.
//
// Requests reviewers (users and/or teams) on the triggering pull request (Class A
// REST). The author can gate the permitted reviewers with --allowed (glob patterns).

import { matchesGlob, parseList } from "../glob.js";

export default {
  id: "request-reviewers",
  name: "request_reviewers",
  targetKind: "issue",
  defaultMax: 1,
  description:
    "Request one or more reviewers (users and/or teams) on the pull request this workflow is running on. " +
    "The target is fixed to the triggering pull request unless the workflow widens it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      reviewers: {
        type: "array",
        items: { type: "string" },
        description: "GitHub usernames to request review from.",
      },
      team_reviewers: {
        type: "array",
        items: { type: "string" },
        description: "Team slugs to request review from.",
      },
    },
  },

  async apply(args, ctx, github, config = {}) {
    const reviewers = Array.isArray(args.reviewers) ? args.reviewers : [];
    const teamReviewers = Array.isArray(args.team_reviewers) ? args.team_reviewers : [];
    if (reviewers.length === 0 && teamReviewers.length === 0) {
      throw new Error("Provide at least one of: reviewers, team_reviewers.");
    }
    const allowed = parseList(config.allowed);
    if (allowed.length) {
      const bad = [...reviewers, ...teamReviewers].filter((r) => !allowed.some((p) => matchesGlob(r, p)));
      if (bad.length) {
        throw new Error(
          `These reviewers are not permitted by this workflow: ${bad.map((r) => `'${r}'`).join(", ")}. ` +
            `Allowed: ${allowed.map((r) => `'${r}'`).join(", ")}.`
        );
      }
    }
    const payload = {};
    if (reviewers.length) payload.reviewers = reviewers;
    if (teamReviewers.length) payload.team_reviewers = teamReviewers;
    await github.request(
      "POST",
      `/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.issueNumber}/requested_reviewers`,
      payload
    );
    const list = [...reviewers, ...teamReviewers].map((r) => `'${r}'`).join(", ");
    return `Requested review from ${list} on ${ctx.owner}/${ctx.repo}#${ctx.issueNumber}.`;
  },
};
