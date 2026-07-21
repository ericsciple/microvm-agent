// Minimal JSON Schema validator.
//
// Supports only the subset of JSON Schema the safe-output tools actually use:
// object/array/string/number/integer/boolean/null types, `required`,
// `properties`, `additionalProperties: false`, `items`, `enum`, `minItems`,
// `minProperties`, and `minLength`. This is deliberately dependency-free (no ajv)
// because the schemas are simple and the whole app ships with zero runtime
// dependencies.
//
// Returns an array of human-readable error strings (empty === valid), suitable
// for handing back to the model so it can self-correct and retry.

export function validate(schema, value) {
  const errors = [];
  check(schema, value, "arguments", errors);
  return errors;
}

function check(schema, value, path, errors) {
  if (!schema || typeof schema !== "object") return;

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) {
      errors.push(`${path}: expected ${types.join(" or ")}, got ${describe(value)}`);
      return; // further checks are meaningless if the base type is wrong
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }

  if (isObject(value)) {
    const properties = schema.properties || {};
    if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) {
      errors.push(`${path}: must have at least ${schema.minProperties} propert${schema.minProperties === 1 ? "y" : "ies"}`);
    }
    for (const req of schema.required || []) {
      if (value[req] === undefined) errors.push(`${path}.${req}: is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${path}.${key}: is not an allowed property`);
      }
    }
    for (const [key, subschema] of Object.entries(properties)) {
      if (value[key] !== undefined) check(subschema, value[key], `${path}.${key}`, errors);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: must have at least ${schema.minItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
    }
  }

  if (typeof value === "string" && typeof schema.minLength === "number" && value.length < schema.minLength) {
    errors.push(`${path}: must be at least ${schema.minLength} character(s)`);
  }

  if (typeof value === "string" && typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    errors.push(`${path}: must be at most ${schema.maxLength} character(s) (it is ${value.length})`);
  }
}

function matchesType(type, value) {
  switch (type) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
