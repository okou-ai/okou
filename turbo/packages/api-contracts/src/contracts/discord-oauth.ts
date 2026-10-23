import * as z from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { discordSnowflakeSchema } from "./integrations-discord-read";

const proofSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u);

const c = initContract();

/** Start in the authenticated current org; never accept caller-selected owners. */
export const discordOauthContract = c.router({
  start: {
    method: "POST",
    path: "/api/integrations/discord/oauth/start",
    headers: authHeadersSchema,
    body: z.strictObject({
      guildId: discordSnowflakeSchema.optional(),
      // Current Connect actions omit this: a guild ID means connect, otherwise install.
      flow: z.enum(["install", "connect"]).optional(),
    }),
    responses: {
      200: z.object({
        authorizationUrl: z.url().max(8192),
        completionToken: proofSchema,
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Connect Discord or install Okou into a selected server",
  },
  approve: {
    method: "POST",
    path: "/api/integrations/discord/oauth/approve",
    headers: authHeadersSchema,
    body: z.strictObject({ state: proofSchema, approvalProof: proofSchema }),
    responses: {
      200: z.object({ approved: z.literal(true) }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Approve provider evidence in the authenticated consent browser",
  },
  complete: {
    method: "POST",
    path: "/api/integrations/discord/oauth/complete",
    headers: authHeadersSchema,
    body: z.strictObject({ state: proofSchema, completionToken: proofSchema }),
    responses: {
      200: z.object({ status: z.literal("connected") }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Complete an owner- and consent-browser-verified Discord OAuth attempt",
  },
  callback: {
    method: "GET",
    path: "/api/integrations/discord/oauth/callback",
    query: z.object({
      code: z.string().min(1).max(2048).optional(),
      error: z.string().min(1).max(128).optional(),
      state: proofSchema.optional(),
      guild_id: discordSnowflakeSchema.optional(),
    }),
    responses: { 307: c.noBody(), 400: apiErrorSchema },
    summary:
      "Verify one-use Discord provider evidence without binding an Okou owner",
  },
});

export type DiscordOauthContract = typeof discordOauthContract;
