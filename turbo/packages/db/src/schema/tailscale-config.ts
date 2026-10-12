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

export const tailscaleConfigs = pgTable(
  "tailscale_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    scope: text("scope", { enum: ["personal", "organization"] })
      .default("personal")
      .notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    encryptedClientId: text("encrypted_client_id").notNull(),
    encryptedClientSecret: text("encrypted_client_secret").notNull(),
    tags: text("tags").array().notNull(),
    revision: integer("revision").default(1).notNull(),
    generation: integer("generation").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      unique("uq_tailscale_configs_org_id").on(table.id, table.orgId),
      index("idx_tailscale_configs_owner_created").on(
        table.orgId,
        table.userId,
        table.createdAt,
        table.id,
      ),
      check(
        "chk_tailscale_configs_name",
        sql`char_length(${table.name}) BETWEEN 1 AND 128`,
      ),
      check(
        "chk_tailscale_configs_revision",
        sql`${table.revision} > 0 AND ${table.generation} > 0`,
      ),
      check(
        "chk_tailscale_configs_credentials",
        sql`char_length(${table.encryptedClientId}) > 0 AND char_length(${table.encryptedClientSecret}) > 0`,
      ),
      check(
        "chk_tailscale_configs_scope_owner",
        sql`(${table.scope} = 'personal' AND ${table.userId} IS NOT NULL) OR (${table.scope} = 'organization' AND ${table.userId} IS NULL)`,
      ),
      check(
        "chk_tailscale_configs_tags",
        sql`array_ndims(${table.tags}) = 1 AND cardinality(${table.tags}) BETWEEN 1 AND 16 AND array_position(${table.tags}, NULL) IS NULL`,
      ),
    ];
  },
);
