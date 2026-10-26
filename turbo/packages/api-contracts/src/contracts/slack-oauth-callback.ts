import type { infer as zInfer } from "zod";

import { initContract } from "./base";
import {
  integrationOAuthCallbackQuerySchema,
  integrationOAuthCallbackResponses,
} from "./integration-oauth-callback";

const c = initContract();

export const slackOauthCallbackQuerySchema =
  integrationOAuthCallbackQuerySchema;

export const slackOauthCallbackContract = c.router({
  callback: {
    method: "GET",
    path: "/api/integrations/slack/oauth/callback",
    query: slackOauthCallbackQuerySchema,
    responses: integrationOAuthCallbackResponses,
    summary: "Handle Slack OAuth callback",
  },
});

export type SlackOauthCallbackQuery = zInfer<
  typeof slackOauthCallbackQuerySchema
>;
