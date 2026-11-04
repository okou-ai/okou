import { object, string, uuid, unknown as zUnknown } from "zod";

import { initContract } from "./base";

const c = initContract();

export const feishuEventsContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/feishu/events/:installationId",
    pathParams: object({ installationId: uuid() }),
    body: c.type<string>(),
    responses: {
      200: zUnknown(),
      400: object({ error: string() }),
      401: object({ error: string() }),
      404: object({ error: string() }),
      503: object({ error: string() }),
    },
    summary: "Handle Feishu event callbacks",
  },
});

export type FeishuEventsContract = typeof feishuEventsContract;
