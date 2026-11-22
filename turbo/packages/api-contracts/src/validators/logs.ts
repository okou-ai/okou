import { object, string, uuid, enum as zEnum, type infer as zInfer } from "zod";
import { knownRunFailureReasonSchema } from "../contracts/run-failure-reasons";

/**
 * Trigger source enum — how the run was initiated
 */
export const triggerSourceSchema = zEnum([
  "web",
  "slack",
  "discord",
  "wechat",
  "teams",
  "feishu",
  "lark",
  "email",
  "telegram",
  "agentphone",
  "github",
  "test",
  "agent",
  "webhook",
  "automation-schedule",
  "automation-event",
]);

export const logStatusSchema = zEnum([
  "queued",
  "pending",
  "running",
  "completed",
  "failed",
  "timeout",
  "cancelled",
]);

/** The Activity reader's current facts; unknown response fields are ignored. */
export const activityDetailSchema = object({
  id: uuid(),
  sessionId: string().nullable(),
  framework: string().nullable(),
  modelProvider: string().nullable(),
  selectedModel: string().nullable(),
  modelRuntimeProvider: string().nullable().optional(),
  modelRuntimeModel: string().nullable().optional(),
  triggerSource: triggerSourceSchema.nullable(),
  status: logStatusSchema,
  prompt: string(),
  appendSystemPrompt: string().nullable(),
  failureReason: knownRunFailureReasonSchema.optional(),
  createdAt: string(),
  startedAt: string().nullable(),
  completedAt: string().nullable(),
});

export type ActivityDetail = zInfer<typeof activityDetailSchema>;
