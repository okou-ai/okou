import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const discordContextModeSchema = z.enum([
  "full",
  "mentions_only",
  "unavailable",
]);

export const discordOrgStatusSchema = z.object({
  isAvailable: z.boolean(),
  isInstalled: z.boolean(),
  isConnected: z.boolean(),
  isAdmin: z.boolean(),
  guildId: z.string().nullable(),
  guildName: z.string().nullable(),
  discordUserId: z.string().nullable(),
  defaultAgentId: z.string().nullable(),
  defaultAgentName: z.string().nullable(),
  contextMode: discordContextModeSchema,
  onboarding: z.literal("oauth_deferred"),
  dmSelectionConnectionId: z.uuid().nullable(),
  /** Only the caller's verified connections for their current Discord sender. */
  dmBindings: z.array(
    z.object({
      connectionId: z.uuid(),
      guildId: z.string(),
      guildName: z.string().nullable(),
    }),
  ),
});

export const integrationsDiscordContract = c.router({
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
    query: z.object({
      action: z.enum(["disconnect", "uninstall"]).optional(),
    }),
    responses: {
      200: z.object({ ok: z.literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect the current user or remove this guild as an admin",
  },
  setAgentPreference: {
    method: "PUT",
    path: "/api/integrations/discord/agent-preference",
    headers: authHeadersSchema,
    body: z.strictObject({ agentId: z.uuid().nullable() }),
    responses: {
      200: z.object({ ok: z.literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Choose an accessible Discord agent or use the organization default",
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
    summary: "Choose one of the caller's verified Discord DM bindings",
  },
});

export type DiscordContextMode = z.infer<typeof discordContextModeSchema>;
export type DiscordOrgStatus = z.infer<typeof discordOrgStatusSchema>;
export type IntegrationsDiscordContract = typeof integrationsDiscordContract;
