import * as z from "zod";

export const automationLoopCallbackPayloadSchema = z
  .object({
    automationId: z.string(),
  })
  .strict();

export const automationCronCallbackPayloadSchema = z
  .object({
    automationId: z.string(),
    timezone: z.string(),
    cronExpression: z.string().optional(),
  })
  .strict();

export type AutomationLoopCallbackPayload = z.infer<
  typeof automationLoopCallbackPayloadSchema
>;
export type AutomationCronCallbackPayload = z.infer<
  typeof automationCronCallbackPayloadSchema
>;
