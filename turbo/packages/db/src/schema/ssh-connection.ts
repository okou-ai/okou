import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sshCredentials } from "./ssh-credential";
import { cloudflareAccessConfigs } from "./cloudflare-access-config";
import { tailscaleConfigs } from "./tailscale-config";

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
    tailscaleId: uuid("tailscale_id"),
    transport: text("transport", {
      enum: ["direct", "cloudflare_access", "tailscale"],
    }).notNull(),
    // Outgoing Cloudflare readers still consume this physical column. New
    // writers mirror canonical state; old writers must drain before migration.
    // Remove this shadow and its check only after all serving/rollback readers
    // stop consuming it (separate contract-phase follow-up under #36137).
    legacyNeedsRebind: boolean("needs_rebind").default(false).notNull(),
    learnedHostKeyAlgorithm: varchar("learned_host_key_algorithm", {
      length: 64,
    }),
    learnedHostKeyFingerprint: varchar("learned_host_key_fingerprint", {
      length: 64,
    }),
    generation: integer("generation").notNull().default(1),
    defaultEnabledForChats: boolean("default_enabled_for_chats")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      unique("uq_ssh_connections_owner_id").on(
        table.id,
        table.orgId,
        table.userId,
      ),
      foreignKey({
        name: "ssh_connections_cloudflare_access_org_fk",
        columns: [table.cloudflareAccessId, table.orgId],
        foreignColumns: [
          cloudflareAccessConfigs.id,
          cloudflareAccessConfigs.orgId,
        ],
      }).onDelete("restrict"),
      foreignKey({
        name: "ssh_connections_tailscale_org_fk",
        columns: [table.tailscaleId, table.orgId],
        foreignColumns: [tailscaleConfigs.id, tailscaleConfigs.orgId],
      }).onDelete("restrict"),
      index("idx_ssh_connections_tailscale").on(table.tailscaleId, table.id),
      check(
        "chk_ssh_connections_transport",
        sql`${table.transport} IN ('direct', 'cloudflare_access', 'tailscale')`,
      ),
      check(
        "chk_ssh_connections_transport_binding",
        sql`(${table.transport} = 'direct' AND ${table.cloudflareAccessId} IS NULL AND ${table.tailscaleId} IS NULL) OR (${table.transport} = 'cloudflare_access' AND ${table.tailscaleId} IS NULL) OR (${table.transport} = 'tailscale' AND ${table.cloudflareAccessId} IS NULL)`,
      ),
      index("idx_ssh_connections_cloudflare_access").on(
        table.cloudflareAccessId,
        table.id,
      ),
      check(
        "chk_ssh_connections_cloudflare_access_destination",
        sql`${table.transport} <> 'cloudflare_access' OR (${table.port} = 443 AND ${table.host} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' AND ${table.host} !~ '^[0-9.]+$')`,
      ),
      check(
        "chk_ssh_connections_legacy_needs_rebind",
        sql`${table.legacyNeedsRebind} = ((${table.transport} = 'cloudflare_access' AND ${table.cloudflareAccessId} IS NULL) OR (${table.transport} = 'tailscale' AND ${table.tailscaleId} IS NULL))`,
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

// Preserve PostgreSQL's nullable left-join result; do not coerce a missing host
// to false. The stored legacy flag supplies only its boolean decoder.
export const sshConnectionNeedsRebind = sql<boolean>`
  (${sshConnections.transport} = 'cloudflare_access' AND ${sshConnections.cloudflareAccessId} IS NULL)
  OR (${sshConnections.transport} = 'tailscale' AND ${sshConnections.tailscaleId} IS NULL)
`.mapWith(sshConnections.legacyNeedsRebind);
