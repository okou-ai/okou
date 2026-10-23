import * as z from "zod";

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

export const officialWorkflowLifecycleSchema = z.enum(["active", "retired"]);
export type OfficialWorkflowLifecycle = z.infer<
  typeof officialWorkflowLifecycleSchema
>;

const officialWorkflowParameterBaseShape = {
  key: officialWorkflowParameterKeySchema,
  required: z.boolean(),
};

const officialWorkflowStringParameterSchema = z
  .object({
    ...officialWorkflowParameterBaseShape,
    type: z.literal("string"),
    format: z
      .enum(["text", "uuid", "timezone", "date-time", "url"])
      .default("text"),
    default: z.string().optional(),
  })
  .strict();

const officialWorkflowIntegerParameterSchema = z
  .object({
    ...officialWorkflowParameterBaseShape,
    type: z.literal("integer"),
    default: z.number().int().safe().optional(),
  })
  .strict();

const officialWorkflowBooleanParameterSchema = z
  .object({
    ...officialWorkflowParameterBaseShape,
    type: z.literal("boolean"),
    default: z.boolean().optional(),
  })
  .strict();

export const officialWorkflowInstallationParameterSchema = z.discriminatedUnion(
  "type",
  [
    officialWorkflowStringParameterSchema,
    officialWorkflowIntegerParameterSchema,
    officialWorkflowBooleanParameterSchema,
  ],
);
export type OfficialWorkflowInstallationParameter = z.infer<
  typeof officialWorkflowInstallationParameterSchema
>;

export const officialWorkflowParameterReferenceSchema = z
  .object({ parameter: officialWorkflowParameterKeySchema })
  .strict();
export type OfficialWorkflowParameterReference = z.infer<
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

export const officialWorkflowTemplateJsonValueSchema: z.ZodType<OfficialWorkflowTemplateJsonValue> =
  z.lazy(() => {
    return z.union([
      z.null(),
      z.boolean(),
      z.number().safe(),
      z.string(),
      officialWorkflowParameterReferenceSchema,
      z.array(officialWorkflowTemplateJsonValueSchema),
      z.record(z.string(), officialWorkflowTemplateJsonValueSchema),
    ]);
  });

const templatedStringSchema = z.union([
  z.string(),
  officialWorkflowParameterReferenceSchema,
]);
const templatedIntegerSchema = z.union([
  z.number().int().safe(),
  officialWorkflowParameterReferenceSchema,
]);

export const officialWorkflowScheduleTemplateSchema = z.discriminatedUnion(
  "type",
  [
    z
      .object({
        type: z.literal("cron"),
        cronExpression: templatedStringSchema,
        timezone: templatedStringSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("loop"),
        intervalSeconds: templatedIntegerSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("once"),
        atTime: templatedStringSchema,
        timezone: templatedStringSchema.optional(),
      })
      .strict(),
  ],
);

const officialWorkflowScheduleDesiredStateSchema = z
  .object({
    kind: z.literal("schedule"),
    schedule: officialWorkflowScheduleTemplateSchema,
    autonomyBudget: templatedIntegerSchema.optional(),
  })
  .strict();

const officialWorkflowEventDesiredStateSchema = z
  .object({
    kind: z.literal("event"),
    eventType: automationEventTypeSchema,
    eventConfig: officialWorkflowTemplateJsonValueSchema.optional(),
    autonomyBudget: templatedIntegerSchema.optional(),
  })
  .strict();

export const officialWorkflowBlueprintDesiredStateSchema = z.discriminatedUnion(
  "kind",
  [
    officialWorkflowScheduleDesiredStateSchema,
    officialWorkflowEventDesiredStateSchema,
  ],
);
export type OfficialWorkflowBlueprintDesiredState = z.infer<
  typeof officialWorkflowBlueprintDesiredStateSchema
>;

const officialWorkflowBlueprintShape = {
  key: officialWorkflowBlueprintKeySchema,
  parameters: z.array(officialWorkflowInstallationParameterSchema),
  desiredState: officialWorkflowBlueprintDesiredStateSchema,
};

/** Source Blueprint: schema v3 carries no runtime settings. */
export const officialWorkflowBlueprintSchema = z
  .object(officialWorkflowBlueprintShape)
  .strict();
export type OfficialWorkflowBlueprint = z.infer<
  typeof officialWorkflowBlueprintSchema
>;

export const officialWorkflowFileSchema = z
  .object({
    path: z.string().min(1).max(256),
    content: z.string(),
  })
  .strict();

export const officialWorkflowExecutableSchema = z
  .object({
    displayName: z.string().min(1).max(256),
    description: z.string().min(1).max(1024),
    instruction: z.string().max(5 * 1024 * 1024),
    files: z.array(officialWorkflowFileSchema).max(500),
  })
  .strict();
export type OfficialWorkflowExecutable = z.infer<
  typeof officialWorkflowExecutableSchema
>;

export const officialWorkflowPresentationSchema = z
  .object({
    category: z.string().min(1).max(64).optional(),
    coverImageUrl: z.url().optional(),
    order: z.number().int().safe().optional(),
    marketingCopy: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type OfficialWorkflowPresentation = z.infer<
  typeof officialWorkflowPresentationSchema
>;

const activeOfficialWorkflowSourceDefinitionSchema = z
  .object({
    name: workflowNameSchema,
    lifecycle: z.literal("active"),
    workflow: officialWorkflowExecutableSchema,
    blueprints: z.array(officialWorkflowBlueprintSchema),
    presentation: officialWorkflowPresentationSchema,
  })
  .strict();

const retiredOfficialWorkflowSourceDefinitionSchema = z
  .object({
    name: workflowNameSchema,
    lifecycle: z.literal("retired"),
    presentation: officialWorkflowPresentationSchema,
  })
  .strict();

export const officialWorkflowSourceDefinitionSchema = z.discriminatedUnion(
  "lifecycle",
  [
    activeOfficialWorkflowSourceDefinitionSchema,
    retiredOfficialWorkflowSourceDefinitionSchema,
  ],
);
export type OfficialWorkflowSourceDefinition = z.infer<
  typeof officialWorkflowSourceDefinitionSchema
>;

export const officialWorkflowSourceCatalogSchema = z
  .object({
    schemaVersion: z.literal(
      OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
    ),
    definitions: z.array(officialWorkflowSourceDefinitionSchema),
  })
  .strict();
export type OfficialWorkflowSourceCatalog = z.infer<
  typeof officialWorkflowSourceCatalogSchema
>;

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const officialWorkflowArtifactReferenceSchema = z
  .object({
    storageName: z.string().min(1).max(256),
    storageId: z.string().uuid(),
    storageVersion: fingerprintSchema,
  })
  .strict();
export type OfficialWorkflowArtifactReference = z.infer<
  typeof officialWorkflowArtifactReferenceSchema
>;

// Accepted catalog and revision payloads are immutable once persisted. Each
// supported schema version keeps its original required fields; a payload is
// parsed only by the schema its own `schemaVersion` names.

// Schema v2 required the retired completion-email runtime setting. It is
// decoded only to read immutable v2 identities; no consumer acts on it.
const officialWorkflowAcceptedBlueprintV2Schema = z
  .object({
    ...officialWorkflowBlueprintShape,
    runtime: z.object({ resultEmail: z.boolean() }).strict(),
    fingerprint: fingerprintSchema,
  })
  .strict();

/** Schema v3 Blueprints carry no runtime settings or platform completion mail. */
const officialWorkflowAcceptedBlueprintV3Schema = z
  .object({ ...officialWorkflowBlueprintShape, fingerprint: fingerprintSchema })
  .strict();

/** An accepted Blueprint read from either supported schema version. */
export const officialWorkflowAcceptedBlueprintSchema = z.union([
  officialWorkflowAcceptedBlueprintV2Schema,
  officialWorkflowAcceptedBlueprintV3Schema,
]);
export type OfficialWorkflowAcceptedBlueprint = z.infer<
  typeof officialWorkflowAcceptedBlueprintSchema
>;

const officialWorkflowDefinitionRevisionPayloadShape = {
  name: workflowNameSchema,
  revision: fingerprintSchema,
  workflow: officialWorkflowExecutableSchema,
};

const officialWorkflowDefinitionRevisionPayloadV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    ...officialWorkflowDefinitionRevisionPayloadShape,
    blueprints: z.array(officialWorkflowAcceptedBlueprintV2Schema),
  })
  .strict();

const officialWorkflowDefinitionRevisionPayloadV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    ...officialWorkflowDefinitionRevisionPayloadShape,
    blueprints: z.array(officialWorkflowAcceptedBlueprintV3Schema),
  })
  .strict();

export const officialWorkflowDefinitionRevisionPayloadSchema =
  z.discriminatedUnion("schemaVersion", [
    officialWorkflowDefinitionRevisionPayloadV2Schema,
    officialWorkflowDefinitionRevisionPayloadV3Schema,
  ]);
export type OfficialWorkflowDefinitionRevisionPayload = z.infer<
  typeof officialWorkflowDefinitionRevisionPayloadSchema
>;

const officialWorkflowAcceptedDefinitionShape = {
  name: workflowNameSchema,
  lifecycle: officialWorkflowLifecycleSchema,
  revision: fingerprintSchema,
  artifact: officialWorkflowArtifactReferenceSchema,
  releasedBlueprintKeys: z.array(officialWorkflowBlueprintKeySchema),
  presentation: officialWorkflowPresentationSchema,
};

const officialWorkflowAcceptedDefinitionV2Schema = z
  .object({
    ...officialWorkflowAcceptedDefinitionShape,
    blueprints: z.array(officialWorkflowAcceptedBlueprintV2Schema),
  })
  .strict();

const officialWorkflowAcceptedDefinitionV3Schema = z
  .object({
    ...officialWorkflowAcceptedDefinitionShape,
    blueprints: z.array(officialWorkflowAcceptedBlueprintV3Schema),
  })
  .strict();

export type OfficialWorkflowAcceptedDefinition =
  | z.infer<typeof officialWorkflowAcceptedDefinitionV2Schema>
  | z.infer<typeof officialWorkflowAcceptedDefinitionV3Schema>;

export const officialWorkflowCatalogReleasePayloadSchema = z.discriminatedUnion(
  "schemaVersion",
  [
    z
      .object({
        schemaVersion: z.literal(2),
        definitions: z.array(officialWorkflowAcceptedDefinitionV2Schema),
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(3),
        definitions: z.array(officialWorkflowAcceptedDefinitionV3Schema),
      })
      .strict(),
  ],
);
export type OfficialWorkflowCatalogReleasePayload = z.infer<
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

export const officialWorkflowCatalogDiagnosticCodeSchema = z.enum([
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
export type OfficialWorkflowCatalogDiagnosticCode = z.infer<
  typeof officialWorkflowCatalogDiagnosticCodeSchema
>;

export const officialWorkflowCatalogDiagnosticSchema = z
  .object({
    code: officialWorkflowCatalogDiagnosticCodeSchema,
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
    definitionName: workflowNameSchema.optional(),
    blueprintKey: officialWorkflowBlueprintKeySchema.optional(),
  })
  .strict();
export type OfficialWorkflowCatalogDiagnostic = z.infer<
  typeof officialWorkflowCatalogDiagnosticSchema
>;

export const officialWorkflowCatalogSyncResponseSchema = z
  .object({
    outcome: z.enum(["accepted", "unchanged", "rejected"]),
    releaseId: fingerprintSchema.nullable(),
    diagnostics: z.array(officialWorkflowCatalogDiagnosticSchema),
  })
  .strict();
export type OfficialWorkflowCatalogSyncResponse = z.infer<
  typeof officialWorkflowCatalogSyncResponseSchema
>;

export const officialWorkflowAcceptedRevisionSchema = z
  .object({
    definition: officialWorkflowDefinitionRevisionPayloadSchema,
    artifact: officialWorkflowArtifactReferenceSchema,
  })
  .strict();
export type OfficialWorkflowAcceptedRevision = z.infer<
  typeof officialWorkflowAcceptedRevisionSchema
>;
