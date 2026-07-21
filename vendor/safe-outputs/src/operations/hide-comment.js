// Safe output: hide-comment.
//
// Minimizes (hides) an issue/PR/discussion comment (Class B — GraphQL
// minimizeComment). The agent supplies the comment's GraphQL node id and a reason.

const MUTATION = `mutation($id:ID!,$classifier:ReportedContentClassifiers!){
  minimizeComment(input:{subjectId:$id,classifier:$classifier}){
    minimizedComment{ isMinimized minimizedReason }
  }
}`;

const CLASSIFIERS = ["ABUSE", "OFF_TOPIC", "OUTDATED", "DUPLICATE", "RESOLVED", "SPAM"];

export default {
  id: "hide-comment",
  name: "hide_comment",
  targetKind: "create",
  defaultMax: 5,
  description:
    "Hide (minimize) a comment on an issue, pull request, or discussion, with a reason. " +
    "Supply the comment's node id (from the GitHub API).",
  inputSchema: {
    type: "object",
    required: ["comment_id"],
    additionalProperties: false,
    properties: {
      comment_id: { type: "string", minLength: 1, description: "The comment's GraphQL node id." },
      reason: {
        type: "string",
        enum: CLASSIFIERS,
        description: "Why the comment is hidden (defaults to OUTDATED).",
      },
    },
  },

  async apply(args, ctx, github) {
    if (typeof github.graphql !== "function") {
      throw new Error("This GitHub client does not support GraphQL, which hide-comment requires.");
    }
    const classifier = args.reason || "OUTDATED";
    const data = await github.graphql(MUTATION, { id: args.comment_id, classifier });
    const min = data && data.minimizeComment && data.minimizeComment.minimizedComment;
    return min && min.isMinimized
      ? `Hid comment ${args.comment_id} (${min.minimizedReason}).`
      : `Requested hiding comment ${args.comment_id}.`;
  },
};
