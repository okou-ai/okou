import * as z from "zod";

import { initContract } from "./base";

const c = initContract();

export const slackEventsContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/slack/events",
    body: c.type<string>(),
    responses: {
      200: z.unknown(),
      400: z.object({ error: z.string() }),
      401: z.object({ error: z.string() }),
      503: z.object({ error: z.string() }),
    },
    summary: "Handle Okou Slack Events API callbacks",
  },
});

export type SlackEventsContract = typeof slackEventsContract;
