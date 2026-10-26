import {
  array,
  boolean,
  number,
  object,
  string,
  union,
  type infer as zInfer,
} from "zod";

export const officialWorkflowBlueprintKeySchema = string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);

export const officialWorkflowParameterKeySchema = string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

export const officialWorkflowParameterValueSchema = union([
  string(),
  number().int().safe(),
  boolean(),
]);
export type OfficialWorkflowParameterValue = zInfer<
  typeof officialWorkflowParameterValueSchema
>;

export const officialWorkflowParameterBindingSchema = object({
  key: officialWorkflowParameterKeySchema,
  value: officialWorkflowParameterValueSchema,
}).strict();
export type OfficialWorkflowParameterBinding = zInfer<
  typeof officialWorkflowParameterBindingSchema
>;

export const officialWorkflowBlueprintBindingsSchema = object({
  blueprintKey: officialWorkflowBlueprintKeySchema,
  bindings: array(officialWorkflowParameterBindingSchema),
}).strict();
export type OfficialWorkflowBlueprintBindings = zInfer<
  typeof officialWorkflowBlueprintBindingsSchema
>;
