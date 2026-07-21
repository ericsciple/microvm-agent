// Apply a file change set as a signed commit, via the GitHub GraphQL
// `createCommitOnBranch` mutation.
//
// This is the whole-file API (not low-level blobs/trees): you hand it the full
// contents of every added/modified file (base64) and the paths of deletions, and
// GitHub creates ONE atomic, cryptographically-signed commit on the branch. It
// matches how gh-aw pushes agent changes (actions/setup/js/push_signed_commits.cjs).
//
// The branch must already exist and `expectedHeadOid` must equal its current head
// (optimistic concurrency). Callers create the branch ref first (create-pull-request)
// or resolve the existing head (push-to-pull-request-branch).

const CREATE_COMMIT_MUTATION = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid url }
  }
}`;

/**
 * @param {{graphql: Function}} github
 * @param {Object} p
 * @param {string} p.owner
 * @param {string} p.repo
 * @param {string} p.branch - the branch name (not a ref) to commit onto
 * @param {string} p.expectedHeadOid - the branch's current head commit SHA
 * @param {Array<{path:string, contents:string}>} [p.additions] - base64 contents
 * @param {Array<{path:string}>} [p.deletions]
 * @param {string} p.message - the commit headline
 * @returns {Promise<{oid:string, url?:string}>}
 */
export async function applyChangeset(github, { owner, repo, branch, expectedHeadOid, additions = [], deletions = [], message }) {
  if (typeof github.graphql !== "function") {
    throw new Error("This GitHub client does not support GraphQL, which committing file changes requires.");
  }
  const input = {
    branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch },
    message: { headline: message },
    expectedHeadOid,
    fileChanges: {
      additions: additions.map((a) => ({ path: a.path, contents: a.contents })),
      deletions: deletions.map((d) => ({ path: d.path })),
    },
  };
  const data = await github.graphql(CREATE_COMMIT_MUTATION, { input });
  const commit = data && data.createCommitOnBranch && data.createCommitOnBranch.commit;
  if (!commit || !commit.oid) throw new Error("createCommitOnBranch did not return a commit.");
  return commit;
}

/**
 * Validate + normalize the change set an agent/helper supplied. Returns
 * `{ additions, deletions }` or throws if empty.
 */
export function normalizeChangeset(args) {
  const additions = Array.isArray(args.additions) ? args.additions : [];
  const deletions = Array.isArray(args.deletions) ? args.deletions : [];
  if (additions.length === 0 && deletions.length === 0) {
    throw new Error("No file changes were provided — there is nothing to commit.");
  }
  return { additions, deletions };
}
