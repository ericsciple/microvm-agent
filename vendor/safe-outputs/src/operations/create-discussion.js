// Safe output: create-discussion.
//
// Creates a GitHub Discussion in the current repo. Discussions are GraphQL-only, so
// this uses github.graphql: look up the repository node id + the category id, then
// run the createDiscussion mutation. A "creation" op (no triggering-object target).

import { sanitizeText, sanitizeTitle } from "../sanitize.js";
import { withFooter } from "../footer.js";
import { checkAllowedDomains } from "../domains.js";
import { parseList } from "../glob.js";

const REPO_QUERY = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    id
    hasDiscussionsEnabled
    discussionCategories(first:50){nodes{id name slug}}
  }
}`;

const CREATE_MUTATION = `mutation($repositoryId:ID!,$categoryId:ID!,$title:String!,$body:String!){
  createDiscussion(input:{repositoryId:$repositoryId,categoryId:$categoryId,title:$title,body:$body}){
    discussion{ url number }
  }
}`;

export default {
  id: "create-discussion",
  name: "create_discussion",
  targetKind: "create",
  defaultMax: 1,
  description: "Create a new GitHub Discussion in this repository.",
  inputSchema: {
    type: "object",
    required: ["title", "body"],
    additionalProperties: false,
    properties: {
      title: { type: "string", minLength: 1, maxLength: 256, description: "Discussion title." },
      body: { type: "string", maxLength: 65536, description: "Discussion body (GitHub-flavored Markdown)." },
      category: {
        type: "string",
        description: "Discussion category name or slug (defaults to the workflow's configured category).",
      },
    },
  },

  async apply(args, ctx, github, config = {}) {
    if (typeof github.graphql !== "function") {
      throw new Error("This GitHub client does not support GraphQL, which create-discussion requires.");
    }
    const data = await github.graphql(REPO_QUERY, { owner: ctx.owner, name: ctx.repo });
    const repo = data && data.repository;
    if (!repo) throw new Error(`Repository ${ctx.owner}/${ctx.repo} was not found.`);
    if (!repo.hasDiscussionsEnabled) {
      throw new Error(`Discussions are not enabled for ${ctx.owner}/${ctx.repo}.`);
    }
    const categories = (repo.discussionCategories && repo.discussionCategories.nodes) || [];
    const want = config.category || args.category;
    let category;
    if (want) {
      const w = String(want).toLowerCase();
      category = categories.find((c) => c.name.toLowerCase() === w || c.slug.toLowerCase() === w || c.id === want);
      if (!category) {
        throw new Error(
          `Discussion category '${want}' not found. Available: ${categories.map((c) => c.name).join(", ") || "(none)"}.`
        );
      }
    } else {
      category = categories[0];
      if (!category) throw new Error(`No discussion categories are available in ${ctx.owner}/${ctx.repo}.`);
    }

    const prefix = config.titlePrefix ? String(config.titlePrefix) : "";
    const title = prefix + sanitizeTitle(args.title);
    const body = withFooter(sanitizeText(args.body, { maxLength: 65536 }), config);
    checkAllowedDomains(body, parseList(config.allowedDomains));

    const created = await github.graphql(CREATE_MUTATION, {
      repositoryId: repo.id,
      categoryId: category.id,
      title,
      body,
    });
    const d = created && created.createDiscussion && created.createDiscussion.discussion;
    return d && d.url ? `Created discussion: ${d.url}` : `Created discussion in ${ctx.owner}/${ctx.repo}.`;
  },
};
