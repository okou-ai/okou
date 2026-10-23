import * as z from "zod";

type SourceSchema = Record<string, unknown>;

function matchesString(value: unknown, schema: SourceSchema): boolean {
  return (
    typeof value === "string" &&
    (typeof schema.minLength !== "number" ||
      value.length >= schema.minLength) &&
    (typeof schema.maxLength !== "number" || value.length <= schema.maxLength)
  );
}

function matchesNumber(value: unknown, schema: SourceSchema): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (schema.type !== "integer" || Number.isSafeInteger(value)) &&
    (typeof schema.minimum !== "number" || value >= schema.minimum) &&
    (typeof schema.maximum !== "number" || value <= schema.maximum) &&
    (typeof schema.exclusiveMinimum !== "number" ||
      value > schema.exclusiveMinimum) &&
    (typeof schema.exclusiveMaximum !== "number" ||
      value < schema.exclusiveMaximum)
  );
}

function matchesArray(value: unknown, schema: SourceSchema): boolean {
  return (
    Array.isArray(value) &&
    schema.items !== undefined &&
    (typeof schema.minItems !== "number" || value.length >= schema.minItems) &&
    (typeof schema.maxItems !== "number" || value.length <= schema.maxItems) &&
    value.every((entry) => {
      return matchesDataSearchSourceSchema(entry, schema.items);
    })
  );
}

function matchesObject(value: unknown, schema: SourceSchema): boolean {
  const record = z.record(z.string(), z.unknown()).safeParse(value);
  const properties = z
    .record(z.string(), z.unknown())
    .safeParse(schema.properties);
  if (!record.success || !properties.success) {
    return false;
  }
  if (
    Array.isArray(schema.required) &&
    schema.required.some((key) => {
      return typeof key !== "string" || record.data[key] === undefined;
    })
  ) {
    return false;
  }
  return Object.entries(record.data).every(([key, entry]) => {
    return (
      properties.data[key] !== undefined &&
      matchesDataSearchSourceSchema(entry, properties.data[key])
    );
  });
}

/** Validate reviewed values against the current provider contract, without trusting it to add capabilities. */
export function matchesDataSearchSourceSchema(
  value: unknown,
  raw: unknown,
): boolean {
  const parsed = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!parsed.success) {
    return false;
  }
  const schema = parsed.data;
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => {
      return candidate === value;
    })
  ) {
    return false;
  }
  if (schema.const !== undefined && schema.const !== value) {
    return false;
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((branch) => {
      return matchesDataSearchSourceSchema(value, branch);
    });
  }
  if (Array.isArray(schema.oneOf)) {
    return (
      schema.oneOf.filter((branch) => {
        return matchesDataSearchSourceSchema(value, branch);
      }).length === 1
    );
  }
  switch (schema.type) {
    case "string": {
      return matchesString(value, schema);
    }
    case "number":
    case "integer": {
      return matchesNumber(value, schema);
    }
    case "boolean": {
      return typeof value === "boolean";
    }
    case "null": {
      return value === null;
    }
    case "array": {
      return matchesArray(value, schema);
    }
    case "object": {
      return matchesObject(value, schema);
    }
    default: {
      return false;
    }
  }
}
