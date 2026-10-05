import { createHash } from "node:crypto";

import {
  OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
  officialWorkflowBlueprintKeySchema,
  officialWorkflowSourceCatalogSchema,
  type OfficialWorkflowAcceptedBlueprint,
  type OfficialWorkflowCatalogDiagnostic,
  type OfficialWorkflowDefinitionRevisionPayload,
  type OfficialWorkflowInstallationParameter,
  type OfficialWorkflowParameterReference,
  type OfficialWorkflowSourceCatalog,
  type OfficialWorkflowSourceDefinition,
  type OfficialWorkflowTemplateJsonValue,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import {
  workflowAutomationCreateRequestSchema,
  workflowNameSchema,
} from "@okouai/api-contracts/contracts/workflows";
import { parseScheduledAtTime } from "@okouai/core/timezone";

import { isValidTimeZone, safeSync, safeUrlParse } from "../utils";
import { INITIAL_AUTONOMY_BUDGET } from "./autonomy-budget.constants";
import { calculateNextRun } from "./time-automation";

export const OFFICIAL_WORKFLOW_DEFINITION_MANIFEST_PATH =
  ".vm0/official-workflow-definition.json";

interface ValidatedActiveDefinition {
  readonly source: ActiveSourceDefinition;
  readonly revisionPayload: OfficialWorkflowDefinitionRevisionPayload;
}

export interface ValidatedOfficialWorkflowCatalog {
  readonly source: OfficialWorkflowSourceCatalog;
  readonly activeDefinitions: ReadonlyMap<string, ValidatedActiveDefinition>;
}

type OfficialWorkflowCatalogValidationResult =
  | {
      readonly kind: "valid";
      readonly catalog: ValidatedOfficialWorkflowCatalog;
    }
  | {
      readonly kind: "invalid";
      readonly diagnostics: readonly OfficialWorkflowCatalogDiagnostic[];
    };

type ActiveSourceDefinition = Extract<
  OfficialWorkflowSourceDefinition,
  { readonly lifecycle: "active" }
>;
type SourceBlueprint = ActiveSourceDefinition["blueprints"][number];
type JsonObject = Readonly<Record<string, unknown>>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJsonString(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonString).join(",")}]`;
  }
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort(compareStrings)
      .map((key) => {
        return `${JSON.stringify(key)}:${canonicalJsonString(value[key])}`;
      })
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Canonical JSON received an unsupported value");
  }
  return encoded;
}

export function officialWorkflowFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value)).digest("hex");
}

function diagnostic(
  code: OfficialWorkflowCatalogDiagnostic["code"],
  path: readonly (string | number)[],
  context: {
    readonly definitionName?: string;
    readonly blueprintKey?: string;
  } = {},
): OfficialWorkflowCatalogDiagnostic {
  return { code, path: [...path], ...context };
}

function zodDiagnostics(
  candidate: unknown,
): readonly OfficialWorkflowCatalogDiagnostic[] {
  const parsed = officialWorkflowSourceCatalogSchema.safeParse(candidate);
  if (parsed.success) {
    return [];
  }
  return parsed.error.issues.map((issue) => {
    const path = issue.path.map((segment) => {
      return typeof segment === "symbol"
        ? (segment.description ?? "symbol")
        : segment;
    });
    const definitionIndex =
      path[0] === "definitions" && typeof path[1] === "number"
        ? path[1]
        : undefined;
    const rawDefinitions =
      isJsonObject(candidate) && Array.isArray(candidate.definitions)
        ? candidate.definitions
        : [];
    const rawDefinition =
      definitionIndex === undefined
        ? undefined
        : rawDefinitions[definitionIndex];
    const rawDefinitionName = isJsonObject(rawDefinition)
      ? rawDefinition.name
      : undefined;
    const parsedDefinitionName =
      workflowNameSchema.safeParse(rawDefinitionName);
    const definitionName = parsedDefinitionName.success
      ? parsedDefinitionName.data
      : undefined;
    const blueprintIndex =
      path[0] === "definitions" &&
      typeof path[1] === "number" &&
      path[2] === "blueprints" &&
      typeof path[3] === "number"
        ? path[3]
        : undefined;
    const rawBlueprints =
      isJsonObject(rawDefinition) && Array.isArray(rawDefinition.blueprints)
        ? rawDefinition.blueprints
        : [];
    const rawBlueprint =
      blueprintIndex === undefined ? undefined : rawBlueprints[blueprintIndex];
    const rawBlueprintKey = isJsonObject(rawBlueprint)
      ? rawBlueprint.key
      : undefined;
    const parsedBlueprintKey =
      officialWorkflowBlueprintKeySchema.safeParse(rawBlueprintKey);
    const blueprintKey = parsedBlueprintKey.success
      ? parsedBlueprintKey.data
      : undefined;
    return diagnostic("invalid-candidate", path, {
      ...(definitionName === undefined ? {} : { definitionName }),
      ...(blueprintKey === undefined ? {} : { blueprintKey }),
    });
  });
}

function stringIsCanonical(value: string): boolean {
  return value.normalize("NFC") === value && !value.includes("\r");
}

function collectNonCanonicalStringPaths(
  value: unknown,
  path: readonly (string | number)[],
  output: (string | number)[][],
): void {
  if (typeof value === "string") {
    if (!stringIsCanonical(value)) {
      output.push([...path]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectNonCanonicalStringPaths(item, [...path, index], output);
    }
    return;
  }
  if (isJsonObject(value)) {
    for (const key of Object.keys(value)) {
      if (!stringIsCanonical(key)) {
        output.push([...path, key]);
      }
      collectNonCanonicalStringPaths(value[key], [...path, key], output);
    }
  }
}

function collectNonCanonicalNumberPaths(
  value: unknown,
  path: readonly (string | number)[],
  output: (string | number)[][],
): void {
  if (typeof value === "number") {
    if (Object.is(value, -0)) {
      output.push([...path]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectNonCanonicalNumberPaths(item, [...path, index], output);
    }
    return;
  }
  if (isJsonObject(value)) {
    for (const key of Object.keys(value)) {
      collectNonCanonicalNumberPaths(value[key], [...path, key], output);
    }
  }
}

function collectUndefinedPaths(
  value: unknown,
  path: readonly (string | number)[],
  output: (string | number)[][],
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectUndefinedPaths(item, [...path, index], output);
    }
    return;
  }
  if (isJsonObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        output.push([...path, key]);
      } else {
        collectUndefinedPaths(item, [...path, key], output);
      }
    }
  }
}

function diagnosticContextForPath(
  catalog: OfficialWorkflowSourceCatalog,
  path: readonly (string | number)[],
): {
  readonly definitionName?: string;
  readonly blueprintKey?: string;
} {
  const definitionIndex =
    path[0] === "definitions" && typeof path[1] === "number"
      ? path[1]
      : undefined;
  const definition =
    definitionIndex === undefined
      ? undefined
      : catalog.definitions[definitionIndex];
  const blueprintIndex =
    definition?.lifecycle === "active" &&
    path[2] === "blueprints" &&
    typeof path[3] === "number"
      ? path[3]
      : undefined;
  const blueprint =
    definition?.lifecycle === "active" && blueprintIndex !== undefined
      ? definition.blueprints[blueprintIndex]
      : undefined;
  return {
    ...(definition === undefined ? {} : { definitionName: definition.name }),
    ...(blueprint === undefined ? {} : { blueprintKey: blueprint.key }),
  };
}

function filePathIsCanonical(path: string): boolean {
  if (
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path === "SKILL.md" ||
    path === OFFICIAL_WORKFLOW_DEFINITION_MANIFEST_PATH
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every((segment) => {
    return segment.length > 0 && segment !== "." && segment !== "..";
  });
}

function parameterSample(
  parameter: OfficialWorkflowInstallationParameter,
): string | number | boolean {
  if (parameter.default !== undefined) {
    return parameter.default;
  }
  if (parameter.type === "integer") {
    return 1;
  }
  if (parameter.type === "boolean") {
    return false;
  }
  if (parameter.format === "uuid") {
    return "00000000-0000-4000-8000-000000000000";
  }
  if (parameter.format === "timezone") {
    return "UTC";
  }
  if (parameter.format === "date-time") {
    return "2027-01-01T00:00:00.000Z";
  }
  if (parameter.format === "url") {
    return "https://example.com";
  }
  return "value";
}

function isParameterReference(
  value: unknown,
): value is OfficialWorkflowParameterReference {
  return (
    isJsonObject(value) &&
    Object.keys(value).length === 1 &&
    typeof value.parameter === "string"
  );
}

function resolveTemplateValue(
  value: OfficialWorkflowTemplateJsonValue,
  parameters: ReadonlyMap<string, OfficialWorkflowInstallationParameter>,
): unknown {
  if (isParameterReference(value)) {
    const parameter = parameters.get(value.parameter);
    return parameter ? parameterSample(parameter) : undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      return resolveTemplateValue(item, parameters);
    });
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        return [
          key,
          resolveTemplateValue(
            item as OfficialWorkflowTemplateJsonValue,
            parameters,
          ),
        ];
      }),
    );
  }
  return value;
}

function withValidationScheduleTimezone(value: unknown): unknown {
  if (!isJsonObject(value) || !isJsonObject(value.schedule)) {
    return value;
  }
  const schedule = value.schedule;
  if (
    (schedule.type === "cron" || schedule.type === "once") &&
    schedule.timezone === undefined
  ) {
    return { ...value, schedule: { ...schedule, timezone: "UTC" } };
  }
  return value;
}

function canonicalizeSetLikeArrays(
  value: OfficialWorkflowTemplateJsonValue,
): OfficialWorkflowTemplateJsonValue {
  if (Array.isArray(value)) {
    const byCanonicalValue = new Map<
      string,
      OfficialWorkflowTemplateJsonValue
    >();
    for (const item of value) {
      const canonicalItem = canonicalizeSetLikeArrays(item);
      byCanonicalValue.set(canonicalJsonString(canonicalItem), canonicalItem);
    }
    return [...byCanonicalValue.entries()]
      .sort(([left], [right]) => {
        return compareStrings(left, right);
      })
      .map(([, item]) => {
        return item;
      });
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        return [
          key,
          canonicalizeSetLikeArrays(item as OfficialWorkflowTemplateJsonValue),
        ];
      }),
    );
  }
  return value;
}

function canonicalizeBlueprintDesiredState(
  blueprint: SourceBlueprint,
): SourceBlueprint["desiredState"] {
  if (
    blueprint.desiredState.kind !== "event" ||
    blueprint.desiredState.eventConfig === undefined
  ) {
    return blueprint.desiredState;
  }
  // Every array in the currently supported event-create configurations is a
  // set-like filter. Keep its identity order- and duplicate-independent; a
  // future ordered event field must add an explicit scoped exception here.
  return {
    ...blueprint.desiredState,
    eventConfig: canonicalizeSetLikeArrays(blueprint.desiredState.eventConfig),
  };
}

function collectParameterReferences(
  value: unknown,
  path: readonly (string | number)[],
  output: {
    readonly parameter: string;
    readonly path: readonly (string | number)[];
  }[],
): void {
  if (isParameterReference(value)) {
    output.push({ parameter: value.parameter, path });
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectParameterReferences(item, [...path, index], output);
    }
    return;
  }
  if (isJsonObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      collectParameterReferences(item, [...path, key], output);
    }
  }
}

function stringDefaultIsValid(
  parameter: Extract<
    OfficialWorkflowInstallationParameter,
    { readonly type: "string" }
  >,
): boolean {
  if (parameter.default === undefined) {
    return true;
  }
  if (parameter.format === "uuid") {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      parameter.default,
    );
  }
  if (parameter.format === "timezone") {
    return isValidTimeZone(parameter.default);
  }
  if (parameter.format === "date-time") {
    const timestamp = Date.parse(parameter.default);
    return (
      Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString() === parameter.default
    );
  }
  if (parameter.format === "url") {
    return safeUrlParse(parameter.default) !== undefined;
  }
  return true;
}

function scheduleConfigurationIsValid(value: unknown): boolean {
  if (!isJsonObject(value) || !isJsonObject(value.schedule)) {
    return true;
  }
  const schedule = value.schedule;
  if (schedule.type === "loop") {
    return (
      typeof schedule.intervalSeconds === "number" &&
      Number.isInteger(schedule.intervalSeconds) &&
      schedule.intervalSeconds > 0
    );
  }
  if (
    (schedule.type !== "cron" && schedule.type !== "once") ||
    typeof schedule.timezone !== "string" ||
    !isValidTimeZone(schedule.timezone)
  ) {
    return false;
  }
  if (schedule.type === "once") {
    return (
      typeof schedule.atTime === "string" &&
      parseScheduledAtTime(schedule.atTime, schedule.timezone).ok
    );
  }
  if (typeof schedule.cronExpression !== "string") {
    return false;
  }
  const next = safeSync(() => {
    return calculateNextRun(
      schedule.cronExpression as string,
      schedule.timezone as string,
      new Date(0),
    );
  });
  return "ok" in next && next.ok !== null;
}

function canonicalizeBlueprint(
  blueprint: SourceBlueprint,
): OfficialWorkflowAcceptedBlueprint {
  const parameters = [...blueprint.parameters].sort((left, right) => {
    return compareStrings(left.key, right.key);
  });
  const desiredState = canonicalizeBlueprintDesiredState(blueprint);
  const fingerprint = officialWorkflowFingerprint({
    parameters,
    desiredState,
    runtime: blueprint.runtime,
  });
  return {
    key: blueprint.key,
    parameters,
    desiredState,
    runtime: blueprint.runtime,
    fingerprint,
  };
}

function validateDefinitionFiles(
  definition: ActiveSourceDefinition,
  definitionIndex: number,
  diagnostics: OfficialWorkflowCatalogDiagnostic[],
): void {
  const context = { definitionName: definition.name };
  const filePaths = new Set<string>();
  let totalFileBytes = 0;
  for (const [fileIndex, file] of definition.workflow.files.entries()) {
    const path = [
      "definitions",
      definitionIndex,
      "workflow",
      "files",
      fileIndex,
      "path",
    ];
    if (!filePathIsCanonical(file.path) || filePaths.has(file.path)) {
      diagnostics.push(diagnostic("non-canonical-value", path, context));
    }
    filePaths.add(file.path);
    totalFileBytes += Buffer.byteLength(file.content, "utf8");
  }
  if (totalFileBytes > 5 * 1024 * 1024) {
    diagnostics.push(
      diagnostic(
        "invalid-candidate",
        ["definitions", definitionIndex, "workflow", "files"],
        context,
      ),
    );
  }
}

function validateBlueprintParameters(
  blueprint: SourceBlueprint,
  args: {
    readonly definitionIndex: number;
    readonly blueprintIndex: number;
    readonly context: {
      readonly definitionName: string;
      readonly blueprintKey: string;
    };
    readonly diagnostics: OfficialWorkflowCatalogDiagnostic[];
  },
): ReadonlyMap<string, OfficialWorkflowInstallationParameter> {
  const parameters = new Map<string, OfficialWorkflowInstallationParameter>();
  for (const [parameterIndex, parameter] of blueprint.parameters.entries()) {
    const parameterPath = [
      "definitions",
      args.definitionIndex,
      "blueprints",
      args.blueprintIndex,
      "parameters",
      parameterIndex,
    ];
    if (parameters.has(parameter.key)) {
      args.diagnostics.push(
        diagnostic(
          "duplicate-parameter-key",
          [...parameterPath, "key"],
          args.context,
        ),
      );
    }
    parameters.set(parameter.key, parameter);
    if (parameter.type === "string" && !stringDefaultIsValid(parameter)) {
      args.diagnostics.push(
        diagnostic(
          "invalid-parameter-declaration",
          [...parameterPath, "default"],
          args.context,
        ),
      );
    }
  }
  return parameters;
}

function desiredStatePath(
  definitionIndex: number,
  blueprintIndex: number,
): readonly (string | number)[] {
  return [
    "definitions",
    definitionIndex,
    "blueprints",
    blueprintIndex,
    "desiredState",
  ];
}

function validateBlueprintDesiredState(
  blueprint: SourceBlueprint,
  parameters: ReadonlyMap<string, OfficialWorkflowInstallationParameter>,
  args: {
    readonly definitionIndex: number;
    readonly blueprintIndex: number;
    readonly context: {
      readonly definitionName: string;
      readonly blueprintKey: string;
    };
    readonly diagnostics: OfficialWorkflowCatalogDiagnostic[];
  },
): void {
  const path = desiredStatePath(args.definitionIndex, args.blueprintIndex);
  const references: {
    readonly parameter: string;
    readonly path: readonly (string | number)[];
  }[] = [];
  collectParameterReferences(blueprint.desiredState, path, references);
  for (const reference of references) {
    if (!parameters.has(reference.parameter)) {
      args.diagnostics.push(
        diagnostic(
          "invalid-blueprint-configuration",
          reference.path,
          args.context,
        ),
      );
    }
  }
  const desiredState = withValidationScheduleTimezone(
    resolveTemplateValue(
      blueprint.desiredState as OfficialWorkflowTemplateJsonValue,
      parameters,
    ),
  );
  let structurallyValid = false;
  if (isJsonObject(desiredState)) {
    const { autonomyBudget: _autonomyBudget, ...createDesiredState } =
      desiredState;
    const createRequest = { ...createDesiredState, enabled: true };
    const parsed =
      workflowAutomationCreateRequestSchema.safeParse(createRequest);
    structurallyValid =
      parsed.success &&
      canonicalJsonString(parsed.data) === canonicalJsonString(createRequest);
  }
  if (!structurallyValid || !scheduleConfigurationIsValid(desiredState)) {
    args.diagnostics.push(
      diagnostic("invalid-blueprint-configuration", path, args.context),
    );
  }
  if (
    isJsonObject(desiredState) &&
    typeof desiredState.autonomyBudget === "number" &&
    (!Number.isInteger(desiredState.autonomyBudget) ||
      desiredState.autonomyBudget < 0 ||
      desiredState.autonomyBudget > INITIAL_AUTONOMY_BUDGET)
  ) {
    args.diagnostics.push(
      diagnostic(
        "invalid-blueprint-configuration",
        [...path, "autonomyBudget"],
        args.context,
      ),
    );
  }
}

function validateDefinitionBlueprints(
  definition: ActiveSourceDefinition,
  definitionIndex: number,
  diagnostics: OfficialWorkflowCatalogDiagnostic[],
): void {
  const blueprintKeys = new Set<string>();
  for (const [blueprintIndex, blueprint] of definition.blueprints.entries()) {
    const canonicalBlueprint = {
      ...blueprint,
      desiredState: canonicalizeBlueprintDesiredState(blueprint),
    };
    const context = {
      definitionName: definition.name,
      blueprintKey: blueprint.key,
    };
    if (blueprintKeys.has(blueprint.key)) {
      diagnostics.push(
        diagnostic(
          "duplicate-blueprint-key",
          ["definitions", definitionIndex, "blueprints", blueprintIndex, "key"],
          context,
        ),
      );
    }
    blueprintKeys.add(blueprint.key);
    const parameters = validateBlueprintParameters(canonicalBlueprint, {
      definitionIndex,
      blueprintIndex,
      context,
      diagnostics,
    });
    validateBlueprintDesiredState(canonicalBlueprint, parameters, {
      definitionIndex,
      blueprintIndex,
      context,
      diagnostics,
    });
  }
}

function canonicalizeActiveDefinition(
  definition: ActiveSourceDefinition,
): ValidatedActiveDefinition {
  const workflow = {
    ...definition.workflow,
    files: [...definition.workflow.files].sort((left, right) => {
      return compareStrings(left.path, right.path);
    }),
  };
  const blueprints = definition.blueprints
    .map(canonicalizeBlueprint)
    .sort((left, right) => {
      return compareStrings(left.key, right.key);
    });
  const definitionBlueprints = blueprints.map(
    ({ fingerprint: _fingerprint, ...blueprint }) => {
      return blueprint;
    },
  );
  const revision = officialWorkflowFingerprint({
    schemaVersion: OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
    name: definition.name,
    workflow,
    blueprints: definitionBlueprints,
  });
  return {
    source: {
      ...definition,
      workflow,
      blueprints: definitionBlueprints,
    },
    revisionPayload: {
      schemaVersion: OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
      name: definition.name,
      revision,
      workflow,
      blueprints,
    },
  };
}

function validateActiveDefinition(
  definition: ActiveSourceDefinition,
  definitionIndex: number,
): {
  readonly diagnostics: readonly OfficialWorkflowCatalogDiagnostic[];
  readonly validated?: ValidatedActiveDefinition;
} {
  const diagnostics: OfficialWorkflowCatalogDiagnostic[] = [];
  validateDefinitionFiles(definition, definitionIndex, diagnostics);
  validateDefinitionBlueprints(definition, definitionIndex, diagnostics);
  if (diagnostics.length > 0) {
    return { diagnostics };
  }
  return {
    diagnostics,
    validated: canonicalizeActiveDefinition(definition),
  };
}

export function validateOfficialWorkflowCatalog(
  candidate: unknown,
): OfficialWorkflowCatalogValidationResult {
  const structuralDiagnostics = zodDiagnostics(candidate);
  if (structuralDiagnostics.length > 0) {
    return { kind: "invalid", diagnostics: structuralDiagnostics };
  }
  const parsed = officialWorkflowSourceCatalogSchema.parse(candidate);
  const undefinedPaths: (string | number)[][] = [];
  collectUndefinedPaths(candidate, [], undefinedPaths);
  if (undefinedPaths.length > 0) {
    return {
      kind: "invalid",
      diagnostics: undefinedPaths.map((path) => {
        return diagnostic(
          "non-canonical-value",
          path,
          diagnosticContextForPath(parsed, path),
        );
      }),
    };
  }
  const diagnostics: OfficialWorkflowCatalogDiagnostic[] = [];
  const nonCanonicalPaths: (string | number)[][] = [];
  collectNonCanonicalStringPaths(parsed, [], nonCanonicalPaths);
  collectNonCanonicalNumberPaths(parsed, [], nonCanonicalPaths);
  diagnostics.push(
    ...nonCanonicalPaths.map((path) => {
      return diagnostic(
        "non-canonical-value",
        path,
        diagnosticContextForPath(parsed, path),
      );
    }),
  );

  const definitionNames = new Set<string>();
  const activeDefinitions = new Map<string, ValidatedActiveDefinition>();
  for (const [definitionIndex, definition] of parsed.definitions.entries()) {
    const presentation = definition.presentation;
    const presentationFields = [
      ["category", presentation.category],
      ["marketingCopy", presentation.marketingCopy],
    ] as const;
    for (const [field, value] of presentationFields) {
      if (value !== undefined && value.trim() !== value) {
        diagnostics.push(
          diagnostic(
            "non-canonical-value",
            ["definitions", definitionIndex, "presentation", field],
            { definitionName: definition.name },
          ),
        );
      }
    }
    if (definitionNames.has(definition.name)) {
      diagnostics.push(
        diagnostic(
          "duplicate-definition-name",
          ["definitions", definitionIndex, "name"],
          { definitionName: definition.name },
        ),
      );
    }
    definitionNames.add(definition.name);
    if (definition.lifecycle === "active") {
      const canonicalWorkflowStrings = [
        ["displayName", definition.workflow.displayName],
        ["description", definition.workflow.description],
        ["instruction", definition.workflow.instruction],
      ] as const;
      for (const [field, value] of canonicalWorkflowStrings) {
        if (value.trim() !== value) {
          diagnostics.push(
            diagnostic(
              "non-canonical-value",
              ["definitions", definitionIndex, "workflow", field],
              { definitionName: definition.name },
            ),
          );
        }
      }
      const result = validateActiveDefinition(definition, definitionIndex);
      diagnostics.push(...result.diagnostics);
      if (result.validated) {
        activeDefinitions.set(definition.name, result.validated);
      }
    }
  }

  if (diagnostics.length > 0) {
    return { kind: "invalid", diagnostics };
  }
  const definitions = [...parsed.definitions].sort((left, right) => {
    return compareStrings(left.name, right.name);
  });
  return {
    kind: "valid",
    catalog: {
      source: {
        schemaVersion: parsed.schemaVersion,
        definitions,
      },
      activeDefinitions,
    },
  };
}
