import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  unique,
} from "drizzle-orm/pg-core";
import { sshConnectionColumns } from "../columns/ssh-connection";
import { sshCredentials } from "./ssh-credential";
import { cloudflareAccessConfigs } from "./cloudflare-access-config";
import { tailscaleConfigs } from "./tailscale-config";

export const sshConnections = pgTable(
  "ssh_connections",
  {
    ...sshConnectionColumns(),
    // Migration-only compatibility storage for outgoing canonical APIs. The
    // runtime mapping omits it; remove after preparation is live, old SQL has
    // drained and compatible rollback is enforced under #39380.
    legacyNeedsRebind: boolean("needs_rebind").default(false).notNull(),
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
