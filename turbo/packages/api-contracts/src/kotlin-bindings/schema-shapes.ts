import { kotlinQuote as quote, schemaObject } from "./syntax";

type Schema = Readonly<Record<string, unknown>>;

export function isNever(value: unknown): boolean {
  return (
    schemaObject(value) &&
    schemaObject(value.not) &&
    Object.keys(value.not).length === 0 &&
    Object.keys(value).length === 1
  );
}

/** Only deliberate, unconstrained canonical JSON leaves qualify. */
export function isJsonValue(value: Schema): boolean {
  return Object.keys(value).length === 0;
}

/** JSON scalar constraints for union selection and outbound typed queries. */
export function scalarPredicate(value: Schema, expression: string): string {
  const checks = [`${expression} is JsonPrimitive`];
  switch (value.type) {
    case "null":
      return `${expression} === JsonNull`;
    case "string":
      checks.push(`${expression}.isString`);
      if (typeof value.const === "string")
        checks.push(`${expression}.content == ${quote(value.const)}`);
      if (Array.isArray(value.enum)) {
        if (
          !value.enum.every((item) => {
            return typeof item === "string";
          })
        )
          throw new Error("Unsupported scalar enum");
        checks.push(
          `${expression}.content in setOf(${value.enum.map(quote).join(", ")})`,
        );
      }
      if (typeof value.minLength === "number")
        checks.push(`${expression}.content.length >= ${value.minLength}`);
      if (typeof value.maxLength === "number")
        checks.push(`${expression}.content.length <= ${value.maxLength}`);
      if (typeof value.pattern === "string")
        checks.push(
          `Regex(${quote(value.pattern)}).containsMatchIn(${expression}.content)`,
        );
      break;
    case "integer":
    case "number": {
      checks.push(`!${expression}.isString`);
      const numeric = ["it.isFinite()"];
      if (value.type === "integer") numeric.push("it % 1.0 == 0.0");
      for (const [field, operator] of [
        ["const", "=="],
        ["minimum", ">="],
        ["maximum", "<="],
        ["exclusiveMinimum", ">"],
        ["exclusiveMaximum", "<"],
      ] as const) {
        const bound = value[field];
        if (typeof bound === "number") {
          if (!Number.isFinite(bound))
            throw new Error("Unsupported non-finite scalar bound");
          const literal = String(bound);
          numeric.push(
            `it ${operator} ${/[.e]/iu.test(literal) ? literal : `${literal}.0`}`,
          );
        }
      }
      checks.push(
        `${expression}.doubleOrNull?.let { ${numeric.join(" && ")} } == true`,
      );
      break;
    }
    case "boolean":
      checks.push(
        `!${expression}.isString`,
        `${expression}.booleanOrNull != null`,
      );
      break;
    default:
      throw new Error("Unsupported scalar schema");
  }
  return `(${checks.join(" && ")})`;
}
