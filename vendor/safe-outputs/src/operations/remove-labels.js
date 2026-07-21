// Safe output: remove-labels.
//
// Mirror of add-labels: removes labels from the triggering issue/PR (or a widened
// target). The schema exposes only the label names; the target is bound from context.

import { enforceLabelPolicy } from "../labelPolicy.js";

export default {
  id: "remove-labels",
  name: "remove_labels",
  targetKind: "issue",
  defaultMax: 3,
  description:
    "Remove one or more labels from the issue or pull request this workflow is running on. " +
    "The target is fixed to the triggering issue/PR unless the workflow widens it.",
  inputSchema: {
    type: "object",
    required: ["labels"],
    additionalProperties: false,
    properties: {
      labels: {
        type: "array",
        minItems: 1,
        items: { type: "string" },
        description: "Labels to remove from the target issue or pull request.",
      },
    },
  },

  async apply(args, ctx, github, config = {}) {
    enforceLabelPolicy(args.labels, config, this.defaultMax);
    for (const label of args.labels) {
      try {
        await github.request(
          "DELETE",
          `/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.issueNumber}/labels/${encodeURIComponent(label)}`
        );
      } catch (e) {
        // A label that isn't currently applied returns 404 — treat as a no-op.
        if (!/\b404\b/.test(e.message)) throw e;
      }
    }
    const list = args.labels.map((l) => `'${l}'`).join(", ");
    return `Removed label(s) ${list} from ${ctx.owner}/${ctx.repo}#${ctx.issueNumber}.`;
  },
};
