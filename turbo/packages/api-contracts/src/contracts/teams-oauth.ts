import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const jsonErrorSchema = z.object({ error: z.string() });

export const teamsOauthConnectQuerySchema = z.object({
  orgId: z.string().optional(),
  userId: z.string().optional(),
  prompt: z.string().optional(),
});

export const teamsOauthCallbackQuerySchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
  state: z.string().optional(),
});

export const teamsOauthContract = c.router({
  connect: {
    method: "GET",
    path: "/api/teams/oauth/connect",
    query: teamsOauthConnectQuerySchema,
    responses: {
      307: c.noBody(),
      400: jsonErrorSchema,
      503: jsonErrorSchema,
    },
    summary: "Start Microsoft Teams user OAuth connect",
  },
  callback: {
    method: "GET",
    path: "/api/integrations/teams/oauth/callback",
    query: teamsOauthCallbackQuerySchema,
    responses: {
      307: c.noBody(),
      400: jsonErrorSchema,
      503: jsonErrorSchema,
    },
    summary: "Handle Microsoft Teams OAuth callback",
  },
});

export type TeamsOauthContract = typeof teamsOauthContract;
export type TeamsOauthConnectQuery = z.infer<
  typeof teamsOauthConnectQuerySchema
>;
export type TeamsOauthCallbackQuery = z.infer<
  typeof teamsOauthCallbackQuerySchema
>;
