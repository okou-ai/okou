import { z } from "zod";

export const discordOauthCompletionSchema = z.object({
  type: z.literal("discord-oauth-completed"),
  state: z.string(),
});

export type DiscordOauthCompletion = z.infer<
  typeof discordOauthCompletionSchema
>;
