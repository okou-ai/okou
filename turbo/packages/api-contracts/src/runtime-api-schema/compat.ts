import type { RuntimeApiRouteOwner } from "./routes";
import {
  type JsonObject,
  type JsonValue,
  type RuntimeApiRouteSnapshot,
  type RuntimeApiSchemaDocument,
  type RuntimeSchemaSnapshot,
} from "./schema";

export interface RuntimeApiCompatFinding {
  readonly severity: "error";
  readonly route: string;
  readonly routeId: string;
  readonly owner: RuntimeApiRouteOwner;
  /** Method and path of the production route the finding was found on. */
  readonly method: string;
  readonly routePath: string;
  /** The 2xx status whose body changed; set only for response findings. */
  readonly responseStatus?: number;
  readonly direction: "request" | "response" | "route";
  readonly path: string;
  readonly kind: string;
  readonly problem: string;
  readonly impact: string;
  readonly recommendation: string;
  readonly agentPrompt: string;
}

interface CompareContext {
  readonly online: RuntimeApiRouteSnapshot;
  readonly direction: RuntimeApiCompatFinding["direction"];
  readonly responseStatus?: number;
  readonly findings: RuntimeApiCompatFinding[];
}

export function compareRuntimeApiSchemas(
  online: RuntimeApiSchemaDocument,
  current: RuntimeApiSchemaDocument,
): readonly RuntimeApiCompatFinding[] {
  const findings: RuntimeApiCompatFinding[] = [];
  const currentRoutes = new Map(
    current.routes.map((route) => {
      return [route.id, route];
    }),
  );
  // Renaming a binding id (for example a Swift member name) keeps the route.
  const currentRegistrations = new Map(
    current.routes.map((route) => {
      return [routeRegistration(route), route];
    }),
  );

  for (const onlineRoute of online.routes) {
    const currentRoute =
      currentRoutes.get(onlineRoute.id) ??
      currentRegistrations.get(routeRegistration(onlineRoute));
    if (!currentRoute) {
      findings.push(
        routeFinding(onlineRoute, {
          direction: "route",
          path: "$",
          kind: "route-removed",
          problem:
            "The runtime API route exists in production schema but is missing from the current schema.",
          recommendation:
            "Keep the route for one release, or add an explicit compatibility shim that preserves the old path.",
        }),
      );
      continue;
    }

    compareRouteIdentity(onlineRoute, currentRoute, findings);
    compareRequestPart(onlineRoute, currentRoute, "headers", findings);
    compareRequestPart(onlineRoute, currentRoute, "query", findings);
    compareRequestPart(onlineRoute, currentRoute, "pathParams", findings);
    compareRequestPart(onlineRoute, currentRoute, "body", findings);
    compareResponses(onlineRoute, currentRoute, findings);
  }

  return findings;
}

function compareRouteIdentity(
  online: RuntimeApiRouteSnapshot,
  current: RuntimeApiRouteSnapshot,
  findings: RuntimeApiCompatFinding[],
): void {
  if (online.method !== current.method) {
    findings.push(
      routeFinding(online, {
        direction: "route",
        path: "method",
        kind: "method-changed",
        problem: `The route method changed from ${online.method} to ${current.method}.`,
        recommendation:
          "Keep the previous method/path live for one release and add a new route separately.",
      }),
    );
  }

  if (online.path !== current.path) {
    findings.push(
      routeFinding(online, {
        direction: "route",
        path: "path",
        kind: "path-changed",
        problem: `The route path changed from ${online.path} to ${current.path}.`,
        recommendation:
          "Keep the previous method/path live for one release and add a new route separately.",
      }),
    );
  }
}

function compareRequestPart(
  online: RuntimeApiRouteSnapshot,
  current: RuntimeApiRouteSnapshot,
  part: keyof RuntimeApiRouteSnapshot["request"],
  findings: RuntimeApiCompatFinding[],
): void {
  const onlineSchema = online.request[part];
  if (!onlineSchema) {
    return;
  }

  const currentSchema = current.request[part];
  const context: CompareContext = {
    online,
    direction: "request",
    findings,
  };

  compareSchemaSubset(onlineSchema, currentSchema, `request.${part}`, context);
}

function compareResponses(
  online: RuntimeApiRouteSnapshot,
  current: RuntimeApiRouteSnapshot,
  findings: RuntimeApiCompatFinding[],
): void {
  for (const [status, onlineSchema] of Object.entries(online.responses)) {
    if (!status.startsWith("2")) {
      continue;
    }

    const currentSchema = current.responses[status];
    const context: CompareContext = {
      online,
      direction: "response",
      responseStatus: Number(status),
      findings,
    };

    compareSchemaSubset(
      currentSchema,
      onlineSchema,
      `responses.${status}`,
      context,
    );
  }
}

function compareSchemaSubset(
  subset: RuntimeSchemaSnapshot | undefined,
  superset: RuntimeSchemaSnapshot | undefined,
  path: string,
  context: CompareContext,
): void {
  if (!subset) {
    return;
  }

  if (!superset) {
    pushFinding(context, {
      path,
      kind: `${context.direction}-schema-removed`,
      problem:
        context.direction === "request"
          ? "The current API schema removed a request part that production runtime clients may still send."
          : "The current API schema removed a response schema that production runtime clients may still expect.",
      recommendation:
        "Keep the old schema shape accepted for one release before removing it.",
    });
    return;
  }

  if (subset.kind === "opaque" || superset.kind === "opaque") {
    return;
  }

  compareJsonSchemaSubset(subset.schema, superset.schema, path, context);
}

function compareJsonSchemaSubset(
  subset: JsonObject,
  superset: JsonObject,
  path: string,
  context: CompareContext,
): void {
  compareTypeSubset(subset, superset, path, context);
  compareEnumSubset(subset, superset, path, context);
  compareConstSubset(subset, superset, path, context);
  compareObjectSubset(subset, superset, path, context);
  compareArraySubset(subset, superset, path, context);
  compareBoundsSubset(subset, superset, path, context);
  compareUnionSubset(subset, superset, path, context);
}

function compareTypeSubset(
  subset: JsonObject,
  superset: JsonObject,
  path: string,
  context: CompareContext,
): void {
  const subsetTypes = readTypeSet(subset);
  const supersetTypes = readTypeSet(superset);
  if (!subsetTypes || !supersetTypes) {
    return;
  }

  for (const type of subsetTypes) {
    if (!supersetTypes.has(type)) {
      pushFinding(context, {
        path,
        kind: `${context.direction}-type-narrowed`,
        problem:
          context.direction === "request"
            ? `The current schema no longer accepts type ${type} at ${path}.`
            : `The current schema can return type ${type} at ${path}, which the production schema does not declare.`,
        recommendation:
          context.direction === "request"
            ? "Keep the old type accepted for one release, usually with a union or compatibility parser."
            : "Keep returning only the production types until production clients accept the new type.",
      });
    }
  }
}

function compareEnumSubset(
  subset: JsonObject,
  superset: JsonObject,
  path: string,
  context: CompareContext,
): void {
  const subsetEnum = readStringArray(subset.enum);
  const supersetEnum = readStringArray(superset.enum);
  if (!subsetEnum || !supersetEnum) {
    return;
  }

  for (const value of subsetEnum) {
    if (!supersetEnum.includes(value)) {
      pushFinding(context, {
        path,
        kind: `${context.direction}-enum-value-removed`,
        problem:
          context.direction === "request"
            ? `Enum value ${JSON.stringify(value)} is present in production schema but not in the current schema.`
            : `Enum value ${JSON.stringify(value)} can be returned by the current schema but is not in the production schema, so clients that decode the production enum reject it.`,
        recommendation:
          context.direction === "request"
            ? "Keep accepting the previous enum value for one release before removing it."
            : "Do not return the new enum value until production clients decode it, or render it as a production value for them.",
      });
    }
  }
}

function compareConstSubset(
  subset: JsonObject,
  superset: JsonObject,
  path: string,
  context: CompareContext,
): void {
  if (!("const" in subset) || !("const" in superset)) {
    return;
  }

  if (subset.const !== superset.const) {
    const [production, current] = productionFirst(
      context,
      subset.const,
      superset.const,
    );
    pushFinding(context, {
      path,
      kind: `${context.direction}-const-changed`,
      problem: `Const value changed from ${JSON.stringify(production)} to ${JSON.stringify(current)}.`,
      recommendation:
        "Keep the previous const value accepted for one release, usually by widening to an enum/union.",
    });
  }
}

function compareObjectSubset(
  subset: JsonObject,
  superset: JsonObject,
  path: string,
  context: CompareContext,
): void {
  if (!isObjectSchema(subset) || !isObjectSchema(superset)) {
    return;
  }

  const subsetProperties = readProperties(subset.properties);
  const supersetProperties = readProperties(superset.properties);
  const subsetRequired = new Set(readStringArray(subset.required) ?? []);
  const supersetRequired = new Set(readStringArray(superset.required) ?? []);

  for (const requiredField of supersetRequired) {
    if (!subsetRequired.has(requiredField)) {
      pushFinding(context, {
        path: `${path}.${requiredField}`,
        kind:
          context.direction === "request"
            ? "request-required-field-added"
            : "response-required-field-removed",
        problem:
          context.direction === "request"
            ? `Field ${requiredField} is required by the current schema but was not required by the production schema.`
            : `Field ${requiredField} is required by production clients but may be missing from the current response schema.`,
        recommendation:
          context.direction === "request"
            ? "Make the new request field optional, provide a default, or accept both old and new request shapes."
            : "Keep returning the field for one release, or make sure runtime clients no longer require it first.",
      });
    }
  }

  for (const [field, subsetFieldSchema] of Object.entries(subsetProperties)) {
    const fieldPath = `${path}.${field}`;
    const supersetFieldSchema = supersetProperties[field];

    if (!supersetFieldSchema) {
      if (context.direction === "request" && subsetRequired.has(field)) {
        pushFinding(context, {
          path: fieldPath,
          kind: "request-required-field-removed",
          problem: `Required field ${field} exists in production request schema but is missing from the current schema.`,
          recommendation:
            "Keep accepting this field for one release. For renames, accept the old alias and normalize it in the handler.",
        });
      }
      continue;
    }

    compareJsonSchemaSubset(
      subsetFieldSchema,
      supersetFieldSchema,
      fieldPath,
      context,
    );
  }
}

function compareArraySubset(
  subset: JsonObject,
  superset: JsonObject,
  path: string,
  context: CompareContext,
): void {
  const subsetItems = readObject(subset.items);
  const supersetItems = readObject(superset.items);
  if (!subsetItems || !supersetItems) {
    return;
  }
  compareJsonSchemaSubset(subsetItems, supersetItems, `${path}[]`, context);
}

function compareBoundsSubset(
  subset: JsonObject,
  superset: JsonObject,
  path: string,
  context: CompareContext,
): void {
  compareLowerBound(subset, superset, "minimum", path, context);
  compareLowerBound(subset, superset, "minLength", path, context);
  compareLowerBound(subset, superset, "minItems", path, context);
  compareUpperBound(subset, superset, "maximum", path, context);
  compareUpperBound(subset, superset, "maxLength", path, context);
  compareUpperBound(subset, superset, "maxItems", path, context);
}

function compareLowerBound(
  subset: JsonObject,
  superset: JsonObject,
  key: string,
  path: string,
  context: CompareContext,
): void {
  const subsetValue = readNumber(subset[key]);
  const supersetValue = readNumber(superset[key]);
  if (subsetValue === undefined || supersetValue === undefined) {
    return;
  }

  if (subsetValue < supersetValue) {
    const [production, current] = productionFirst(
      context,
      subsetValue,
      supersetValue,
    );
    pushFinding(context, {
      path,
      kind: `${context.direction}-lower-bound-tightened`,
      problem: `The lower bound ${key} changed from ${production} to ${current}.`,
      recommendation:
        "Keep the previous lower bound accepted for one release before tightening it.",
    });
  }
}

function compareUpperBound(
  subset: JsonObject,
  superset: JsonObject,
  key: string,
  path: string,
  context: CompareContext,
): void {
  const subsetValue = readNumber(subset[key]);
  const supersetValue = readNumber(superset[key]);
  if (subsetValue === undefined || supersetValue === undefined) {
    return;
  }

  if (subsetValue > supersetValue) {
    const [production, current] = productionFirst(
      context,
      subsetValue,
      supersetValue,
    );
    pushFinding(context, {
      path,
      kind: `${context.direction}-upper-bound-tightened`,
      problem: `The upper bound ${key} changed from ${production} to ${current}.`,
      recommendation:
        "Keep the previous upper bound accepted for one release before tightening it.",
    });
  }
}

function compareUnionSubset(
  subset: JsonObject,
  superset: JsonObject,
  path: string,
  context: CompareContext,
): void {
  const subsetBranches =
    readSchemaArray(subset.anyOf) ?? readSchemaArray(subset.oneOf);
  const supersetBranches =
    readSchemaArray(superset.anyOf) ?? readSchemaArray(superset.oneOf);

  if (!subsetBranches || !supersetBranches) {
    return;
  }

  for (const [index, branch] of subsetBranches.entries()) {
    const compatible = supersetBranches.some((candidate) => {
      const nestedFindings: RuntimeApiCompatFinding[] = [];
      compareJsonSchemaSubset(branch, candidate, path, {
        ...context,
        findings: nestedFindings,
      });
      return nestedFindings.length === 0;
    });

    if (!compatible) {
      pushFinding(context, {
        path: `${path}.anyOf[${index}]`,
        kind: `${context.direction}-union-branch-removed`,
        problem:
          context.direction === "request"
            ? "A union branch present in the production schema is not accepted by the current schema."
            : "A union branch the current schema can return is not accepted by the production schema.",
        recommendation:
          "Keep the previous union branch accepted for one release before removing it.",
      });
    }
  }
}

type FindingInput = Pick<
  RuntimeApiCompatFinding,
  "direction" | "path" | "kind" | "problem" | "recommendation"
>;

function routeFinding(
  route: RuntimeApiRouteSnapshot,
  input: FindingInput,
): RuntimeApiCompatFinding {
  return buildFinding(route, undefined, input);
}

function pushFinding(
  context: CompareContext,
  input: Omit<FindingInput, "direction">,
): void {
  context.findings.push(
    buildFinding(context.online, context.responseStatus, {
      direction: context.direction,
      ...input,
    }),
  );
}

function buildFinding(
  route: RuntimeApiRouteSnapshot,
  responseStatus: number | undefined,
  input: FindingInput,
): RuntimeApiCompatFinding {
  const impact = impactFor(input.direction, route.owner);
  const agentPrompt = [
    "You are fixing a one-version runtime API compatibility break.",
    `Route: ${routeLabel(route)}.`,
    `Problem: ${input.problem}`,
    `Impact: ${impact}`,
    `Fix guidance: ${input.recommendation}`,
    "Preserve compatibility with the online production schema. Prefer accepting both old and new request shapes, using optional fields, aliases, defaults, or a union/preprocess compatibility layer. Add a targeted test for the old production payload before tightening the contract in a later release.",
  ].join(" ");

  return {
    severity: "error",
    route: routeLabel(route),
    routeId: route.id,
    owner: route.owner,
    method: route.method,
    routePath: route.path,
    ...(responseStatus === undefined ? {} : { responseStatus }),
    impact,
    agentPrompt,
    ...input,
  };
}

function impactFor(
  direction: RuntimeApiCompatFinding["direction"],
  owner: RuntimeApiRouteOwner,
): string {
  if (owner === "desktop") {
    return desktopImpactFor(direction);
  }

  if (direction === "request") {
    return "Existing production runner, guest-agent, or MITM clients may receive HTTP 400 from the new API during an otherwise healthy container run, causing run execution, artifact publication, telemetry, or completion to be marked failed.";
  }

  if (direction === "response") {
    return "Existing production runner, guest-agent, or MITM clients may fail to decode the new API response during container execution, causing the task to fail after deployment.";
  }

  return "Existing production runner, guest-agent, or MITM clients may keep calling the old method/path during a rolling release and fail against the new API.";
}

function desktopImpactFor(
  direction: RuntimeApiCompatFinding["direction"],
): string {
  if (direction === "request") {
    return "Affects the Okou Desktop client. Installed Desktop builds keep sending the production request shape, so the new API may reject them with HTTP 400 until users install an update; the API deploys minutes after merge, while a Desktop release reaches users much later.";
  }

  if (direction === "response") {
    return "Affects the Okou Desktop client. Installed Desktop builds decode this response strictly against their generated Swift bindings, so every installed build fails at decode time once the API deploys, until users install an update that reads the new shape.";
  }

  return "Affects the Okou Desktop client. Installed Desktop builds keep calling the production method and path and fail against the new API until users install an update.";
}

/**
 * Request parts compare production as the subset; responses compare the
 * current schema as the subset. Returns the pair as [production, current].
 */
function productionFirst<T>(
  context: CompareContext,
  subsetValue: T,
  supersetValue: T,
): readonly [T, T] {
  return context.direction === "request"
    ? [subsetValue, supersetValue]
    : [supersetValue, subsetValue];
}

function routeRegistration(route: RuntimeApiRouteSnapshot): string {
  return `${route.owner} ${route.method} ${route.path}`;
}

function routeLabel(route: RuntimeApiRouteSnapshot): string {
  return `${route.method} ${route.path}`;
}

function isObjectSchema(schema: JsonObject): boolean {
  const types = readTypeSet(schema);
  return (
    types?.has("object") === true || readObject(schema.properties) !== undefined
  );
}

function readTypeSet(schema: JsonObject): ReadonlySet<string> | undefined {
  const type = schema.type;
  if (typeof type === "string") {
    return new Set([type]);
  }
  const types = readStringArray(type);
  return types ? new Set(types) : undefined;
}

function readProperties(
  value: JsonValue | undefined,
): Record<string, JsonObject> {
  const properties = readObject(value);
  if (!properties) {
    return {};
  }

  const result: Record<string, JsonObject> = {};
  for (const [key, schema] of Object.entries(properties)) {
    const objectSchema = readObject(schema);
    if (objectSchema) {
      result[key] = objectSchema;
    }
  }
  return result;
}

function readSchemaArray(
  value: JsonValue | undefined,
): readonly JsonObject[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const schemas = value.map(readObject);
  return schemas.every((schema): schema is JsonObject => {
    return schema !== undefined;
  })
    ? schemas
    : undefined;
}

function readObject(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function readStringArray(
  value: JsonValue | undefined,
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every((item) => {
    return typeof item === "string";
  })
    ? (value as readonly string[])
    : undefined;
}

function readNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}
