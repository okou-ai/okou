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

/**
 * Stored form of a Discord delivery target. Older APIs require the retired
 * `publicBrand: "okou"` literal when they parse a persisted chat callback;
 * current readers strip it. Remove once no rollback target predates #36766
 * Phase 1.
 */
export function storedDiscordDeliveryTarget(
  target: DiscordDeliveryTarget | undefined,
): (DiscordDeliveryTarget & { readonly publicBrand: "okou" }) | undefined {
  return target ? { ...target, publicBrand: "okou" } : undefined;
}
