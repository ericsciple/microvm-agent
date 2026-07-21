// Parse scope-widening flags passed after the operation id.
//
//   safe-outputs add-labels --allowed-labels bug,triage --max 3
//
// Safe outputs default to the narrowest possible scope (the triggering object,
// exactly the intent the agent supplied). A workflow author can *opt in* to a
// slightly wider scope with flags, which the harness places on the command line
// — never the agent. The agent still only sees the tool schema, so it can't set
// these itself.
//
// Flags are deliberately simple (no dependency on a CLI parser):
//   --key value      -> { key: "value" }
//   --key=value      -> { key: "value" }
//   --flag           -> { flag: true }        (when the next token is another flag or absent)
// Kebab-case keys become camelCase (`--allowed-labels` -> `allowedLabels`).

/**
 * @param {string[]} args - argv tokens after the operation id
 * @returns {Record<string, string|boolean>}
 */
export function parseConfig(args = []) {
  const config = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (typeof token !== "string" || !token.startsWith("--")) {
      throw new Error(`Unexpected argument '${token}'. Expected --flags after the operation id.`);
    }

    const body = token.slice(2);
    if (body === "") {
      throw new Error("Empty flag '--'. Expected a flag name after the dashes.");
    }

    const eq = body.indexOf("=");
    let key;
    let value;
    if (eq >= 0) {
      key = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else {
      key = body;
      const next = args[i + 1];
      if (next !== undefined && !String(next).startsWith("--")) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }

    config[toCamelCase(key)] = value;
  }
  return config;
}

function toCamelCase(key) {
  return key.replace(/-([a-z0-9])/gi, (_, c) => c.toUpperCase());
}
