import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const thinkingMessageSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});
export type ThinkingMessage = z.infer<typeof thinkingMessageSchema>;

export const activitySummaryResponseSchema = z.object({
  runId: z.string().uuid(),
  messages: z.array(thinkingMessageSchema).max(4),
  status: z.enum(["available", "ineligible", "unavailable"]),
});
export type ActivitySummaryResponse = z.infer<
  typeof activitySummaryResponseSchema
>;

const c = initContract();
export const chatThreadActivitySummaryContract = c.router({
  summarize: {
    method: "POST",
    path: "/api/chat-threads/:id/activity-summary",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: z.object({ runId: z.string().uuid() }).strict(),
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
