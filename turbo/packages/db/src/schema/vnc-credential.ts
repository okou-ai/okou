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

export const vncCredentials = pgTable(
  "vnc_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    username: varchar("username", { length: 255 }),
    authMethod: varchar("auth_method", {
      length: 32,
      enum: [
        "vnc_password",
        "username_password",
        "apple_dh_username_password",
        "apple_srp_username_password",
      ],
    }).notNull(),
    encryptedPassword: text("encrypted_password").notNull(),
    revision: integer("revision").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      unique("uq_vnc_credentials_owner_id").on(
        table.id,
        table.orgId,
        table.userId,
      ),
      unique("uq_vnc_credentials_owner_id_auth_method").on(
        table.id,
        table.orgId,
        table.userId,
        table.authMethod,
      ),
      index("idx_vnc_credentials_owner_created").on(
        table.orgId,
        table.userId,
        table.createdAt,
        table.id,
      ),
      index("idx_vnc_credentials_user").on(table.userId, table.id),
      check(
        "chk_vnc_credentials_name",
        sql`char_length(${table.name}) BETWEEN 1 AND 128`,
      ),
      check(
        "chk_vnc_credentials_auth",
        sql`(${table.authMethod} = 'vnc_password' AND ${table.username} IS NULL) OR (${table.authMethod} = 'username_password' AND ${table.username} IS NOT NULL AND octet_length(${table.username}) BETWEEN 1 AND 255) OR (${table.authMethod} = 'apple_dh_username_password' AND ${table.username} IS NOT NULL AND octet_length(${table.username}) BETWEEN 1 AND 63) OR (${table.authMethod} = 'apple_srp_username_password' AND ${table.username} IS NOT NULL AND octet_length(${table.username}) BETWEEN 1 AND 255)`,
      ),
      check(
        "chk_vnc_credentials_password",
        sql`char_length(${table.encryptedPassword}) > 0`,
      ),
      check("chk_vnc_credentials_revision", sql`${table.revision} > 0`),
    ];
  },
);
