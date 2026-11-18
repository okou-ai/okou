import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const larkOfficialAppTickets = pgTable("lark_official_app_tickets", {
  appId: text("app_id").primaryKey(),
  encryptedTicket: text("encrypted_ticket").notNull(),
  eventTimestamp: bigint("event_timestamp", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
