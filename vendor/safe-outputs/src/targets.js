// Target resolution for safe outputs (gh-aw's `target` / `target-repo` /
// `allowed-repos`), with our SAFE DEFAULT: everything is bound to the object in the
// triggering event payload unless the workflow author explicitly opts into widening
// via flags. The agent never sets these — they are harness/author-supplied on the
// command line.

const SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

import { parseList } from "./glob.js";

/**
 * Resolve which repo a safe output writes to. Default = the triggering repo. A
 * `--target-repo owner/repo` is allowed only when it matches the triggering repo, or
 * is in the author-supplied `--allowed-repos` list (default deny cross-repo).
 * @param {{owner?: string, repo?: string}} ctx
 * @param {{targetRepo?: string, allowedRepos?: string}} config
 * @returns {{owner: string, repo: string}}
 */
export function resolveRepo(ctx, config = {}) {
  const current = ctx.owner && ctx.repo ? `${ctx.owner}/${ctx.repo}` : null;
  if (config.targetRepo === undefined) {
    if (!current) throw new Error("Could not determine the repository from GITHUB_REPOSITORY or the event payload.");
    return { owner: ctx.owner, repo: ctx.repo };
  }
  const slug = String(config.targetRepo).trim();
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Invalid target-repo '${slug}'. Expected 'owner/repo'.`);
  }
  if (slug !== current) {
    const allowed = parseList(config.allowedRepos);
    if (!allowed.includes(slug)) {
      throw new Error(
        `Cross-repo target '${slug}' is not permitted. ` +
          (allowed.length ? `Allowed repos: ${allowed.join(", ")}.` : `This workflow allows only ${current || "the triggering repo"}.`)
      );
    }
  }
  const [owner, repo] = slug.split("/");
  return { owner, repo };
}

/**
 * Whether this operation may target an object other than the triggering one — i.e.
 * the author set `--target *` (agent supplies the number) or `--target <number>`.
 */
export function targetAllowsExplicit(config = {}) {
  return config.target !== undefined && String(config.target) !== "triggering" && String(config.target) !== "";
}

/**
 * Resolve the issue/PR number for an object-acting op. Default = the triggering
 * issue/PR. `--target *` requires the agent to pass `item_number`; `--target <n>`
 * pins an explicit number.
 * @param {{issueNumber?: number}} ctx
 * @param {{target?: string}} config
 * @param {{item_number?: number}} args
 * @returns {number}
 */
export function resolveIssueNumber(ctx, config = {}, args = {}) {
  const target = config.target === undefined ? "triggering" : String(config.target);
  if (target === "*") {
    if (args.item_number === undefined) {
      throw new Error("This workflow allows targeting any issue/PR — provide 'item_number'.");
    }
    return Number(args.item_number);
  }
  if (target === "triggering" || target === "") {
    if (!ctx.issueNumber) {
      throw new Error(
        "This safe output acts on the triggering issue or pull request, but the event has no issue/PR number. " +
          "Run it on an issue/pull_request event, or set target to a specific number."
      );
    }
    return ctx.issueNumber;
  }
  const n = Number.parseInt(target, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid target '${target}'. Expected 'triggering', '*', or a number.`);
  return n;
}

/**
 * Add an `item_number` property to an object-acting op's schema when `--target *`
 * is configured, so the agent can name the object. Returns the (possibly augmented)
 * schema unchanged when not applicable.
 */
export function augmentSchemaForTarget(schema, config = {}) {
  if (config.target === undefined || String(config.target) !== "*") return schema;
  const next = {
    ...schema,
    properties: {
      ...schema.properties,
      item_number: {
        type: "integer",
        description: "The number of the issue or pull request to act on.",
      },
    },
    required: [...(schema.required || []), "item_number"],
  };
  return next;
}
