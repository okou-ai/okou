import { object, string, unknown as zUnknown } from "zod";

import { initContract } from "./base";

const c = initContract();

export const slackInteractiveContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/slack/interactive",
    body: c.type<string>(),
    responses: {
      200: zUnknown(),
      400: object({ error: string() }),
      401: object({ error: string() }),
      503: object({ error: string() }),
    },
    summary: "Handle Okou Slack interactive component callbacks",
  },
});

export type SlackInteractiveContract = typeof slackInteractiveContract;
