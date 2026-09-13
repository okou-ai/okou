import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const welcomeChatThreadsContract = c.router({
  create: {
    method: "POST",
    path: "/api/welcome-chat-threads",
    headers: authHeadersSchema,
    body: z.object({ clientThreadId: z.uuid() }).strict(),
    responses: {
      201: z.object({ id: z.uuid() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create one welcome thread",
  },
});
