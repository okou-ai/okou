import { object, string, type infer as zInfer } from "zod";

export const automationLoopCallbackPayloadSchema = object({
  automationId: string(),
}).strict();

export const automationCronCallbackPayloadSchema = object({
  automationId: string(),
  timezone: string(),
  cronExpression: string().optional(),
}).strict();

export type AutomationLoopCallbackPayload = zInfer<
  typeof automationLoopCallbackPayloadSchema
>;
export type AutomationCronCallbackPayload = zInfer<
  typeof automationCronCallbackPayloadSchema
>;
