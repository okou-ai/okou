import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const cloudflareAccessConfigs = pgTable(
  "cloudflare_access_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    encryptedClientId: text("encrypted_client_id").notNull(),
    encryptedClientSecret: text("encrypted_client_secret").notNull(),
    revision: integer("revision").default(1).notNull(),
    generation: integer("generation").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      unique("uq_cloudflare_access_configs_owner_id").on(
        table.id,
        table.orgId,
        table.userId,
      ),
      index("idx_cloudflare_access_configs_owner_created").on(
        table.orgId,
        table.userId,
        table.createdAt,
        table.id,
      ),
      check(
        "chk_cloudflare_access_configs_name",
        sql`char_length(${table.name}) BETWEEN 1 AND 128`,
      ),
      check(
        "chk_cloudflare_access_configs_revision",
        sql`${table.revision} > 0 AND ${table.generation} > 0`,
      ),
      check(
        "chk_cloudflare_access_configs_credentials",
        sql`char_length(${table.encryptedClientId}) > 0 AND char_length(${table.encryptedClientSecret}) > 0`,
      ),
    ];
  },
);
