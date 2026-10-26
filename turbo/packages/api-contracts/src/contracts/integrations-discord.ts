import {
  array,
  boolean,
  literal,
  object,
  strictObject,
  string,
  url,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { discordSnowflakeSchema } from "./integrations-discord-read";

const c = initContract();

export const discordContextModeSchema = zEnum([
  "full",
  "mentions_only",
  "unavailable",
]);

export const discordOrgStatusSchema = object({
  isAvailable: boolean(),
  isConnected: boolean(),
  isAdmin: boolean(),
  guildId: string().nullable(),
  guildName: string().nullable(),
  discordUserId: string().nullable(),
  defaultAgentId: string().nullable(),
  defaultAgentName: string().nullable(),
  contextMode: discordContextModeSchema,
  onboarding: literal("oauth"),
  dmSelectionConnectionId: uuid().nullable(),
  /** Only the caller's verified connections for their current Discord sender. */
  dmBindings: array(
    object({
      connectionId: uuid(),
      guildId: string(),
      guildName: string().nullable(),
      workspaceName: string(),
    }),
  ),
});

export const integrationsDiscordContract = c.router({
  installLink: {
    method: "POST",
    path: "/api/integrations/discord/install-link",
    headers: authHeadersSchema,
    body: strictObject({ invite: url().max(2048) }),
    responses: {
      200: object({
        url: url(),
        guildId: discordSnowflakeSchema,
        guildName: string(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      429: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Resolve a server invite into an App installation link without joining",
  },
  getStatus: {
    method: "GET",
    path: "/api/integrations/discord",
    headers: authHeadersSchema,
    responses: {
      200: discordOrgStatusSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get the current organization's verified Discord integration",
  },
  disconnect: {
    method: "DELETE",
    path: "/api/integrations/discord",
    headers: authHeadersSchema,
    body: c.noBody(),
    query: strictObject({}),
    responses: {
      200: object({ ok: literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect the current user from Discord",
  },
  setDmSelection: {
    method: "PUT",
    path: "/api/integrations/discord/dm-selection",
    headers: authHeadersSchema,
    body: strictObject({ connectionId: uuid() }),
    responses: {
      200: object({ ok: literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Choose the caller's default workspace for Discord",
  },
});

export type DiscordContextMode = zInfer<typeof discordContextModeSchema>;
export type DiscordOrgStatus = zInfer<typeof discordOrgStatusSchema>;
export type IntegrationsDiscordContract = typeof integrationsDiscordContract;
