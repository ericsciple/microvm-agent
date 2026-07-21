// Safe output: close-discussion.
//
// Closes a discussion (Class B — GraphQL closeDiscussion). The agent supplies the
// discussion number; we resolve its node id host-side, then run the mutation.

const ID_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ discussion(number:$number){ id } }
}`;

const MUTATION = `mutation($id:ID!,$reason:DiscussionCloseReason){
  closeDiscussion(input:{discussionId:$id,reason:$reason}){
    discussion{ url number }
  }
}`;

const REASONS = ["RESOLVED", "OUTDATED", "DUPLICATE"];

export default {
  id: "close-discussion",
  name: "close_discussion",
  targetKind: "create",
  defaultMax: 1,
  description: "Close a discussion in this repository (supply its number).",
  inputSchema: {
    type: "object",
    required: ["discussion_number"],
    additionalProperties: false,
    properties: {
      discussion_number: { type: "integer", minimum: 1, description: "The discussion number to close." },
      reason: {
        type: "string",
        enum: REASONS,
        description: "Why the discussion is closed (defaults to RESOLVED).",
      },
    },
  },

  async apply(args, ctx, github) {
    if (typeof github.graphql !== "function") {
      throw new Error("This GitHub client does not support GraphQL, which close-discussion requires.");
    }
    const q = await github.graphql(ID_QUERY, { owner: ctx.owner, name: ctx.repo, number: args.discussion_number });
    const disc = q && q.repository && q.repository.discussion;
    if (!disc) throw new Error(`Discussion #${args.discussion_number} was not found in ${ctx.owner}/${ctx.repo}.`);
    const res = await github.graphql(MUTATION, { id: disc.id, reason: args.reason || "RESOLVED" });
    const d = res && res.closeDiscussion && res.closeDiscussion.discussion;
    return d && d.url ? `Closed discussion: ${d.url}` : `Closed discussion #${args.discussion_number}.`;
  },
};
