import {
  boolean,
  discriminatedUnion,
  literal,
  object,
  string,
  url,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const slackConnectLinkStatusSchema = discriminatedUnion("kind", [
  object({ kind: literal("connect") }),
  object({ kind: literal("connected") }),
  object({ kind: literal("slack_account_in_use") }),
  object({
    kind: literal("workspace_mismatch"),
    currentWorkspaceName: string().nullable().optional(),
  }),
  object({
    kind: literal("slack_account_mismatch"),
    currentSlackUserId: string().min(1),
    requestedSlackUserId: string().min(1),
  }),
]);

const slackConnectStatusSchema = object({
  isConnected: boolean(),
  isAdmin: boolean(),
  workspaceName: string().nullable().optional(),
  defaultAgentName: string().nullable().optional(),
});

const slackConnectLinkStatusResponseSchema = slackConnectStatusSchema.extend({
  linkStatus: slackConnectLinkStatusSchema,
});

const slackConnectOAuthBodySchema = object({
  workspaceId: string().min(1),
  slackUserId: string().min(1),
  channelId: string().optional(),
  threadTs: string().optional(),
  requestUserScopes: literal(true),
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
    query: object({
      workspaceId: string().min(1),
      slackUserId: string().min(1),
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
      202: object({ authorizationUrl: url() }),
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
      202: object({ authorizationUrl: url() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Switch the user's Slack account for a workspace",
  },
});

export type SlackConnectContract = typeof slackConnectContract;
export type SlackConnectLinkStatus = zInfer<
  typeof slackConnectLinkStatusSchema
>;
