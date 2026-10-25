import { z } from "zod";

import { initContract } from "./base";

import { teamsOauthCallbackContract } from "./teams-oauth-callback";

export {
  teamsOauthCallbackQuerySchema,
  type TeamsOauthCallbackQuery,
} from "./teams-oauth-callback";

const c = initContract();

const jsonErrorSchema = z.object({ error: z.string() });

export const teamsOauthConnectQuerySchema = z.object({
  connectState: z.string().optional(),
  orgId: z.string().optional(),
  userId: z.string().optional(),
  prompt: z.string().optional(),
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
  callback: teamsOauthCallbackContract.callback,
});

export type TeamsOauthContract = typeof teamsOauthContract;
export type TeamsOauthConnectQuery = z.infer<
  typeof teamsOauthConnectQuerySchema
>;
