// Safe output: replace-labels.
//
// Sets the labels on the triggering issue/PR to exactly the supplied set (PUT
// /labels replaces all existing labels). Class A REST. Honors the shared
// allowed/blocked/max label policy.

import { enforceLabelPolicy } from "../labelPolicy.js";

export default {
  id: "replace-labels",
  name: "replace_labels",
  targetKind: "issue",
  defaultMax: 10,
  description:
    "Replace ALL labels on the issue or pull request this workflow is running on with exactly the " +
    "supplied set (labels not listed are removed). The target is fixed to the triggering issue/PR " +
    "unless the workflow widens it.",
  inputSchema: {
    type: "object",
    required: ["labels"],
    additionalProperties: false,
    properties: {
      labels: {
        type: "array",
        items: { type: "string" },
        description: "The complete set of labels the issue/PR should have afterwards (may be empty to clear all).",
      },
    },
  },

  async apply(args, ctx, github, config = {}) {
    const labels = Array.isArray(args.labels) ? args.labels : [];
    if (labels.length) enforceLabelPolicy(labels, config, this.defaultMax);
    await github.request(
      "PUT",
      `/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.issueNumber}/labels`,
      { labels }
    );
    return labels.length
      ? `Set labels on ${ctx.owner}/${ctx.repo}#${ctx.issueNumber} to ${labels.map((l) => `'${l}'`).join(", ")}.`
      : `Cleared all labels on ${ctx.owner}/${ctx.repo}#${ctx.issueNumber}.`;
  },
};
