import * as z from "zod";

import { initContract } from "./base";

const c = initContract();

export const teamsBrowserConnectQuerySchema = z.object({
  tenantId: z.string().optional(),
  tenantName: z.string().optional(),
  teamsUserId: z.string().optional(),
  teamsAadObjectId: z.string().optional(),
  teamsUserDisplayName: z.string().optional(),
  teamsUserPrincipalName: z.string().optional(),
  displayName: z.string().optional(),
  upn: z.string().optional(),
  teamId: z.string().optional(),
  teamName: z.string().optional(),
  botName: z.string().optional(),
  serviceUrl: z.string().optional(),
  conversationId: z.string().optional(),
  conversationType: z.string().optional(),
  activityId: z.string().optional(),
  channelId: z.string().optional(),
  threadId: z.string().optional(),
  orgId: z.string().optional(),
});

export const teamsBrowserConnectContract = c.router({
  connect: {
    method: "GET",
    path: "/api/teams/connect",
    query: teamsBrowserConnectQuerySchema,
    responses: {
      307: c.noBody(),
      500: z.object({ error: z.string() }),
    },
    summary: "Browser Microsoft Teams connect flow",
  },
});

export type TeamsBrowserConnectContract = typeof teamsBrowserConnectContract;
export type TeamsBrowserConnectQuery = z.infer<
  typeof teamsBrowserConnectQuerySchema
>;
