import {
  array,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const thinkingMessageSchema = object({
  id: string().min(1),
  text: string().min(1),
});
export type ThinkingMessage = zInfer<typeof thinkingMessageSchema>;

export const activitySummaryResponseSchema = object({
  runId: string().uuid(),
  messages: array(thinkingMessageSchema).max(4),
  status: zEnum(["available", "ineligible", "unavailable"]),
});
export type ActivitySummaryResponse = zInfer<
  typeof activitySummaryResponseSchema
>;

const c = initContract();
export const chatThreadActivitySummaryContract = c.router({
  summarize: {
    method: "POST",
    path: "/api/chat-threads/:id/activity-summary",
    headers: authHeadersSchema,
    pathParams: object({ id: string().uuid() }),
    body: object({ runId: string().uuid() }).strict(),
    responses: {
      200: activitySummaryResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Summarize current public run activity on demand",
  },
});
