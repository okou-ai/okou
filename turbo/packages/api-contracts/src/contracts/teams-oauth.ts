import { object, string, enum as zEnum, type infer as zInfer } from "zod";

import { initContract } from "./base";

import { teamsOauthCallbackContract } from "./teams-oauth-callback";

export {
  teamsOauthCallbackQuerySchema,
  type TeamsOauthCallbackQuery,
} from "./teams-oauth-callback";

const c = initContract();

const jsonErrorSchema = object({ error: string() });

export const teamsOauthConnectQuerySchema = object({
  connectState: string().optional(),
  flow: zEnum(["connect", "install"]).optional(),
  orgId: string().optional(),
  userId: string().optional(),
  prompt: string().optional(),
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
export type TeamsOauthConnectQuery = zInfer<
  typeof teamsOauthConnectQuerySchema
>;
