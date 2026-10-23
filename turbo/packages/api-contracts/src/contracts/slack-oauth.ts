import { z } from "zod";

import { initContract } from "./base";

import { slackOauthCallbackContract } from "./slack-oauth-callback";

export {
  slackOauthCallbackQuerySchema,
  type SlackOauthCallbackQuery,
} from "./slack-oauth-callback";

const c = initContract();

const jsonErrorSchema = z.object({ error: z.string() });

export const slackOauthInstallQuerySchema = z.object({
  connectorState: z.string().optional(),
  orgId: z.string().optional(),
  userId: z.string().optional(),
  reinstall: z.string().optional(),
  prompt: z.string().optional(),
});

export const slackOauthConnectQuerySchema = z.object({
  connectorState: z.string().optional(),
  orgId: z.string().optional(),
  userId: z.string().optional(),
  prompt: z.string().optional(),
});

export const slackOauthContract = c.router({
  install: {
    method: "GET",
    path: "/api/slack/oauth/install",
    query: slackOauthInstallQuerySchema,
    responses: {
      307: c.noBody(),
      503: jsonErrorSchema,
    },
    summary: "Start Slack bot OAuth install",
  },
  connect: {
    method: "GET",
    path: "/api/slack/oauth/connect",
    query: slackOauthConnectQuerySchema,
    responses: {
      307: c.noBody(),
      400: jsonErrorSchema,
      404: jsonErrorSchema,
      503: jsonErrorSchema,
    },
    summary: "Start Slack user OAuth connect",
  },
  callback: slackOauthCallbackContract.callback,
});

export type SlackOauthContract = typeof slackOauthContract;
export type SlackOauthInstallQuery = z.infer<
  typeof slackOauthInstallQuerySchema
>;
export type SlackOauthConnectQuery = z.infer<
  typeof slackOauthConnectQuerySchema
>;
