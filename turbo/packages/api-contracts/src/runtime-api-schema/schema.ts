import { readFile } from "node:fs/promises";
import { z } from "zod";
import packageJson from "../../package.json" with { type: "json" };
import {
  type RuntimeApiRouteBinding,
  runtimeApiRouteBindings,
  runtimeApiRouteOwners,
} from "./routes";

export const runtimeApiSchemaFormatVersion = 1;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface RuntimeApiSchemaDocument {
  readonly schemaFormatVersion: number;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly generatedAt: string;
  readonly routes: readonly RuntimeApiRouteSnapshot[];
}

export interface RuntimeApiRouteSnapshot {
  readonly id: string;
  readonly owner: RuntimeApiRouteBinding["owner"];
  readonly method: string;
  readonly path: string;
  readonly summary?: string;
  readonly contentType?: string;
  readonly request: {
    readonly headers?: RuntimeSchemaSnapshot;
    readonly query?: RuntimeSchemaSnapshot;
    readonly pathParams?: RuntimeSchemaSnapshot;
    readonly body?: RuntimeSchemaSnapshot;
  };
  readonly responses: Readonly<Record<string, RuntimeSchemaSnapshot>>;
}

export type RuntimeSchemaSnapshot =
  | {
      readonly kind: "json-schema";
      readonly schema: JsonObject;
    }
  | {
      readonly kind: "opaque";
      readonly reason: string;
    };

export function buildRuntimeApiSchemaDocument(
  generatedAt = new Date().toISOString(),
  bindings: readonly RuntimeApiRouteBinding[] = runtimeApiRouteBindings,
): RuntimeApiSchemaDocument {
  const routes = bindings.map(normalizeRuntimeApiRoute).sort((left, right) => {
    return left.id.localeCompare(right.id);
  });
  assertUniqueRuntimeApiRoutes(routes);

  return {
    schemaFormatVersion: runtimeApiSchemaFormatVersion,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    generatedAt,
    routes,
  };
}

export function renderRuntimeApiSchemaDocument(
  document = buildRuntimeApiSchemaDocument(),
): string {
  return `${stableStringify(document)}\n`;
}

export async function readRuntimeApiSchemaDocument(
  path: string,
): Promise<RuntimeApiSchemaDocument> {
  const raw = await readFile(path, "utf8");
  return parseRuntimeApiSchemaDocument(JSON.parse(raw));
}

function parseRuntimeApiSchemaDocument(
  value: unknown,
): RuntimeApiSchemaDocument {
  const document = runtimeApiSchemaDocumentSchema.parse(value);
  if (document.schemaFormatVersion !== runtimeApiSchemaFormatVersion) {
    throw new Error(
      `Unsupported runtime API schema format version ${document.schemaFormatVersion}`,
    );
  }
  return document;
}

function normalizeRuntimeApiRoute(
  binding: RuntimeApiRouteBinding,
): RuntimeApiRouteSnapshot {
  const { route } = binding;
  const method = validateString(route.method, `${binding.id}.method`);
  const path = validateString(route.path, `${binding.id}.path`);
  const summary = optionalString(route.summary);
  const contentType = optionalString(route.contentType);

  return {
    id: binding.id,
    owner: binding.owner,
    method,
    path,
    ...(summary ? { summary } : {}),
    ...(contentType ? { contentType } : {}),
    request: {
      ...(route.headers
        ? { headers: normalizeSchema(route.headers, `${binding.id}.headers`) }
        : {}),
      ...(route.query
        ? { query: normalizeSchema(route.query, `${binding.id}.query`) }
        : {}),
      ...(route.pathParams
        ? {
            pathParams: normalizeSchema(
              route.pathParams,
              `${binding.id}.pathParams`,
            ),
          }
        : {}),
      ...(route.body
        ? { body: normalizeSchema(route.body, `${binding.id}.body`) }
        : {}),
    },
    responses: normalizeResponses(route.responses, binding.id),
  };
}

function assertUniqueRuntimeApiRoutes(
  routes: readonly RuntimeApiRouteSnapshot[],
): void {
  const ids = new Set<string>();
  const registrations = new Set<string>();
  for (const route of routes) {
    if (ids.has(route.id)) {
      throw new Error(`Duplicate runtime API route id: ${route.id}`);
    }
    ids.add(route.id);

    const registration = `${route.method} ${route.path}`;
    if (registrations.has(registration)) {
      throw new Error(
        `Duplicate runtime API route registration: ${registration}`,
      );
    }
    registrations.add(registration);
  }
}

function normalizeResponses(
  responses: unknown,
  routeId: string,
): Readonly<Record<string, RuntimeSchemaSnapshot>> {
  if (!responses || typeof responses !== "object" || Array.isArray(responses)) {
    throw new Error(`${routeId}.responses must be an object`);
  }

  const normalized: Record<string, RuntimeSchemaSnapshot> = {};
  for (const [status, schema] of Object.entries(responses)) {
    const responseBodySchema = normalizeResponseSchema(schema);
    normalized[status] = normalizeSchema(
      responseBodySchema,
      `${routeId}.responses.${status}`,
    );
  }
  return normalized;
}

function normalizeResponseSchema(responseSchema: unknown): unknown {
  if (
    responseSchema &&
    typeof responseSchema === "object" &&
    !Array.isArray(responseSchema) &&
    "body" in responseSchema
  ) {
    return (responseSchema as { readonly body?: unknown }).body;
  }
  return responseSchema;
}

function normalizeSchema(
  schema: unknown,
  label: string,
): RuntimeSchemaSnapshot {
  if (isZodSchema(schema)) {
    return {
      kind: "json-schema",
      schema: normalizeJsonValue(z.toJSONSchema(schema), label),
    };
  }

  return {
    kind: "opaque",
    reason: `Schema at ${label} cannot be represented as JSON Schema`,
  };
}

function isZodSchema(schema: unknown): schema is z.ZodType {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "safeParse" in schema &&
    typeof (schema as { readonly safeParse?: unknown }).safeParse === "function"
  );
}

function normalizeJsonValue(value: unknown, label: string): JsonObject {
  const rendered = JSON.stringify(value);
  if (!rendered) {
    throw new Error(`${label} JSON Schema must be an object`);
  }

  const parsed = jsonObjectSchema.safeParse(JSON.parse(rendered));
  if (!parsed.success) {
    throw new Error(`${label} JSON Schema must be an object`);
  }
  return parsed.data;
}

function validateString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value), null, 2);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  return value;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => {
  return z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]);
});

const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  jsonValueSchema,
);

const runtimeSchemaSnapshotSchema: z.ZodType<RuntimeSchemaSnapshot> = z.union([
  z.object({
    kind: z.literal("json-schema"),
    schema: jsonObjectSchema,
  }),
  z.object({
    kind: z.literal("opaque"),
    reason: z.string(),
  }),
]);

const runtimeApiRouteSnapshotSchema: z.ZodType<RuntimeApiRouteSnapshot> =
  z.object({
    id: z.string().min(1),
    owner: z.enum(runtimeApiRouteOwners),
    method: z.string().min(1),
    path: z.string().min(1),
    summary: z.string().optional(),
    contentType: z.string().optional(),
    request: z.object({
      headers: runtimeSchemaSnapshotSchema.optional(),
      query: runtimeSchemaSnapshotSchema.optional(),
      pathParams: runtimeSchemaSnapshotSchema.optional(),
      body: runtimeSchemaSnapshotSchema.optional(),
    }),
    responses: z.record(z.string(), runtimeSchemaSnapshotSchema),
  });

const runtimeApiSchemaDocumentSchema: z.ZodType<RuntimeApiSchemaDocument> =
  z.object({
    schemaFormatVersion: z.number(),
    packageName: z.string(),
    packageVersion: z.string(),
    generatedAt: z.string(),
    routes: z.array(runtimeApiRouteSnapshotSchema),
  });
