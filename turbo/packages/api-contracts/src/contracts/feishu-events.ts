import * as z from "zod";

import { initContract } from "./base";

const c = initContract();

export const feishuEventsContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/feishu/events/:installationId",
    pathParams: z.object({ installationId: z.string().uuid() }),
    body: c.type<string>(),
    responses: {
      200: z.unknown(),
      400: z.object({ error: z.string() }),
      401: z.object({ error: z.string() }),
      404: z.object({ error: z.string() }),
      503: z.object({ error: z.string() }),
    },
    summary: "Handle Feishu event callbacks",
  },
});

export type FeishuEventsContract = typeof feishuEventsContract;
