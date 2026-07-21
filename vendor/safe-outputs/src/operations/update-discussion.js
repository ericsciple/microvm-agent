// Safe output: update-discussion.
//
// Edits a discussion's title and/or body (Class B — GraphQL updateDiscussion).
// Discussions have their own numbering (not issue/PR), so the agent supplies the
// discussion number; we resolve its node id host-side, then run the mutation.

import { sanitizeText, sanitizeTitle } from "../sanitize.js";
import { withFooter } from "../footer.js";
import { checkAllowedDomains } from "../domains.js";
import { parseList } from "../glob.js";

const ID_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ discussion(number:$number){ id } }
}`;

const MUTATION = `mutation($id:ID!,$title:String,$body:String){
  updateDiscussion(input:{discussionId:$id,title:$title,body:$body}){
    discussion{ url number }
  }
}`;

export default {
  id: "update-discussion",
  name: "update_discussion",
  targetKind: "create",
  defaultMax: 1,
  description: "Update the title and/or body of a discussion in this repository (supply its number).",
  inputSchema: {
    type: "object",
    required: ["discussion_number"],
    additionalProperties: false,
    properties: {
      discussion_number: { type: "integer", minimum: 1, description: "The discussion number to update." },
      title: { type: "string", minLength: 1, maxLength: 256, description: "New discussion title." },
      body: { type: "string", maxLength: 65536, description: "New discussion body (GitHub-flavored Markdown)." },
    },
  },

  async apply(args, ctx, github, config = {}) {
    if (typeof github.graphql !== "function") {
      throw new Error("This GitHub client does not support GraphQL, which update-discussion requires.");
    }
    if (args.title === undefined && args.body === undefined) {
      throw new Error("Provide at least one of: title, body.");
    }
    const q = await github.graphql(ID_QUERY, { owner: ctx.owner, name: ctx.repo, number: args.discussion_number });
    const disc = q && q.repository && q.repository.discussion;
    if (!disc) throw new Error(`Discussion #${args.discussion_number} was not found in ${ctx.owner}/${ctx.repo}.`);

    const vars = { id: disc.id, title: null, body: null };
    if (args.title !== undefined) vars.title = sanitizeTitle(args.title);
    if (args.body !== undefined) {
      vars.body = withFooter(sanitizeText(args.body, { maxLength: 65536 }), config);
      checkAllowedDomains(vars.body, parseList(config.allowedDomains));
    }
    const res = await github.graphql(MUTATION, vars);
    const d = res && res.updateDiscussion && res.updateDiscussion.discussion;
    return d && d.url ? `Updated discussion: ${d.url}` : `Updated discussion #${args.discussion_number}.`;
  },
};
