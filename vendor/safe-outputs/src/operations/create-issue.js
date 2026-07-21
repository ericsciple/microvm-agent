// Safe output: create-issue.
//
// Creates a NEW issue in the current repo (a "creation" op — no triggering-object
// target; it uses --target-repo only). The agent supplies title/body/labels; the
// author can prefix titles, auto-apply labels, restrict labels, and auto-assign.

import { sanitizeText, sanitizeTitle } from "../sanitize.js";
import { withFooter } from "../footer.js";
import { checkAllowedDomains } from "../domains.js";
import { matchesGlob, parseList } from "../glob.js";

export default {
  id: "create-issue",
  name: "create_issue",
  targetKind: "create",
  defaultMax: 1,
  description:
    "Create a new issue in this repository. Use it to file a bug, a task, or a follow-up.",
  inputSchema: {
    type: "object",
    required: ["title", "body"],
    additionalProperties: false,
    properties: {
      title: { type: "string", minLength: 1, maxLength: 256, description: "Concise issue title." },
      body: {
        type: "string",
        maxLength: 65536,
        description: "Issue body, in GitHub-flavored Markdown: what and why.",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Labels to apply to the new issue (must already exist in the repo).",
      },
    },
  },

  async apply(args, ctx, github, config = {}) {
    const prefix = config.titlePrefix ? String(config.titlePrefix) : "";
    const title = prefix + sanitizeTitle(args.title);
    const body = withFooter(sanitizeText(args.body, { maxLength: 65536 }), config);
    checkAllowedDomains(body, parseList(config.allowedDomains));

    // Agent-supplied labels are gated by --allowed-labels; author --labels are added.
    let labels = Array.isArray(args.labels) ? [...args.labels] : [];
    const allowedLabels = parseList(config.allowedLabels);
    if (allowedLabels.length) {
      const bad = labels.filter((l) => !allowedLabels.some((p) => matchesGlob(l, p)));
      if (bad.length) {
        throw new Error(
          `These labels are not permitted by this workflow: ${bad.map((l) => `'${l}'`).join(", ")}. ` +
            `Allowed: ${allowedLabels.map((l) => `'${l}'`).join(", ")}.`
        );
      }
    }
    labels = [...new Set([...labels, ...parseList(config.labels)])];
    const assignees = parseList(config.assignees);

    const payload = { title, body };
    if (labels.length) payload.labels = labels;
    if (assignees.length) payload.assignees = assignees;

    const res = await github.request("POST", `/repos/${ctx.owner}/${ctx.repo}/issues`, payload);
    return res && res.html_url
      ? `Created issue: ${res.html_url}`
      : `Created issue in ${ctx.owner}/${ctx.repo}.`;
  },
};
