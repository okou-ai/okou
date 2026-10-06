import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testChatEventRetentionContract = c.router({
  sessionPrompt: {
    method: "POST",
    path: "/api/test/chat-event-session-prompt",
    body: z.object({
      chat_thread_id: z.uuid(),
    }),
    responses: {
      200: z.object({ prompt: z.string() }),
      404: z.string(),
    },
    summary: "Resolve a rotated web chat session prompt for test fixtures",
  },
});

export type TestChatEventRetentionContract =
  typeof testChatEventRetentionContract;
