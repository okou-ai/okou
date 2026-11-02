import { object, string, uuid, type infer as zInfer } from "zod";

export const discordDeliveryTargetSchema = object({
  routeId: uuid(),
  connectionId: uuid(),
  guildId: string().min(1).nullable(),
  discordUserId: string().min(1),
  channelId: string().min(1),
  messageId: string().min(1),
  sessionKey: string().min(1),
});

export type DiscordDeliveryTarget = zInfer<typeof discordDeliveryTargetSchema>;
