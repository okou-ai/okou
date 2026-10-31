import { object, uuid, type infer as zInfer } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  thinkingMessageSchema,
  activitySummaryResponseSchema,
} from "../validators/chat-thread-activity-summary";

export {
  thinkingMessageSchema,
  activitySummaryResponseSchema,
} from "../validators/chat-thread-activity-summary";

export type ThinkingMessage = zInfer<typeof thinkingMessageSchema>;

export type ActivitySummaryResponse = zInfer<
  typeof activitySummaryResponseSchema
>;

const c = initContract();
export const chatThreadActivitySummaryContract = c.router({
  summarize: {
    method: "POST",
    path: "/api/chat-threads/:id/activity-summary",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    body: object({ runId: uuid() }).strict(),
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
