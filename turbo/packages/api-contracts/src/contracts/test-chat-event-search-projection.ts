import { z } from "zod";

import { initContract } from "./base";
import { cronProjectChatEventSearchResponseSchema } from "./cron";

const c = initContract();

export const testChatEventSearchProjectionBodySchema = z.object({
  chat_thread_ids: z.array(z.uuid()).min(1).max(20),
});

export const testChatEventSearchProjectionContract = c.router({
  project: {
    method: "POST",
    path: "/api/test/project-chat-event-search",
    body: testChatEventSearchProjectionBodySchema,
    responses: {
      200: cronProjectChatEventSearchResponseSchema,
      404: z.string(),
    },
    summary: "Project explicit chat search test fixtures",
  },
});

export type TestChatEventSearchProjectionBody = z.infer<
  typeof testChatEventSearchProjectionBodySchema
>;
export type TestChatEventSearchProjectionContract =
  typeof testChatEventSearchProjectionContract;
