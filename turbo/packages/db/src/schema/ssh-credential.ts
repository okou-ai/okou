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

export const sshCredentials = pgTable(
  "ssh_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    username: varchar("username", { length: 255 }).notNull(),
    authMethod: varchar("auth_method", {
      length: 16,
      enum: ["private_key", "password"],
    }).notNull(),
    encryptedPrivateKey: text("encrypted_private_key"),
    encryptedPassphrase: text("encrypted_passphrase"),
    encryptedPassword: text("encrypted_password"),
    revision: integer("revision").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      unique("uq_ssh_credentials_owner_id").on(
        table.id,
        table.orgId,
        table.userId,
      ),
      index("idx_ssh_credentials_owner_created").on(
        table.orgId,
        table.userId,
        table.createdAt,
        table.id,
      ),
      check(
        "chk_ssh_credentials_name",
        sql`char_length(${table.name}) BETWEEN 1 AND 128`,
      ),
      check(
        "chk_ssh_credentials_username",
        sql`char_length(${table.username}) BETWEEN 1 AND 255`,
      ),
      check("chk_ssh_credentials_revision", sql`${table.revision} > 0`),
      check(
        "chk_ssh_credentials_auth",
        sql`(
    ${table.authMethod} = 'private_key' AND ${table.encryptedPrivateKey} IS NOT NULL
    AND char_length(${table.encryptedPrivateKey}) > 0 AND ${table.encryptedPassword} IS NULL
    AND (${table.encryptedPassphrase} IS NULL OR char_length(${table.encryptedPassphrase}) > 0)
  ) OR (
    ${table.authMethod} = 'password' AND ${table.encryptedPassword} IS NOT NULL
    AND char_length(${table.encryptedPassword}) > 0
    AND ${table.encryptedPrivateKey} IS NULL AND ${table.encryptedPassphrase} IS NULL
  )`,
      ),
    ];
  },
);
