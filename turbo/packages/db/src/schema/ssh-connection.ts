import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sshCredentials } from "./ssh-credential";
import { cloudflareAccessConfigs } from "./cloudflare-access-config";

export const sshConnections = pgTable(
  "ssh_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    displayName: varchar("display_name", { length: 128 }).notNull(),
    host: varchar("host", { length: 253 }).notNull(),
    port: integer("port").notNull().default(22),
    credentialId: uuid("credential_id").notNull(),
    cloudflareAccessId: uuid("cloudflare_access_id"),
    learnedHostKeyAlgorithm: varchar("learned_host_key_algorithm", {
      length: 64,
    }),
    learnedHostKeyFingerprint: varchar("learned_host_key_fingerprint", {
      length: 64,
    }),
    generation: integer("generation").notNull().default(1),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "ssh_connections_cloudflare_access_owner_fk",
        columns: [table.cloudflareAccessId, table.orgId, table.userId],
        foreignColumns: [
          cloudflareAccessConfigs.id,
          cloudflareAccessConfigs.orgId,
          cloudflareAccessConfigs.userId,
        ],
      }).onDelete("restrict"),
      index("idx_ssh_connections_cloudflare_access").on(
        table.cloudflareAccessId,
        table.id,
      ),
      check(
        "chk_ssh_connections_cloudflare_access_destination",
        sql`${table.cloudflareAccessId} IS NULL OR (${table.port} = 443 AND ${table.host} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' AND ${table.host} !~ '^[0-9.]+$')`,
      ),
      foreignKey({
        name: "ssh_connections_credential_owner_fk",
        columns: [table.credentialId, table.orgId, table.userId],
        foreignColumns: [
          sshCredentials.id,
          sshCredentials.orgId,
          sshCredentials.userId,
        ],
      }).onDelete("restrict"),
      index("idx_ssh_connections_credential").on(table.credentialId, table.id),
      index("idx_ssh_connections_owner_created").on(
        table.orgId,
        table.userId,
        table.createdAt,
        table.id,
      ),
      check(
        "chk_ssh_connections_display_name",
        sql`char_length(${table.displayName}) BETWEEN 1 AND 128`,
      ),
      check(
        "chk_ssh_connections_host",
        sql`char_length(${table.host}) BETWEEN 1 AND 253`,
      ),
      check("chk_ssh_connections_port", sql`${table.port} BETWEEN 1 AND 65535`),
      check("chk_ssh_connections_generation", sql`${table.generation} > 0`),
      check(
        "chk_ssh_connections_learned_host_key_pair",
        sql`(${table.learnedHostKeyAlgorithm} IS NULL) = (${table.learnedHostKeyFingerprint} IS NULL)`,
      ),
    ];
  },
);
