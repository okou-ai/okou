import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { publicBrandSchema } from "./public-brand";

import { feishuPlatformSchema } from "./feishu-platform";

const c = initContract();

// App identity permissions for both Feishu and Lark, including the Agent preset.
// These belong in the console's tenant import, not the user OAuth request.
export const FEISHU_TENANT_SCOPES = [
  "application:app_slash_command:read",
  "application:app_slash_command:write",
  "application:application:self_manage",
  "application:bot.menu:write",
  "cardkit:card:read",
  "cardkit:card:write",
  "contact:contact.base:readonly",
  "docs:document.comment:create",
  "docs:document.comment:delete",
  "docs:document.comment:read",
  "docs:document.comment:update",
  "docs:document.comment:write_only",
  "docx:document.block:convert",
  "docx:document:readonly",
  "docx:document:write_only",
  "drive:drive.metadata:readonly",
  "im:chat.members:bot_access",
  "im:chat:create",
  "im:chat:read",
  "im:chat:update",
  "im:message.group_at_msg.include_bot:readonly",
  "im:message.group_at_msg:readonly",
  // Required alongside im:message:readonly to read group chat history.
  "im:message.group_msg",
  "im:message.p2p_msg:readonly",
  "im:message.pins:read",
  "im:message.pins:write_only",
  "im:message.reactions:read",
  "im:message.reactions:write_only",
  "im:message:readonly",
  "im:message:send_as_bot",
  "im:message:send_multi_users",
  "im:message:send_sys_msg",
  "im:message:update",
  "im:resource",
  "wiki:node:read",
] as const;

export const FEISHU_OAUTH_SCOPES = [
  "offline_access",
  "contact:contact.base:readonly",
  "contact:user.base:readonly",
  "contact:user.id:readonly",
  "contact:user:search",
  "im:chat",
  "im:chat:create_by_user",
  "im:chat.members:read",
  "im:chat.members:write_only",
  "im:message",
  "im:message.p2p_msg:get_as_user",
  "im:message.group_msg:get_as_user",
  "im:message.send_as_user",
  "im:message.reactions:read",
  "im:message.reactions:write_only",
  "im:resource",
  "drive:drive",
  "drive:file",
  "drive:export:readonly",
  "docx:document",
  "docx:document.block:convert",
  "docs:document:import",
  "docs:document.media:upload",
  "docs:document.media:download",
  "docs:document.comment:create",
  "docs:document.comment:read",
  "docs:document.comment:write_only",
  "sheets:spreadsheet",
  "bitable:app",
  "wiki:wiki",
  "search:docs:read",
  "slides:presentation:read",
  "slides:presentation:write_only",
  "board:whiteboard:node:read",
  "board:whiteboard:node:create",
  "calendar:calendar",
  "task:task:write",
  "task:tasklist:write",
] as const;

const feishuInstallationStatusSchema = z.object({
  id: z.string().uuid(),
  publicBrand: publicBrandSchema,
  platform: feishuPlatformSchema.optional(),
  isConnected: z.boolean(),
  connectedUserName: z.string().nullable().optional(),
  appId: z.string(),
  botName: z.string().nullable().optional(),
  botAvatarUrl: z.string().nullable().optional(),
  callbackUrl: z.string(),
  oauthRedirectUrl: z.string().optional(),
  oauthScopes: z.array(z.string()).optional(),
  connectUrl: z.string().nullable().optional(),
  callbackVerified: z.boolean(),
  setupCompleted: z.boolean().optional(),
  messageReceived: z.boolean(),
  tenantKey: z.string().nullable(),
  tenantName: z.string().nullable(),
  defaultAgentId: z.string().uuid(),
  defaultAgentName: z.string().nullable(),
});

const feishuConnectStatusSchema = z.object({
  /** Product brand of the Host that initiated this status flow. */
  publicBrand: publicBrandSchema,
  platform: feishuPlatformSchema.optional(),
  isInstalled: z.boolean(),
  isConnected: z.boolean(),
  connectedUserName: z.string().nullable().optional(),
  isAdmin: z.boolean(),
  appId: z.string().nullable(),
  botName: z.string().nullable().optional(),
  botAvatarUrl: z.string().nullable().optional(),
  callbackUrl: z.string().nullable(),
  oauthRedirectUrl: z.string().nullable().optional(),
  oauthScopes: z.array(z.string()).optional(),
  connectUrl: z.string().nullable().optional(),
  callbackVerified: z.boolean(),
  messageReceived: z.boolean(),
  tenantKey: z.string().nullable(),
  tenantName: z.string().nullable(),
  defaultAgentId: z.string().uuid().nullable(),
  defaultAgentName: z.string().nullable(),
  installationId: z.string().uuid().nullable().optional(),
  installations: z.array(feishuInstallationStatusSchema).optional(),
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
    query: z.object({
      appId: z.string().trim().min(1),
    }),
    responses: {
      200: z.object({ available: z.literal(true) }),
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
    body: z.object({
      appId: z.string().trim().min(1),
      appSecret: z.string().trim().min(1),
      verificationToken: z.string().trim().min(1),
      encryptKey: z.string().trim().optional().default(""),
      defaultAgentId: z.string().uuid(),
      installationId: z.string().uuid().optional(),
      createNew: z.boolean().optional(),
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
    pathParams: z.object({ installationId: z.string().uuid() }),
    body: z.object({
      defaultAgentId: z.string().uuid(),
      setupCompleted: z.boolean().optional(),
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
    pathParams: z.object({ installationId: z.string().uuid() }),
    body: c.noBody(),
    responses: {
      200: z.object({ success: z.literal(true) }),
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
    pathParams: z.object({ installationId: z.string().uuid() }),
    body: c.noBody(),
    responses: {
      200: z.object({ success: z.literal(true) }),
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
      200: z.object({ success: z.literal(true) }),
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
      200: z.object({ success: z.literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect a Feishu user",
  },
});

export type FeishuConnectStatus = z.infer<typeof feishuConnectStatusSchema>;
export type FeishuInstallationStatus = z.infer<
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
