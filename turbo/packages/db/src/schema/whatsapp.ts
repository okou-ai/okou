import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// WhatsApp ownership is verified independently of SMS/iMessage, even when the
// same E.164 number is used on both transports.
export const whatsappUserLinks = pgTable(
  "whatsapp_user_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    phoneHandle: varchar("phone_handle", { length: 254 }).notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_whatsapp_user_links_phone_handle").on(table.phoneHandle),
      uniqueIndex("idx_whatsapp_user_links_user_org").on(
        table.userId,
        table.orgId,
      ),
      index("idx_whatsapp_user_links_org").on(table.orgId),
    ];
  },
);

export const whatsappConnectionCodes = pgTable(
  "whatsapp_connection_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    consumedPhoneHandle: varchar("consumed_phone_handle", { length: 254 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_whatsapp_connection_codes_hash_expires").on(
        table.codeHash,
        table.expiresAt,
      ),
      index("idx_whatsapp_connection_codes_expires").on(table.expiresAt),
      uniqueIndex("idx_whatsapp_connection_codes_user_org").on(
        table.userId,
        table.orgId,
      ),
    ];
  },
);
