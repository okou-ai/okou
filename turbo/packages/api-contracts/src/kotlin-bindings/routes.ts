import { toJSONSchema } from "zod";
import type { KotlinRouteBinding, KotlinTypeBinding } from "./bindings";
import {
  kotlinIdentifier as identifier,
  kotlinQuote as quote,
  schemaObject,
} from "./syntax";
import { isNever, scalarPredicate } from "./schema-shapes";

export function pathBinding(route: KotlinRouteBinding["route"]): {
  path: string;
  parameters: string[];
  arguments: string[];
} {
  if (
    !/^\/api\/(?:[A-Za-z0-9_-]+|:[A-Za-z_][A-Za-z0-9_]*)(?:\/(?:[A-Za-z0-9_-]+|:[A-Za-z_][A-Za-z0-9_]*))*$/u.test(
      route.path,
    )
  )
    throw new Error("Unsupported Retrofit route path");
  const keys = [...route.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/gu)].map(
    (match) => {
      return match[1]!;
    },
  );
  const schema = route.pathParams
    ? toJSONSchema(route.pathParams, { io: "output" })
    : undefined;
  const pathArguments = keys.map((key) => {
    return identifier(`path${key[0]!.toUpperCase()}${key.slice(1)}`);
  });
  if (
    new Set(keys).size !== keys.length ||
    new Set(pathArguments).size !== pathArguments.length ||
    (keys.length === 0 && schema !== undefined)
  )
    throw new Error("Unsupported Retrofit path parameters");
  if (keys.length > 0) {
    if (
      !schemaObject(schema) ||
      schema.type !== "object" ||
      !schemaObject(schema.properties) ||
      !Array.isArray(schema.required) ||
      schema.required.length !== keys.length ||
      Object.keys(schema.properties).length !== keys.length ||
      !keys.every((key) => {
        return (
          schema.required!.includes(key) &&
          schemaObject(schema.properties![key]) &&
          schema.properties![key].type === "string" &&
          !schema.properties![key].anyOf &&
          !schema.properties![key].enum &&
          schema.properties![key].const === undefined
        );
      })
    )
      throw new Error("Unsupported Retrofit path parameters");
  }
  return {
    path: route.path.replaceAll(/:([A-Za-z_][A-Za-z0-9_]*)/gu, "{$1}"),
    parameters: keys.map((key) => {
      return `@Path(${quote(key)}) ${identifier(`path${key[0]!.toUpperCase()}${key.slice(1)}`)}: String`;
    }),
    arguments: pathArguments,
  };
}

export interface QueryBinding {
  readonly parameters: readonly string[];
  readonly type?: KotlinTypeBinding;
  readonly helper?: string;
}

const scalarKeys = new Set([
  "type",
  "const",
  "enum",
  "default",
  "description",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
]);

function queryObject(schema: unknown): asserts schema is Readonly<
  Record<string, unknown>
> & {
  properties: Record<string, Readonly<Record<string, unknown>>>;
} {
  if (
    !schemaObject(schema) ||
    schema.type !== "object" ||
    !schemaObject(schema.properties) ||
    Object.keys(schema.properties).length === 0 ||
    (schema.additionalProperties !== undefined &&
      schema.additionalProperties !== false) ||
    Object.keys(schema).some((key) => {
      return ![
        "$schema",
        "type",
        "properties",
        "required",
        "additionalProperties",
        "description",
      ].includes(key);
    })
  )
    throw new Error("Unsupported Retrofit query schema");
  for (const [field, value] of Object.entries(schema.properties)) {
    identifier(field);
    if (
      !schemaObject(value) ||
      (!isNever(value) &&
        (!Object.keys(value).every((key) => {
          return scalarKeys.has(key);
        }) ||
          !["string", "integer", "number", "boolean"].includes(
            String(value.type),
          )))
    )
      throw new Error("Unsupported Retrofit query field");
  }
}

export function queryBinding(
  name: string,
  route: KotlinRouteBinding["route"],
): QueryBinding {
  if (!route.query) return { parameters: [] };
  // Query arguments describe post-coercion values. Defaults remain explicit.
  const schema = toJSONSchema(route.query, { io: "output" });
  if (Array.isArray(schema.anyOf)) {
    if (schema.anyOf.length < 2)
      throw new Error("Unsupported Retrofit query union");
    const branches = schema.anyOf;
    branches.forEach(queryObject);
    const queryName = `${name[0]!.toUpperCase()}${name.slice(1)}Query`;
    const checks = branches.map((branch) => {
      queryObject(branch);
      const required = new Set(
        Array.isArray(branch.required) ? branch.required : [],
      );
      const fields = Object.entries(branch.properties).map(([field, value]) => {
        const access = `value[${quote(field)}]`;
        if (isNever(value)) {
          if (required.has(field))
            throw new Error("Unsupported required never query");
          return `!value.containsKey(${quote(field)})`;
        }
        const check = `${access}.let { field -> ${scalarPredicate(value, "field")} }`;
        return required.has(field)
          ? check
          : `(!value.containsKey(${quote(field)}) || ${check})`;
      });
      return `(value.keys.all { it in setOf(${Object.keys(branch.properties).map(quote).join(", ")}) } && ${fields.join(" && ")})`;
    });
    return {
      parameters: [`@QueryMap parameters: Map<String, String>`],
      type: { name: queryName, schema: route.query, direction: "output" },
      helper: `internal fun ${queryName}.toQueryParameters(): Map<String, String> {
    val value = Json.encodeToJsonElement(${queryName}.serializer(), this) as JsonObject
    require(listOf(${checks.join(", ")}).count { it } == 1) { "Invalid ${queryName}" }
    return value.mapValues { (_, field) -> (field as JsonPrimitive).content }
}`,
    };
  }
  queryObject(schema);
  const required = new Set(
    Array.isArray(schema.required) ? schema.required : [],
  );
  const names = new Set<string>();
  return {
    parameters: Object.entries(schema.properties).map(([field, value]) => {
      if (isNever(value) || value.enum || value.const !== undefined)
        throw new Error("Unsupported Retrofit query field");
      const scalar = {
        string: "String",
        integer: "Long",
        number: "Double",
        boolean: "Boolean",
      }[String(value.type)];
      const parameter = identifier(
        `query${field[0]!.toUpperCase()}${field.slice(1)}`,
      );
      if (names.has(parameter))
        throw new Error("Duplicate Retrofit query parameter");
      names.add(parameter);
      return `@Query(${quote(field)}) ${parameter}: ${scalar}${required.has(field) ? "" : "? = null"}`;
    }),
  };
}
