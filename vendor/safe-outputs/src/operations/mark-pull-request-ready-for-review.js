// Safe output: mark-pull-request-ready-for-review.
//
// Takes the triggering pull request out of draft (Class B — GraphQL
// markPullRequestReadyForReview; there is no REST equivalent). The PR is bound
// host-side from the event payload; we resolve its node id, then run the mutation.

const PR_ID_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){ id isDraft } }
}`;

const MUTATION = `mutation($id:ID!){
  markPullRequestReadyForReview(input:{pullRequestId:$id}){
    pullRequest{ isDraft number }
  }
}`;

export default {
  id: "mark-pull-request-ready-for-review",
  name: "mark_pull_request_ready_for_review",
  targetKind: "issue",
  defaultMax: 1,
  description:
    "Mark the pull request this workflow is running on as ready for review (take it out of draft). " +
    "The target is fixed to the triggering pull request unless the workflow widens it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },

  async apply(_args, ctx, github) {
    if (typeof github.graphql !== "function") {
      throw new Error("This GitHub client does not support GraphQL, which this operation requires.");
    }
    const q = await github.graphql(PR_ID_QUERY, { owner: ctx.owner, name: ctx.repo, number: ctx.issueNumber });
    const pr = q && q.repository && q.repository.pullRequest;
    if (!pr) throw new Error(`Pull request ${ctx.owner}/${ctx.repo}#${ctx.issueNumber} was not found.`);
    if (!pr.isDraft) return `${ctx.owner}/${ctx.repo}#${ctx.issueNumber} is already ready for review.`;
    await github.graphql(MUTATION, { id: pr.id });
    return `Marked ${ctx.owner}/${ctx.repo}#${ctx.issueNumber} ready for review.`;
  },
};
