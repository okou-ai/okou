import * as z from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const nullableStringSchema = z.string().nullable();

const teamsEnvironmentSchema = z.object({
  requiredSecrets: z.array(z.string()),
  requiredVars: z.array(z.string()),
  missingSecrets: z.array(z.string()),
  missingVars: z.array(z.string()),
});

const teamsConnectStatusSchema = z.object({
  isInstalled: z.boolean(),
  isConnected: z.boolean(),
  isAdmin: z.boolean(),
  installUrl: nullableStringSchema.optional(),
  connectUrl: nullableStringSchema.optional(),
  tenantId: nullableStringSchema.optional(),
  tenantName: nullableStringSchema.optional(),
  teamId: nullableStringSchema.optional(),
  teamName: nullableStringSchema.optional(),
  botName: nullableStringSchema.optional(),
  defaultAgentName: nullableStringSchema.optional(),
  permissionMismatch: z.boolean().optional(),
  reinstallUrl: nullableStringSchema.optional(),
  environment: teamsEnvironmentSchema.optional(),
  linkedAccounts: z.array(
    z.object({
      tenantId: z.string(),
      teamsUserId: nullableStringSchema,
      teamsAadObjectId: nullableStringSchema,
      displayName: nullableStringSchema,
      userPrincipalName: nullableStringSchema,
    }),
  ),
  pendingInstallation: z.boolean(),
});

const teamsConnectBodySchema = z
  .object({
    tenantId: z.string().min(1),
    tenantName: z.string().min(1).optional(),
    teamsUserId: z.string().min(1).optional(),
    teamsAadObjectId: z.string().min(1).optional(),
    teamsUserDisplayName: z.string().min(1).optional(),
    teamsUserPrincipalName: z.string().min(1).optional(),
    teamId: z.string().min(1).optional(),
    teamName: z.string().min(1).optional(),
    serviceUrl: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
    conversationType: z.string().min(1).optional(),
    activityId: z.string().min(1).optional(),
    channelId: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
  })
  .refine(
    (body) => {
      return Boolean(body.teamsUserId || body.teamsAadObjectId);
    },
    {
      message: "teamsUserId or teamsAadObjectId is required",
      path: ["teamsUserId"],
    },
  );

const teamsConnectResponseSchema = z.object({
  success: z.literal(true),
  connectionId: z.string(),
  role: z.enum(["admin", "member"]),
});

const teamsDisconnectResponseSchema = z.object({
  success: z.literal(true),
});

export const teamsConnectContract = c.router({
  getStatus: {
    method: "GET",
    path: "/api/integrations/teams/connect",
    headers: authHeadersSchema,
    responses: {
      200: teamsConnectStatusSchema,
      401: apiErrorSchema,
    },
    summary: "Check user Microsoft Teams connection status",
  },
  connect: {
    method: "POST",
    path: "/api/integrations/teams/connect",
    headers: authHeadersSchema,
    body: teamsConnectBodySchema,
    responses: {
      200: teamsConnectResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Connect user to Microsoft Teams installation",
  },
  disconnect: {
    method: "DELETE",
    path: "/api/integrations/teams/connect",
    headers: authHeadersSchema,
    query: z.object({
      action: z.string().optional(),
    }),
    responses: {
      200: teamsDisconnectResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect user from Microsoft Teams installation",
  },
});

export type TeamsConnectStatus = z.infer<typeof teamsConnectStatusSchema>;
export type TeamsConnectBody = z.infer<typeof teamsConnectBodySchema>;
export type TeamsConnectResponse = z.infer<typeof teamsConnectResponseSchema>;
export type TeamsDisconnectResponse = z.infer<
  typeof teamsDisconnectResponseSchema
>;
export type TeamsConnectContract = typeof teamsConnectContract;
