import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
const snowflake = z.string().regex(/^[0-9]{1,20}$/);
const errors = {
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
};

/** Verified fixture provisioning only, absent in production. OAuth remains deferred. */
export const testDiscordStateContract = c.router({
  post: {
    method: "POST",
    path: "/api/test/discord-state",
    headers: authHeadersSchema,
    body: z.strictObject({
      guildId: snowflake,
      guildName: z.string().min(1).max(255),
      botUserId: snowflake,
      discordUserId: snowflake,
      history: z
        .strictObject({
          chatThreadId: z.uuid(),
          channelId: snowflake,
          messageId: snowflake,
          messageText: z.string().min(1).max(2000),
        })
        .optional(),
    }),
    responses: { 200: z.object({ connectionId: z.uuid() }), ...errors },
  },
  delete: {
    method: "DELETE",
    path: "/api/test/discord-state",
    headers: authHeadersSchema,
    body: c.noBody(),
    query: z.object({ guildId: snowflake }),
    responses: { 200: z.object({ ok: z.literal(true) }), ...errors },
  },
});
