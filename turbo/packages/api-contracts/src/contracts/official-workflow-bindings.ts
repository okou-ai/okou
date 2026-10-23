import * as z from "zod";

export const officialWorkflowBlueprintKeySchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);

export const officialWorkflowParameterKeySchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

export const officialWorkflowParameterValueSchema = z.union([
  z.string(),
  z.number().int().safe(),
  z.boolean(),
]);
export type OfficialWorkflowParameterValue = z.infer<
  typeof officialWorkflowParameterValueSchema
>;

export const officialWorkflowParameterBindingSchema = z
  .object({
    key: officialWorkflowParameterKeySchema,
    value: officialWorkflowParameterValueSchema,
  })
  .strict();
export type OfficialWorkflowParameterBinding = z.infer<
  typeof officialWorkflowParameterBindingSchema
>;

export const officialWorkflowBlueprintBindingsSchema = z
  .object({
    blueprintKey: officialWorkflowBlueprintKeySchema,
    bindings: z.array(officialWorkflowParameterBindingSchema),
  })
  .strict();
export type OfficialWorkflowBlueprintBindings = z.infer<
  typeof officialWorkflowBlueprintBindingsSchema
>;
