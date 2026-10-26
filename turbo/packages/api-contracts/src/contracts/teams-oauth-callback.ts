import { string, type infer as zInfer } from "zod";

import { initContract } from "./base";
import {
  integrationOAuthCallbackQuerySchema,
  integrationOAuthCallbackResponses,
} from "./integration-oauth-callback";

const c = initContract();

export const teamsOauthCallbackQuerySchema =
  integrationOAuthCallbackQuerySchema.extend({
    error_description: string().optional(),
  });

export const teamsOauthCallbackContract = c.router({
  callback: {
    method: "GET",
    path: "/api/integrations/teams/oauth/callback",
    query: teamsOauthCallbackQuerySchema,
    responses: integrationOAuthCallbackResponses,
    summary: "Handle Microsoft Teams OAuth callback",
  },
});

export type TeamsOauthCallbackQuery = zInfer<
  typeof teamsOauthCallbackQuerySchema
>;
