import * as z from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const slackChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
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
      200: z.object({ channels: z.array(slackChannelSchema) }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List Slack channels shared by connected user and bot",
  },
});

export type SlackChannelsContract = typeof slackChannelsContract;
export type SlackChannel = z.infer<typeof slackChannelSchema>;
export { slackChannelSchema };
