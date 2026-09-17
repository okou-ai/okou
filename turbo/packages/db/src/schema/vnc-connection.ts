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
    credentialId: uuid("credential_id").notNull(),
    securityType: varchar("security_type", {
      length: 32,
      enum: ["x509_vnc"],
    }).notNull(),
    trustMode: varchar("trust_mode", {
      length: 16,
      enum: ["system", "custom_ca"],
    }).notNull(),
    caBundle: text("ca_bundle"),
    generation: integer("generation").notNull().default(1),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "vnc_connections_credential_owner_fk",
        columns: [table.credentialId, table.orgId, table.userId],
        foreignColumns: [
          vncCredentials.id,
          vncCredentials.orgId,
          vncCredentials.userId,
        ],
      }).onDelete("restrict"),
      index("idx_vnc_connections_credential").on(table.credentialId, table.id),
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
      check("chk_vnc_connections_generation", sql`${table.generation} > 0`),
      check(
        "chk_vnc_connections_security_type",
        sql`${table.securityType} = 'x509_vnc'`,
      ),
      check(
        "chk_vnc_connections_trust",
        sql`(${table.trustMode} = 'system' AND ${table.caBundle} IS NULL) OR (${table.trustMode} = 'custom_ca' AND ${table.caBundle} IS NOT NULL AND octet_length(${table.caBundle}) BETWEEN 1 AND 65536)`,
      ),
    ];
  },
);
