import { z } from "zod";

import { initContract } from "./base";

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

export const slackOauthCallbackQuerySchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  state: z.string().optional(),
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
  callback: {
    method: "GET",
    path: "/api/integrations/slack/oauth/callback",
    query: slackOauthCallbackQuerySchema,
    responses: {
      307: c.noBody(),
      400: jsonErrorSchema,
      503: jsonErrorSchema,
    },
    summary: "Handle Slack OAuth callback",
  },
});

export type SlackOauthContract = typeof slackOauthContract;
export type SlackOauthInstallQuery = z.infer<
  typeof slackOauthInstallQuerySchema
>;
export type SlackOauthConnectQuery = z.infer<
  typeof slackOauthConnectQuerySchema
>;
export type SlackOauthCallbackQuery = z.infer<
  typeof slackOauthCallbackQuerySchema
>;
