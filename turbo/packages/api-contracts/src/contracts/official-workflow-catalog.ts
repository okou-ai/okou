import {
  array,
  boolean,
  discriminatedUnion,
  lazy,
  literal,
  number,
  never as zNever,
  object,
  record,
  string,
  union,
  url,
  uuid,
  enum as zEnum,
  null as zNull,
  type infer as zInfer,
  type ZodType,
} from "zod";

import { contentBundleSchema } from "./content-bundle";

import { automationEventTypeSchema, workflowNameSchema } from "./workflows";
import {
  officialWorkflowBlueprintKeySchema,
  officialWorkflowParameterKeySchema,
} from "./official-workflow-bindings";

export {
  officialWorkflowBlueprintKeySchema,
  officialWorkflowParameterKeySchema,
  officialWorkflowParameterValueSchema,
  officialWorkflowParameterBindingSchema,
  officialWorkflowBlueprintBindingsSchema,
} from "./official-workflow-bindings";
export type {
  OfficialWorkflowParameterValue,
  OfficialWorkflowParameterBinding,
  OfficialWorkflowBlueprintBindings,
} from "./official-workflow-bindings";

/**
 * The only schema version the source catalog and publication writer emit.
 * Persisted readers also decode schema v2, whose immutable accepted catalogs
 * and revisions are still referenced by retired definitions and Run provenance.
 */
export const OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION = 3 as const;

export const officialWorkflowLifecycleSchema = zEnum(["active", "retired"]);
export type OfficialWorkflowLifecycle = zInfer<
  typeof officialWorkflowLifecycleSchema
>;

const officialWorkflowParameterBaseShape = {
  key: officialWorkflowParameterKeySchema,
  required: boolean(),
};

const officialWorkflowStringParameterSchema = object({
  ...officialWorkflowParameterBaseShape,
  type: literal("string"),
  format: zEnum(["text", "uuid", "timezone", "date-time", "url"]).default(
    "text",
  ),
  default: string().optional(),
}).strict();

const officialWorkflowIntegerParameterSchema = object({
  ...officialWorkflowParameterBaseShape,
  type: literal("integer"),
  default: number().int().safe().optional(),
}).strict();

const officialWorkflowBooleanParameterSchema = object({
  ...officialWorkflowParameterBaseShape,
  type: literal("boolean"),
  default: boolean().optional(),
}).strict();

export const officialWorkflowInstallationParameterSchema = discriminatedUnion(
  "type",
  [
    officialWorkflowStringParameterSchema,
    officialWorkflowIntegerParameterSchema,
    officialWorkflowBooleanParameterSchema,
  ],
);
export type OfficialWorkflowInstallationParameter = zInfer<
  typeof officialWorkflowInstallationParameterSchema
>;

export const officialWorkflowParameterReferenceSchema = object({
  parameter: officialWorkflowParameterKeySchema,
}).strict();
export type OfficialWorkflowParameterReference = zInfer<
  typeof officialWorkflowParameterReferenceSchema
>;

export type OfficialWorkflowTemplateJsonValue =
  | null
  | boolean
  | number
  | string
  | OfficialWorkflowParameterReference
  | readonly OfficialWorkflowTemplateJsonValue[]
  | { readonly [key: string]: OfficialWorkflowTemplateJsonValue };

export const officialWorkflowTemplateJsonValueSchema: ZodType<OfficialWorkflowTemplateJsonValue> =
  lazy(() => {
    return union([
      zNull(),
      boolean(),
      number().safe(),
      string(),
      officialWorkflowParameterReferenceSchema,
      array(officialWorkflowTemplateJsonValueSchema),
      record(string(), officialWorkflowTemplateJsonValueSchema),
    ]);
  });

const templatedStringSchema = union([
  string(),
  officialWorkflowParameterReferenceSchema,
]);
const templatedIntegerSchema = union([
  number().int().safe(),
  officialWorkflowParameterReferenceSchema,
]);

export const officialWorkflowScheduleTemplateSchema = discriminatedUnion(
  "type",
  [
    object({
      type: literal("cron"),
      cronExpression: templatedStringSchema,
      timezone: templatedStringSchema.optional(),
    }).strict(),
    object({
      type: literal("loop"),
      intervalSeconds: templatedIntegerSchema,
    }).strict(),
    object({
      type: literal("once"),
      atTime: templatedStringSchema,
      timezone: templatedStringSchema.optional(),
    }).strict(),
  ],
);

const officialWorkflowScheduleDesiredStateSchema = object({
  kind: literal("schedule"),
  schedule: officialWorkflowScheduleTemplateSchema,
  autonomyBudget: templatedIntegerSchema.optional(),
}).strict();

const officialWorkflowEventDesiredStateSchema = object({
  kind: literal("event"),
  eventType: automationEventTypeSchema,
  eventConfig: officialWorkflowTemplateJsonValueSchema.optional(),
  autonomyBudget: templatedIntegerSchema.optional(),
}).strict();

export const officialWorkflowBlueprintDesiredStateSchema = discriminatedUnion(
  "kind",
  [
    officialWorkflowScheduleDesiredStateSchema,
    officialWorkflowEventDesiredStateSchema,
  ],
);
export type OfficialWorkflowBlueprintDesiredState = zInfer<
  typeof officialWorkflowBlueprintDesiredStateSchema
>;

const officialWorkflowBlueprintShape = {
  key: officialWorkflowBlueprintKeySchema,
  parameters: array(officialWorkflowInstallationParameterSchema),
  desiredState: officialWorkflowBlueprintDesiredStateSchema,
};

/** Source Blueprint: schema v3 carries no runtime settings. */
export const officialWorkflowBlueprintSchema = object(
  officialWorkflowBlueprintShape,
).strict();
export type OfficialWorkflowBlueprint = zInfer<
  typeof officialWorkflowBlueprintSchema
>;

export const officialWorkflowFileSchema = object({
  path: string().min(1).max(256),
  content: string(),
}).strict();

export const officialWorkflowExecutableSchema = object({
  displayName: string().min(1).max(256),
  description: string().min(1).max(1024),
  instruction: string().max(5 * 1024 * 1024),
  files: array(officialWorkflowFileSchema).max(500),
}).strict();
export type OfficialWorkflowExecutable = zInfer<
  typeof officialWorkflowExecutableSchema
>;

export const officialWorkflowPresentationSchema = object({
  category: string().min(1).max(64).optional(),
  coverImageUrl: url().optional(),
  order: number().int().safe().optional(),
  marketingCopy: string().min(1).max(2048).optional(),
}).strict();
export type OfficialWorkflowPresentation = zInfer<
  typeof officialWorkflowPresentationSchema
>;

const activeOfficialWorkflowSourceDefinitionSchema = object({
  name: workflowNameSchema,
  lifecycle: literal("active"),
  workflow: officialWorkflowExecutableSchema,
  blueprints: array(officialWorkflowBlueprintSchema),
  presentation: officialWorkflowPresentationSchema,
}).strict();

const retiredOfficialWorkflowSourceDefinitionSchema = object({
  name: workflowNameSchema,
  lifecycle: literal("retired"),
  presentation: officialWorkflowPresentationSchema,
}).strict();

export const officialWorkflowSourceDefinitionSchema = discriminatedUnion(
  "lifecycle",
  [
    activeOfficialWorkflowSourceDefinitionSchema,
    retiredOfficialWorkflowSourceDefinitionSchema,
  ],
);
export type OfficialWorkflowSourceDefinition = zInfer<
  typeof officialWorkflowSourceDefinitionSchema
>;

export const officialWorkflowSourceCatalogSchema = object({
  schemaVersion: literal(OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION),
  definitions: array(officialWorkflowSourceDefinitionSchema),
}).strict();
export type OfficialWorkflowSourceCatalog = zInfer<
  typeof officialWorkflowSourceCatalogSchema
>;

const fingerprintSchema = string().regex(/^[0-9a-f]{64}$/);

export const officialWorkflowArtifactReferenceSchema = object({
  storageName: string().min(1).max(256),
  storageId: uuid(),
  storageVersion: fingerprintSchema,
}).strict();
export type OfficialWorkflowArtifactReference = zInfer<
  typeof officialWorkflowArtifactReferenceSchema
>;

// Accepted catalog and revision payloads are immutable once persisted. Each
// supported schema version keeps its original required fields; a payload is
// parsed only by the schema its own `schemaVersion` names.

// Schema v2 required the retired completion-email runtime setting. It is
// decoded only to read immutable v2 identities; no consumer acts on it.
const officialWorkflowAcceptedBlueprintV2Schema = object({
  ...officialWorkflowBlueprintShape,
  runtime: object({ resultEmail: boolean() }).strict(),
  fingerprint: fingerprintSchema,
}).strict();

/** Schema v3 Blueprints carry no runtime settings or platform completion mail. */
const officialWorkflowAcceptedBlueprintV3Schema = object({
  ...officialWorkflowBlueprintShape,
  fingerprint: fingerprintSchema,
}).strict();

/** An accepted Blueprint read from either supported schema version. */
export const officialWorkflowAcceptedBlueprintSchema = union([
  officialWorkflowAcceptedBlueprintV2Schema,
  officialWorkflowAcceptedBlueprintV3Schema,
]);
export type OfficialWorkflowAcceptedBlueprint = zInfer<
  typeof officialWorkflowAcceptedBlueprintSchema
>;

const officialWorkflowDefinitionRevisionPayloadShape = {
  name: workflowNameSchema,
  revision: fingerprintSchema,
  workflow: officialWorkflowExecutableSchema,
};

const officialWorkflowDefinitionRevisionPayloadV2Schema = object({
  schemaVersion: literal(2),
  ...officialWorkflowDefinitionRevisionPayloadShape,
  blueprints: array(officialWorkflowAcceptedBlueprintV2Schema),
}).strict();

const officialWorkflowDefinitionRevisionPayloadV3Schema = object({
  schemaVersion: literal(3),
  ...officialWorkflowDefinitionRevisionPayloadShape,
  blueprints: array(officialWorkflowAcceptedBlueprintV3Schema),
}).strict();

export const officialWorkflowDefinitionRevisionPayloadSchema =
  discriminatedUnion("schemaVersion", [
    officialWorkflowDefinitionRevisionPayloadV2Schema,
    officialWorkflowDefinitionRevisionPayloadV3Schema,
  ]);
export type OfficialWorkflowDefinitionRevisionPayload = zInfer<
  typeof officialWorkflowDefinitionRevisionPayloadSchema
>;

const officialWorkflowAcceptedDefinitionShape = {
  name: workflowNameSchema,
  lifecycle: officialWorkflowLifecycleSchema,
  revision: fingerprintSchema,
  releasedBlueprintKeys: array(officialWorkflowBlueprintKeySchema),
  presentation: officialWorkflowPresentationSchema,
};

const officialWorkflowAcceptedDefinitionV2Schema = object({
  ...officialWorkflowAcceptedDefinitionShape,
  artifact: officialWorkflowArtifactReferenceSchema,
  contentBundle: zNever().optional(),
  blueprints: array(officialWorkflowAcceptedBlueprintV2Schema),
}).strict();

const officialWorkflowAcceptedDefinitionV3Schema = object({
  ...officialWorkflowAcceptedDefinitionShape,
  artifact: officialWorkflowArtifactReferenceSchema,
  contentBundle: zNever().optional(),
  blueprints: array(officialWorkflowAcceptedBlueprintV3Schema),
}).strict();

/** Delivery format is independent of the immutable v2/v3 definition payload. */
const OFFICIAL_WORKFLOW_BUNDLE_CATALOG_SCHEMA_VERSION = 4 as const;
const officialWorkflowAcceptedDefinitionV4Schema = object({
  ...officialWorkflowAcceptedDefinitionShape,
  contentBundle: contentBundleSchema,
  artifact: zNever().optional(),
  blueprints: array(officialWorkflowAcceptedBlueprintSchema),
}).strict();

export type OfficialWorkflowAcceptedDefinition =
  | zInfer<typeof officialWorkflowAcceptedDefinitionV4Schema>
  | zInfer<typeof officialWorkflowAcceptedDefinitionV2Schema>
  | zInfer<typeof officialWorkflowAcceptedDefinitionV3Schema>;

export const officialWorkflowCatalogReleasePayloadSchema = discriminatedUnion(
  "schemaVersion",
  [
    object({
      schemaVersion: literal(OFFICIAL_WORKFLOW_BUNDLE_CATALOG_SCHEMA_VERSION),
      definitions: array(officialWorkflowAcceptedDefinitionV4Schema),
    }).strict(),
    object({
      schemaVersion: literal(2),
      definitions: array(officialWorkflowAcceptedDefinitionV2Schema),
    }).strict(),
    object({
      schemaVersion: literal(3),
      definitions: array(officialWorkflowAcceptedDefinitionV3Schema),
    }).strict(),
  ],
);
export type OfficialWorkflowCatalogReleasePayload = zInfer<
  typeof officialWorkflowCatalogReleasePayloadSchema
>;

/** The accepted payload shapes the publication writer emits. */
export type OfficialWorkflowPublishedCatalogReleasePayload = Extract<
  OfficialWorkflowCatalogReleasePayload,
  {
    readonly schemaVersion: typeof OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION;
  }
>;
export type OfficialWorkflowPublishedDefinitionRevisionPayload = Extract<
  OfficialWorkflowDefinitionRevisionPayload,
  {
    readonly schemaVersion: typeof OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION;
  }
>;

export const officialWorkflowCatalogDiagnosticCodeSchema = zEnum([
  "invalid-candidate",
  "duplicate-definition-name",
  "duplicate-blueprint-key",
  "duplicate-parameter-key",
  "invalid-parameter-declaration",
  "invalid-blueprint-configuration",
  "non-canonical-value",
  "missing-released-definition",
  "unknown-retired-definition",
  "artifact-preparation-failed",
  "artifact-registration-failed",
  "activation-conflict",
]);
export type OfficialWorkflowCatalogDiagnosticCode = zInfer<
  typeof officialWorkflowCatalogDiagnosticCodeSchema
>;

export const officialWorkflowCatalogDiagnosticSchema = object({
  code: officialWorkflowCatalogDiagnosticCodeSchema,
  path: array(union([string(), number().int().nonnegative()])),
  definitionName: workflowNameSchema.optional(),
  blueprintKey: officialWorkflowBlueprintKeySchema.optional(),
}).strict();
export type OfficialWorkflowCatalogDiagnostic = zInfer<
  typeof officialWorkflowCatalogDiagnosticSchema
>;

export const officialWorkflowCatalogSyncResponseSchema = object({
  outcome: zEnum(["accepted", "unchanged", "rejected"]),
  releaseId: fingerprintSchema.nullable(),
  diagnostics: array(officialWorkflowCatalogDiagnosticSchema),
}).strict();
export type OfficialWorkflowCatalogSyncResponse = zInfer<
  typeof officialWorkflowCatalogSyncResponseSchema
>;

export const officialWorkflowAcceptedRevisionSchema = union([
  object({
    definition: officialWorkflowDefinitionRevisionPayloadSchema,
    artifact: officialWorkflowArtifactReferenceSchema,
    contentBundle: contentBundleSchema.nullable().optional(),
  }).strict(),
  object({
    definition: officialWorkflowDefinitionRevisionPayloadSchema,
    artifact: zNever().optional(),
    contentBundle: contentBundleSchema,
  }).strict(),
]);
export type OfficialWorkflowAcceptedRevision = zInfer<
  typeof officialWorkflowAcceptedRevisionSchema
>;
