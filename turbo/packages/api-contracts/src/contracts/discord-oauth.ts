import { literal, object, strictObject, string, url, enum as zEnum } from "zod";
import {
  discordOauthApprovalBodySchema,
  discordOauthProofSchema as proofSchema,
} from "../validators/discord-oauth";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { discordSnowflakeSchema } from "./integrations-discord-read";

export { discordOauthApprovalBodySchema } from "../validators/discord-oauth";

const c = initContract();

/** Start in the authenticated current org; never accept caller-selected owners. */
export const discordOauthContract = c.router({
  start: {
    method: "POST",
    path: "/api/integrations/discord/oauth/start",
    headers: authHeadersSchema,
    body: strictObject({
      guildId: discordSnowflakeSchema.optional(),
      // Current Connect actions omit this: a guild ID means connect, otherwise install.
      flow: zEnum(["install", "connect"]).optional(),
    }),
    responses: {
      200: object({
        authorizationUrl: url().max(8192),
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
    body: discordOauthApprovalBodySchema,
    responses: {
      200: object({ approved: literal(true) }),
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
    body: strictObject({ state: proofSchema, completionToken: proofSchema }),
    responses: {
      200: object({ status: literal("connected") }),
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
    query: object({
      code: string().min(1).max(2048).optional(),
      error: string().min(1).max(128).optional(),
      state: proofSchema.optional(),
      guild_id: discordSnowflakeSchema.optional(),
    }),
    responses: { 307: c.noBody(), 400: apiErrorSchema },
    summary:
      "Verify one-use Discord provider evidence without binding an Okou owner",
  },
});

export type DiscordOauthContract = typeof discordOauthContract;
