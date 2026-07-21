// Safe output: dispatch-repository.
//
// Fires a repository_dispatch event (Class A REST). A creation op (no triggering
// object). The author restricts which event types are allowed via
// --allowed-event-types (default deny).

import { matchesGlob, parseList } from "../glob.js";

export default {
  id: "dispatch-repository",
  name: "dispatch_repository",
  targetKind: "create",
  defaultMax: 1,
  description:
    "Fire a repository_dispatch event in this repository (to trigger workflows listening for it). " +
    "The set of allowed event types is restricted by the workflow author.",
  inputSchema: {
    type: "object",
    required: ["event_type"],
    additionalProperties: false,
    properties: {
      event_type: {
        type: "string",
        maxLength: 100,
        description: "The repository_dispatch event type (custom string workflows can listen for).",
      },
      client_payload: {
        type: "object",
        additionalProperties: true,
        description: "Optional JSON payload delivered to the listening workflow.",
      },
    },
  },

  async apply(args, ctx, github, config = {}) {
    const allowed = parseList(config.allowedEventTypes);
    if (!allowed.length) {
      throw new Error(
        "dispatch-repository requires the workflow author to allow-list event types via --allowed-event-types."
      );
    }
    if (!allowed.some((p) => matchesGlob(args.event_type, p))) {
      throw new Error(
        `Event type '${args.event_type}' is not permitted. Allowed: ${allowed.map((e) => `'${e}'`).join(", ")}.`
      );
    }
    const payload = { event_type: args.event_type };
    if (args.client_payload && typeof args.client_payload === "object") {
      payload.client_payload = args.client_payload;
    }
    await github.request("POST", `/repos/${ctx.owner}/${ctx.repo}/dispatches`, payload);
    return `Fired repository_dispatch '${args.event_type}' on ${ctx.owner}/${ctx.repo}.`;
  },
};
