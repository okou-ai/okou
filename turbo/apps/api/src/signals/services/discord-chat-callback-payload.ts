import { z } from "zod";

export const discordDeliveryTargetSchema = z.object({
  routeId: z.string().uuid(),
  connectionId: z.string().uuid(),
  guildId: z.string().min(1),
  discordUserId: z.string().min(1),
  channelId: z.string().min(1),
  messageId: z.string().min(1),
  sessionKey: z.string().min(1),
});

export type DiscordDeliveryTarget = z.infer<typeof discordDeliveryTargetSchema>;
