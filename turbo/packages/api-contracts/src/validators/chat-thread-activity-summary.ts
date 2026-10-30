import { array, object, string, enum as zEnum } from "zod";

export const thinkingMessageSchema = object({
  id: string().min(1),
  text: string().min(1),
});

export const activitySummaryResponseSchema = object({
  runId: string().uuid(),
  messages: array(thinkingMessageSchema).max(4),
  status: zEnum(["available", "ineligible", "unavailable"]),
});
