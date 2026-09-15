import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const slackConnectStatusSchema = z.object({
  isConnected: z.boolean(),
  isAdmin: z.boolean(),
  workspaceName: z.string().nullable().optional(),
  defaultAgentName: z.string().nullable().optional(),
});

/**
 * Slack connect contract (GET/POST /api/integrations/slack/connect)
 * Manages per-user Slack connection.
 */
export const slackConnectContract = c.router({
  getStatus: {
    method: "GET",
    path: "/api/integrations/slack/connect",
    headers: authHeadersSchema,
    responses: {
      200: slackConnectStatusSchema,
      401: apiErrorSchema,
    },
    summary: "Check user Slack connection status",
  },
  connect: {
    method: "POST",
    path: "/api/integrations/slack/connect",
    headers: authHeadersSchema,
    body: z.object({
      workspaceId: z.string().min(1),
      slackUserId: z.string().min(1),
      channelId: z.string().optional(),
      threadTs: z.string().optional(),
      requestUserScopes: z.literal(true),
    }),
    responses: {
      202: z.object({ authorizationUrl: z.string().url() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Connect user to Slack workspace",
  },
});

export type SlackConnectContract = typeof slackConnectContract;
