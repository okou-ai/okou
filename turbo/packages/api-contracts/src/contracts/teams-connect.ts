import {
  array,
  boolean,
  literal,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const nullableStringSchema = string().nullable();

const teamsEnvironmentSchema = object({
  requiredSecrets: array(string()),
  requiredVars: array(string()),
  missingSecrets: array(string()),
  missingVars: array(string()),
});

const teamsConnectStatusSchema = object({
  isInstalled: boolean(),
  isConnected: boolean(),
  isAdmin: boolean(),
  installUrl: nullableStringSchema.optional(),
  connectUrl: nullableStringSchema.optional(),
  tenantId: nullableStringSchema.optional(),
  tenantName: nullableStringSchema.optional(),
  teamId: nullableStringSchema.optional(),
  teamName: nullableStringSchema.optional(),
  botName: nullableStringSchema.optional(),
  defaultAgentName: nullableStringSchema.optional(),
  permissionMismatch: boolean().optional(),
  reinstallUrl: nullableStringSchema.optional(),
  environment: teamsEnvironmentSchema.optional(),
  linkedAccounts: array(
    object({
      tenantId: string(),
      teamsUserId: nullableStringSchema,
      teamsAadObjectId: nullableStringSchema,
      displayName: nullableStringSchema,
      userPrincipalName: nullableStringSchema,
    }),
  ),
  pendingInstallation: boolean(),
});

const teamsConnectBodySchema = object({
  tenantId: string().min(1),
  tenantName: string().min(1).optional(),
  teamsUserId: string().min(1).optional(),
  teamsAadObjectId: string().min(1).optional(),
  teamsUserDisplayName: string().min(1).optional(),
  teamsUserPrincipalName: string().min(1).optional(),
  teamId: string().min(1).optional(),
  teamName: string().min(1).optional(),
  serviceUrl: string().min(1).optional(),
  conversationId: string().min(1).optional(),
  conversationType: string().min(1).optional(),
  activityId: string().min(1).optional(),
  channelId: string().min(1).optional(),
  threadId: string().min(1).optional(),
}).refine(
  (body) => {
    return Boolean(body.teamsUserId || body.teamsAadObjectId);
  },
  {
    message: "teamsUserId or teamsAadObjectId is required",
    path: ["teamsUserId"],
  },
);

const teamsConnectResponseSchema = object({
  success: literal(true),
  connectionId: string(),
  role: zEnum(["admin", "member"]),
});

const teamsDisconnectResponseSchema = object({
  success: literal(true),
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
    query: object({
      action: string().optional(),
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

export type TeamsConnectStatus = zInfer<typeof teamsConnectStatusSchema>;
export type TeamsConnectBody = zInfer<typeof teamsConnectBodySchema>;
export type TeamsConnectResponse = zInfer<typeof teamsConnectResponseSchema>;
export type TeamsDisconnectResponse = zInfer<
  typeof teamsDisconnectResponseSchema
>;
export type TeamsConnectContract = typeof teamsConnectContract;
