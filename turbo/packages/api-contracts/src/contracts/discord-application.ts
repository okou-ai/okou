import { z } from "zod";

/** Discord's application metadata, not a guild or channel authorization grant. */
export const discordApplicationSchema = z
  .object({
    id: z.string().regex(/^[1-9]\d{0,19}$/u),
    flags: z.number().int().nonnegative().max(0x7fffffff).optional(),
    flags_new: z.string().regex(/^\d+$/u).optional(),
  })
  .refine((application) => {
    return (
      application.flags !== undefined || application.flags_new !== undefined
    );
  })
  .transform((application) => {
    // flags_new is the full bitset; flags only contains the original 31 bits.
    const flags = BigInt(application.flags_new ?? application.flags!);
    const messageContent = (1n << 18n) | (1n << 19n);
    return {
      id: application.id,
      messageContentEnabled: (flags & messageContent) !== 0n,
    };
  });

export type DiscordApplication = z.infer<typeof discordApplicationSchema>;
