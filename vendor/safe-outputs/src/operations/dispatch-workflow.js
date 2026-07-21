// Safe output: dispatch-workflow.
//
// Triggers a workflow_dispatch on a workflow in the repo (Class A REST). A creation
// op (no triggering object). The author restricts which workflows are allowed via
// --allowed-workflows (default deny — you must opt in to dispatchable workflows).

import { matchesGlob, parseList } from "../glob.js";

export default {
  id: "dispatch-workflow",
  name: "dispatch_workflow",
  targetKind: "create",
  defaultMax: 1,
  description:
    "Trigger a workflow_dispatch run of a workflow in this repository. The set of dispatchable " +
    "workflows is restricted by the workflow author.",
  inputSchema: {
    type: "object",
    required: ["workflow"],
    additionalProperties: false,
    properties: {
      workflow: {
        type: "string",
        description: "The workflow file name (e.g. 'ci.yml') or its numeric id.",
      },
      ref: {
        type: "string",
        description: "The git ref (branch or tag) to run on. Defaults to the repository's default branch.",
      },
      inputs: {
        type: "object",
        additionalProperties: true,
        description: "Optional workflow_dispatch inputs.",
      },
    },
  },

  async apply(args, ctx, github, config = {}) {
    // Default deny: the author must list the workflows this can dispatch.
    const allowed = parseList(config.allowedWorkflows);
    if (!allowed.length) {
      throw new Error(
        "dispatch-workflow requires the workflow author to allow-list workflows via --allowed-workflows."
      );
    }
    if (!allowed.some((p) => matchesGlob(args.workflow, p))) {
      throw new Error(
        `Workflow '${args.workflow}' is not permitted. Allowed: ${allowed.map((w) => `'${w}'`).join(", ")}.`
      );
    }
    const ref = args.ref || config.defaultRef || "main";
    const payload = { ref };
    if (args.inputs && typeof args.inputs === "object") payload.inputs = args.inputs;
    await github.request(
      "POST",
      `/repos/${ctx.owner}/${ctx.repo}/actions/workflows/${encodeURIComponent(args.workflow)}/dispatches`,
      payload
    );
    return `Dispatched workflow '${args.workflow}' on ${ctx.owner}/${ctx.repo}@${ref}.`;
  },
};
