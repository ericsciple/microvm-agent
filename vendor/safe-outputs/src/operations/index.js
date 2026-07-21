// Registry of safe-output operations, keyed by the CLI operation id
// (the value passed as `safe-outputs <id>`).

import addLabels from "./add-labels.js";
import removeLabels from "./remove-labels.js";
import replaceLabels from "./replace-labels.js";
import addComment from "./add-comment.js";
import updateIssue from "./update-issue.js";
import closeIssue from "./close-issue.js";
import createIssue from "./create-issue.js";
import createDiscussion from "./create-discussion.js";
import updateDiscussion from "./update-discussion.js";
import closeDiscussion from "./close-discussion.js";
import createPullRequest from "./create-pull-request.js";
import pushToPullRequestBranch from "./push-to-pull-request-branch.js";
import updatePullRequest from "./update-pull-request.js";
import closePullRequest from "./close-pull-request.js";
import mergePullRequest from "./merge-pull-request.js";
import markPullRequestReadyForReview from "./mark-pull-request-ready-for-review.js";
import submitPullRequestReview from "./submit-pull-request-review.js";
import createPullRequestReviewComment from "./create-pull-request-review-comment.js";
import resolvePullRequestReviewThread from "./resolve-pull-request-review-thread.js";
import requestReviewers from "./request-reviewers.js";
import assignToUser from "./assign-to-user.js";
import unassignFromUser from "./unassign-from-user.js";
import assignMilestone from "./assign-milestone.js";
import hideComment from "./hide-comment.js";
import dispatchWorkflow from "./dispatch-workflow.js";
import dispatchRepository from "./dispatch-repository.js";

export const operations = {
  [addLabels.id]: addLabels,
  [removeLabels.id]: removeLabels,
  [replaceLabels.id]: replaceLabels,
  [addComment.id]: addComment,
  [updateIssue.id]: updateIssue,
  [closeIssue.id]: closeIssue,
  [createIssue.id]: createIssue,
  [createDiscussion.id]: createDiscussion,
  [updateDiscussion.id]: updateDiscussion,
  [closeDiscussion.id]: closeDiscussion,
  [createPullRequest.id]: createPullRequest,
  [pushToPullRequestBranch.id]: pushToPullRequestBranch,
  [updatePullRequest.id]: updatePullRequest,
  [closePullRequest.id]: closePullRequest,
  [mergePullRequest.id]: mergePullRequest,
  [markPullRequestReadyForReview.id]: markPullRequestReadyForReview,
  [submitPullRequestReview.id]: submitPullRequestReview,
  [createPullRequestReviewComment.id]: createPullRequestReviewComment,
  [resolvePullRequestReviewThread.id]: resolvePullRequestReviewThread,
  [requestReviewers.id]: requestReviewers,
  [assignToUser.id]: assignToUser,
  [unassignFromUser.id]: unassignFromUser,
  [assignMilestone.id]: assignMilestone,
  [hideComment.id]: hideComment,
  [dispatchWorkflow.id]: dispatchWorkflow,
  [dispatchRepository.id]: dispatchRepository,
};

export function getOperation(id) {
  return operations[id];
}

export function operationIds() {
  return Object.keys(operations);
}
