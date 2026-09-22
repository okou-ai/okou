import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const slackConnectLinkStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("connect") }),
  z.object({ kind: z.literal("connected") }),
  z.object({ kind: z.literal("slack_account_in_use") }),
  z.object({
    kind: z.literal("workspace_mismatch"),
    currentWorkspaceName: z.string().nullable().optional(),
  }),
  z.object({
    kind: z.literal("slack_account_mismatch"),
    currentSlackUserId: z.string().min(1),
    requestedSlackUserId: z.string().min(1),
  }),
]);

const slackConnectStatusSchema = z.object({
  isConnected: z.boolean(),
  isAdmin: z.boolean(),
  workspaceName: z.string().nullable().optional(),
  defaultAgentName: z.string().nullable().optional(),
});

const slackConnectLinkStatusResponseSchema = slackConnectStatusSchema.extend({
  linkStatus: slackConnectLinkStatusSchema,
});

const slackConnectOAuthBodySchema = z.object({
  workspaceId: z.string().min(1),
  slackUserId: z.string().min(1),
  channelId: z.string().optional(),
  threadTs: z.string().optional(),
  requestUserScopes: z.literal(true),
});

/**
 * Slack connect contract for per-user status and OAuth starts.
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
  getLinkStatus: {
    method: "GET",
    path: "/api/integrations/slack/connect/link-status",
    headers: authHeadersSchema,
    query: z.object({
      workspaceId: z.string().min(1),
      slackUserId: z.string().min(1),
    }),
    responses: {
      200: slackConnectLinkStatusResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Check the status of a Slack connection link",
  },
  connect: {
    method: "POST",
    path: "/api/integrations/slack/connect",
    headers: authHeadersSchema,
    body: slackConnectOAuthBodySchema,
    responses: {
      202: z.object({ authorizationUrl: z.string().url() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Connect user to Slack workspace",
  },
  switchAccount: {
    method: "POST",
    path: "/api/integrations/slack/connect/switch",
    headers: authHeadersSchema,
    body: slackConnectOAuthBodySchema,
    responses: {
      202: z.object({ authorizationUrl: z.string().url() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Switch the user's Slack account for a workspace",
  },
});

export type SlackConnectContract = typeof slackConnectContract;
export type SlackConnectLinkStatus = z.infer<
  typeof slackConnectLinkStatusSchema
>;
