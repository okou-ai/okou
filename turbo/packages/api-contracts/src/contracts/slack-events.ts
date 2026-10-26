import { object, string, unknown as zUnknown } from "zod";

import { initContract } from "./base";

const c = initContract();

export const slackEventsContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/slack/events",
    body: c.type<string>(),
    responses: {
      200: zUnknown(),
      400: object({ error: string() }),
      401: object({ error: string() }),
      503: object({ error: string() }),
    },
    summary: "Handle Okou Slack Events API callbacks",
  },
});

export type SlackEventsContract = typeof slackEventsContract;
