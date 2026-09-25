import { pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * Application transport receipts outlive a removed guild or canonical chat so
 * replay cannot uninstall a later binding or launch the same message twice.
 * The opaque digest contains no guild, organization, user, payload, or credential.
 */
export const discordGatewayReceipts = pgTable("discord_gateway_receipts", {
  eventDigest: varchar("event_digest", { length: 64 }).primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
