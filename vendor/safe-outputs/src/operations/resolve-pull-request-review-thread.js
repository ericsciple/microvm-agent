// Safe output: resolve-pull-request-review-thread.
//
// Resolves a pull-request review thread (Class B — GraphQL resolveReviewThread).
// The agent supplies the thread's GraphQL node id.

const MUTATION = `mutation($id:ID!){
  resolveReviewThread(input:{threadId:$id}){
    thread{ isResolved }
  }
}`;

export default {
  id: "resolve-pull-request-review-thread",
  name: "resolve_pull_request_review_thread",
  targetKind: "create",
  defaultMax: 10,
  description:
    "Resolve a pull-request review thread. Supply the thread's node id (from the GitHub API).",
  inputSchema: {
    type: "object",
    required: ["thread_id"],
    additionalProperties: false,
    properties: {
      thread_id: { type: "string", minLength: 1, description: "The review thread's GraphQL node id." },
    },
  },

  async apply(args, ctx, github) {
    if (typeof github.graphql !== "function") {
      throw new Error("This GitHub client does not support GraphQL, which this operation requires.");
    }
    const data = await github.graphql(MUTATION, { id: args.thread_id });
    const t = data && data.resolveReviewThread && data.resolveReviewThread.thread;
    return t && t.isResolved
      ? `Resolved review thread ${args.thread_id}.`
      : `Requested resolving review thread ${args.thread_id}.`;
  },
};
