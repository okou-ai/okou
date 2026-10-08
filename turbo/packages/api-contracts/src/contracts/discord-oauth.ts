import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/** Start in the authenticated current org; never accept caller-selected owners. */
export const discordOauthContract = c.router({
  start: {
    method: "POST",
    path: "/api/integrations/discord/oauth/start",
    headers: authHeadersSchema,
    body: z.strictObject({
      flow: z.enum(["install", "connect"]),
      guildId: z
        .string()
        .regex(/^[1-9]\d{0,19}$/u)
        .optional(),
    }),
    responses: {
      200: z.object({ authorizationUrl: z.url() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Start browser-correlated Discord installation or account linking",
  },
  callback: {
    method: "GET",
    path: "/api/integrations/discord/oauth/callback",
    query: z.object({
      code: z.string().optional(),
      error: z.string().optional(),
      state: z.string().optional(),
      guild_id: z.string().optional(),
    }),
    responses: { 307: c.noBody() },
    summary: "Consume a one-use Discord OAuth attempt in its starting browser",
  },
});

export type DiscordOauthContract = typeof discordOauthContract;
