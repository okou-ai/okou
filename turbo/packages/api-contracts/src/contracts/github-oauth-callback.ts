import { z } from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  integrationOAuthCallbackQuerySchema,
  integrationOAuthCallbackResponses,
} from "./integration-oauth-callback";

const c = initContract();

export const githubAppSetupCallbackQuerySchema =
  integrationOAuthCallbackQuerySchema.extend({
    error_description: z.string().optional(),
    installation_id: z.string().optional(),
    setup_action: z.string().optional(),
    target_id: z.string().optional(),
    target_type: z.string().optional(),
  });

export const githubAppSetupCallbackContract = c.router({
  callback: {
    method: "GET",
    path: "/api/github/app/setup/callback",
    query: githubAppSetupCallbackQuerySchema,
    responses: {
      200: integrationOAuthCallbackResponses[200],
      307: integrationOAuthCallbackResponses[307],
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Handle GitHub App setup callback",
  },
});

export type GithubAppSetupCallbackQuery = z.infer<
  typeof githubAppSetupCallbackQuerySchema
>;
