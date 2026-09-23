import { sql } from "drizzle-orm";
import {
  check,
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sshConnections } from "./ssh-connection";
import { vncCredentials } from "./vnc-credential";

export const vncConnections = pgTable(
  "vnc_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    displayName: varchar("display_name", { length: 128 }).notNull(),
    host: varchar("host", { length: 253 }).notNull(),
    port: integer("port").notNull().default(5900),
    transportType: varchar("transport_type", {
      length: 16,
      enum: ["direct", "ssh"],
    })
      .default("direct")
      .notNull(),
    sshConnectionId: uuid("ssh_connection_id"),
    x509ServerName: varchar("x509_server_name", { length: 253 }),
    credentialId: uuid("credential_id").notNull(),
    authMethod: varchar("auth_method", {
      length: 32,
      enum: ["vnc_password", "username_password", "apple_dh_username_password"],
    }).notNull(),
    securityType: varchar("security_type", {
      length: 32,
      enum: ["x509_vnc", "x509_plain", "apple_dh"],
    }).notNull(),
    trustMode: varchar("trust_mode", {
      length: 16,
      enum: ["system", "custom_ca", "none"],
    }).notNull(),
    caBundle: text("ca_bundle"),
    generation: integer("generation").notNull().default(1),
    defaultEnabledForChats: boolean("default_enabled_for_chats")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "vnc_connections_ssh_owner_fk",
        columns: [table.sshConnectionId, table.orgId, table.userId],
        foreignColumns: [
          sshConnections.id,
          sshConnections.orgId,
          sshConnections.userId,
        ],
      }).onDelete("restrict"),
      foreignKey({
        name: "vnc_connections_credential_owner_fk",
        columns: [table.credentialId, table.orgId, table.userId],
        foreignColumns: [
          vncCredentials.id,
          vncCredentials.orgId,
          vncCredentials.userId,
        ],
      }).onDelete("restrict"),
      foreignKey({
        name: "vnc_connections_credential_profile_fk",
        columns: [
          table.credentialId,
          table.orgId,
          table.userId,
          table.authMethod,
        ],
        foreignColumns: [
          vncCredentials.id,
          vncCredentials.orgId,
          vncCredentials.userId,
          vncCredentials.authMethod,
        ],
      }).onDelete("restrict"),
      index("idx_vnc_connections_credential").on(table.credentialId, table.id),
      index("idx_vnc_connections_ssh").on(table.sshConnectionId, table.id),
      index("idx_vnc_connections_owner_created").on(
        table.orgId,
        table.userId,
        table.createdAt,
        table.id,
      ),
      index("idx_vnc_connections_user").on(table.userId, table.id),
      check(
        "chk_vnc_connections_display_name",
        sql`char_length(${table.displayName}) BETWEEN 1 AND 128`,
      ),
      check(
        "chk_vnc_connections_host",
        sql`char_length(${table.host}) BETWEEN 1 AND 253 AND ${table.host} = lower(${table.host}) AND ${table.host} !~ '[[:space:]/@?#]'`,
      ),
      check("chk_vnc_connections_port", sql`${table.port} BETWEEN 1 AND 65535`),
      check(
        "chk_vnc_connections_transport",
        sql`(${table.transportType} = 'direct' AND ${table.sshConnectionId} IS NULL) OR (${table.transportType} = 'ssh' AND ${table.sshConnectionId} IS NOT NULL)`,
      ),
      check(
        "chk_vnc_connections_x509_server_name",
        sql`${table.x509ServerName} IS NULL OR (char_length(${table.x509ServerName}) BETWEEN 1 AND 253 AND ${table.x509ServerName} = lower(${table.x509ServerName}) AND ${table.x509ServerName} !~ '[[:space:]/@?#%\\[\\]\\\\]')`,
      ),
      check("chk_vnc_connections_generation", sql`${table.generation} > 0`),
      check(
        "chk_vnc_connections_profile",
        sql`(${table.authMethod} = 'vnc_password' AND ${table.securityType} = 'x509_vnc') OR (${table.authMethod} = 'username_password' AND ${table.securityType} = 'x509_plain') OR (${table.authMethod} = 'apple_dh_username_password' AND ${table.securityType} = 'apple_dh' AND ${table.transportType} = 'ssh' AND ${table.host} IN ('127.0.0.1', '::1') AND ${table.x509ServerName} IS NULL)`,
      ),
      check(
        "chk_vnc_connections_trust",
        sql`(${table.securityType} = 'apple_dh' AND ${table.trustMode} = 'none' AND ${table.caBundle} IS NULL) OR (${table.securityType} <> 'apple_dh' AND ((${table.trustMode} = 'system' AND ${table.caBundle} IS NULL) OR (${table.trustMode} = 'custom_ca' AND ${table.caBundle} IS NOT NULL AND octet_length(${table.caBundle}) BETWEEN 1 AND 65536)))`,
      ),
    ];
  },
);
