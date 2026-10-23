import * as z from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { discordSnowflakeSchema } from "./integrations-discord-read";

const c = initContract();

export const discordContextModeSchema = z.enum([
  "full",
  "mentions_only",
  "unavailable",
]);

export const discordOrgStatusSchema = z.object({
  isAvailable: z.boolean(),
  isConnected: z.boolean(),
  isAdmin: z.boolean(),
  guildId: z.string().nullable(),
  guildName: z.string().nullable(),
  discordUserId: z.string().nullable(),
  defaultAgentId: z.string().nullable(),
  defaultAgentName: z.string().nullable(),
  contextMode: discordContextModeSchema,
  onboarding: z.literal("oauth"),
  dmSelectionConnectionId: z.uuid().nullable(),
  /** Only the caller's verified connections for their current Discord sender. */
  dmBindings: z.array(
    z.object({
      connectionId: z.uuid(),
      guildId: z.string(),
      guildName: z.string().nullable(),
      workspaceName: z.string(),
    }),
  ),
});

export const integrationsDiscordContract = c.router({
  installLink: {
    method: "POST",
    path: "/api/integrations/discord/install-link",
    headers: authHeadersSchema,
    body: z.strictObject({ invite: z.url().max(2048) }),
    responses: {
      200: z.object({
        url: z.url(),
        guildId: discordSnowflakeSchema,
        guildName: z.string(),
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
    query: z.strictObject({}),
    responses: {
      200: z.object({ ok: z.literal(true) }),
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
    body: z.strictObject({ connectionId: z.uuid() }),
    responses: {
      200: z.object({ ok: z.literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Choose the caller's default workspace for Discord",
  },
});

export type DiscordContextMode = z.infer<typeof discordContextModeSchema>;
export type DiscordOrgStatus = z.infer<typeof discordOrgStatusSchema>;
export type IntegrationsDiscordContract = typeof integrationsDiscordContract;
