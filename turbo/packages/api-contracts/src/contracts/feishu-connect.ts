import {
  array,
  boolean,
  literal,
  object,
  string,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

import { feishuPlatformSchema } from "./feishu-platform";

const c = initContract();

export {
  FEISHU_TENANT_SCOPES,
  FEISHU_OAUTH_SCOPES,
} from "../validators/feishu-connect";

const feishuInstallationStatusSchema = object({
  id: string().uuid(),
  platform: feishuPlatformSchema.optional(),
  isConnected: boolean(),
  connectedUserName: string().nullable().optional(),
  appId: string(),
  botName: string().nullable().optional(),
  botAvatarUrl: string().nullable().optional(),
  callbackUrl: string(),
  oauthRedirectUrl: string().optional(),
  oauthScopes: array(string()).optional(),
  connectUrl: string().nullable().optional(),
  callbackVerified: boolean(),
  setupCompleted: boolean().optional(),
  messageReceived: boolean(),
  tenantKey: string().nullable(),
  tenantName: string().nullable(),
  defaultAgentId: string().uuid().nullable(),
  defaultAgentName: string().nullable(),
});

const feishuConnectStatusSchema = object({
  platform: feishuPlatformSchema.optional(),
  isInstalled: boolean(),
  isConnected: boolean(),
  connectedUserName: string().nullable().optional(),
  isAdmin: boolean(),
  appId: string().nullable(),
  botName: string().nullable().optional(),
  botAvatarUrl: string().nullable().optional(),
  callbackUrl: string().nullable(),
  oauthRedirectUrl: string().nullable().optional(),
  oauthScopes: array(string()).optional(),
  connectUrl: string().nullable().optional(),
  callbackVerified: boolean(),
  messageReceived: boolean(),
  tenantKey: string().nullable(),
  tenantName: string().nullable(),
  defaultAgentId: string().uuid().nullable(),
  defaultAgentName: string().nullable(),
  installationId: string().uuid().nullable().optional(),
  installations: array(feishuInstallationStatusSchema).optional(),
});

export const feishuConnectContract = c.router({
  getStatus: {
    method: "GET",
    path: "/api/integrations/feishu",
    headers: authHeadersSchema,
    responses: {
      200: feishuConnectStatusSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Check Feishu connection status",
  },
  checkAppId: {
    method: "GET",
    path: "/api/integrations/feishu/app-id",
    headers: authHeadersSchema,
    query: object({
      appId: string().trim().min(1),
    }),
    responses: {
      200: object({ available: literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Check whether a Feishu App ID is available",
  },
  setup: {
    method: "POST",
    path: "/api/integrations/feishu",
    headers: authHeadersSchema,
    body: object({
      appId: string().trim().min(1),
      appSecret: string().trim().min(1),
      verificationToken: string().trim().min(1),
      encryptKey: string().trim().optional().default(""),
      installationId: string().uuid().optional(),
      createNew: boolean().optional(),
    }),
    responses: {
      200: feishuConnectStatusSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Configure a Feishu custom app",
  },
  updateInstallation: {
    method: "PATCH",
    path: "/api/integrations/feishu/installations/:installationId",
    headers: authHeadersSchema,
    pathParams: object({ installationId: string().uuid() }),
    body: object({
      setupCompleted: boolean().optional(),
    }),
    responses: {
      200: feishuInstallationStatusSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Update a Feishu custom app",
  },
  removeInstallation: {
    method: "DELETE",
    path: "/api/integrations/feishu/installations/:installationId",
    headers: authHeadersSchema,
    pathParams: object({ installationId: string().uuid() }),
    body: c.noBody(),
    responses: {
      200: object({ success: literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Uninstall a Feishu custom app",
  },
  disconnectInstallation: {
    method: "DELETE",
    path: "/api/integrations/feishu/installations/:installationId/connect",
    headers: authHeadersSchema,
    pathParams: object({ installationId: string().uuid() }),
    body: c.noBody(),
    responses: {
      200: object({ success: literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect a Feishu user from a custom app",
  },
  remove: {
    method: "DELETE",
    path: "/api/integrations/feishu",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: object({ success: literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Uninstall a Feishu custom app",
  },
  disconnect: {
    method: "DELETE",
    path: "/api/integrations/feishu/connect",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: object({ success: literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect a Feishu user",
  },
});

export type FeishuConnectStatus = zInfer<typeof feishuConnectStatusSchema>;
export type FeishuInstallationStatus = zInfer<
  typeof feishuInstallationStatusSchema
>;
export type FeishuConnectContract = typeof feishuConnectContract;

export const larkConnectContract = c.router({
  getStatus: {
    ...feishuConnectContract.getStatus,
    summary: feishuConnectContract.getStatus.summary.replaceAll(
      "Feishu",
      "Lark",
    ),
    path: "/api/integrations/lark",
  },
  checkAppId: {
    ...feishuConnectContract.checkAppId,
    summary: feishuConnectContract.checkAppId.summary.replaceAll(
      "Feishu",
      "Lark",
    ),
    path: "/api/integrations/lark/app-id",
  },
  setup: {
    ...feishuConnectContract.setup,
    summary: feishuConnectContract.setup.summary.replaceAll("Feishu", "Lark"),
    path: "/api/integrations/lark",
  },
  updateInstallation: {
    ...feishuConnectContract.updateInstallation,
    summary: feishuConnectContract.updateInstallation.summary.replaceAll(
      "Feishu",
      "Lark",
    ),
    path: "/api/integrations/lark/installations/:installationId",
  },
  removeInstallation: {
    ...feishuConnectContract.removeInstallation,
    summary: feishuConnectContract.removeInstallation.summary.replaceAll(
      "Feishu",
      "Lark",
    ),
    path: "/api/integrations/lark/installations/:installationId",
  },
  disconnectInstallation: {
    ...feishuConnectContract.disconnectInstallation,
    summary: feishuConnectContract.disconnectInstallation.summary.replaceAll(
      "Feishu",
      "Lark",
    ),
    path: "/api/integrations/lark/installations/:installationId/connect",
  },
  remove: {
    ...feishuConnectContract.remove,
    summary: feishuConnectContract.remove.summary.replaceAll("Feishu", "Lark"),
    path: "/api/integrations/lark",
  },
  disconnect: {
    ...feishuConnectContract.disconnect,
    summary: feishuConnectContract.disconnect.summary.replaceAll(
      "Feishu",
      "Lark",
    ),
    path: "/api/integrations/lark/connect",
  },
});
