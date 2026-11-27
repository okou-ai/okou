import {
  array,
  boolean,
  discriminatedUnion,
  lazy,
  literal,
  number,
  object,
  record,
  string,
  union,
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
} from "./official-workflow-bindings";
export type {
  OfficialWorkflowParameterValue,
  OfficialWorkflowParameterBinding,
} from "./official-workflow-bindings";

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

const officialWorkflowInstallationParameterSchema = discriminatedUnion("type", [
  officialWorkflowStringParameterSchema,
  officialWorkflowIntegerParameterSchema,
  officialWorkflowBooleanParameterSchema,
]);

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

const fingerprintSchema = string().regex(/^[0-9a-f]{64}$/);

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

export const officialWorkflowAcceptedRevisionSchema = object({
  definition: officialWorkflowDefinitionRevisionPayloadSchema,
  contentBundle: contentBundleSchema,
}).strict();
export type OfficialWorkflowAcceptedRevision = zInfer<
  typeof officialWorkflowAcceptedRevisionSchema
>;

/** The last readable definition for a historical private installation. */
export const officialWorkflowArchivedSnapshotSchema = object({
  lifecycle: officialWorkflowLifecycleSchema,
  revision: officialWorkflowAcceptedRevisionSchema,
}).strict();
export type OfficialWorkflowArchivedSnapshot = zInfer<
  typeof officialWorkflowArchivedSnapshotSchema
>;
