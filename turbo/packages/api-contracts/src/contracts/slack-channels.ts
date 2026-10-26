import { array, object, string, type infer as zInfer } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const slackChannelSchema = object({
  id: string(),
  name: string(),
});

/**
 * Slack channels contract (GET /api/slack/channels)
 * Lists Slack channels shared by the connected user and bot.
 */
export const slackChannelsContract = c.router({
  list: {
    method: "GET",
    path: "/api/slack/channels",
    headers: authHeadersSchema,
    responses: {
      200: object({ channels: array(slackChannelSchema) }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List Slack channels shared by connected user and bot",
  },
});

export type SlackChannelsContract = typeof slackChannelsContract;
export type SlackChannel = zInfer<typeof slackChannelSchema>;
export { slackChannelSchema };
