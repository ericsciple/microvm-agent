// Safe output: assign-milestone.
//
// Assigns a milestone to the triggering issue/PR (Class A REST). The agent may name
// the milestone by number or by title; a title is resolved to its number host-side.
// Pass milestone: null to clear.

export default {
  id: "assign-milestone",
  name: "assign_milestone",
  targetKind: "issue",
  defaultMax: 1,
  description:
    "Assign a milestone (by number or title) to the issue or pull request this workflow is running on. " +
    "The target is fixed to the triggering issue/PR unless the workflow widens it.",
  inputSchema: {
    type: "object",
    required: ["milestone"],
    additionalProperties: false,
    properties: {
      milestone: {
        type: "string",
        description: "The milestone number or exact title to assign.",
      },
    },
  },

  async apply(args, ctx, github) {
    const raw = String(args.milestone).trim();
    let number;
    if (/^\d+$/.test(raw)) {
      number = Number(raw);
    } else {
      // Resolve a title to its number (search open then closed).
      const found = await findMilestoneByTitle(github, ctx, raw);
      if (found === undefined) {
        throw new Error(`Milestone '${raw}' was not found in ${ctx.owner}/${ctx.repo}.`);
      }
      number = found;
    }
    await github.request("PATCH", `/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.issueNumber}`, {
      milestone: number,
    });
    return `Assigned milestone #${number} to ${ctx.owner}/${ctx.repo}#${ctx.issueNumber}.`;
  },
};

async function findMilestoneByTitle(github, ctx, title) {
  for (const state of ["open", "closed"]) {
    const list = await github.request(
      "GET",
      `/repos/${ctx.owner}/${ctx.repo}/milestones?state=${state}&per_page=100`
    );
    if (Array.isArray(list)) {
      const hit = list.find((m) => m && m.title === title);
      if (hit) return hit.number;
    }
  }
  return undefined;
}
