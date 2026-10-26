import { object, string, unknown as zUnknown } from "zod";

import { initContract } from "./base";

const c = initContract();

export const slackCommandsContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/slack/commands",
    body: c.type<string>(),
    responses: {
      200: zUnknown(),
      400: object({ error: string() }),
      401: object({ error: string() }),
      503: object({ error: string() }),
    },
    summary: "Handle Okou Slack slash commands",
  },
});

export type SlackCommandsContract = typeof slackCommandsContract;
