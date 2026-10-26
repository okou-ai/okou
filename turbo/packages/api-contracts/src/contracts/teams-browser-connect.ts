import { object, string, type infer as zInfer } from "zod";

import { initContract } from "./base";

const c = initContract();

export const teamsBrowserConnectQuerySchema = object({
  tenantId: string().optional(),
  tenantName: string().optional(),
  teamsUserId: string().optional(),
  teamsAadObjectId: string().optional(),
  teamsUserDisplayName: string().optional(),
  teamsUserPrincipalName: string().optional(),
  displayName: string().optional(),
  upn: string().optional(),
  teamId: string().optional(),
  teamName: string().optional(),
  botName: string().optional(),
  serviceUrl: string().optional(),
  conversationId: string().optional(),
  conversationType: string().optional(),
  activityId: string().optional(),
  channelId: string().optional(),
  threadId: string().optional(),
  orgId: string().optional(),
});

export const teamsBrowserConnectContract = c.router({
  connect: {
    method: "GET",
    path: "/api/teams/connect",
    query: teamsBrowserConnectQuerySchema,
    responses: {
      307: c.noBody(),
      500: object({ error: string() }),
    },
    summary: "Browser Microsoft Teams connect flow",
  },
});

export type TeamsBrowserConnectContract = typeof teamsBrowserConnectContract;
export type TeamsBrowserConnectQuery = zInfer<
  typeof teamsBrowserConnectQuerySchema
>;
