import { sql } from "drizzle-orm";
import { pgTable } from "drizzle-orm/pg-core";
import { sshConnectionColumns } from "../columns/ssh-connection";

// Exclude needs_rebind from implicit INSERT/SELECT/RETURNING. Physical storage
// remains until this API is serving, outgoing statements drain and rollback
// excludes legacy-dependent APIs; the later contraction belongs to #39380.
export const sshConnections = pgTable(
  "ssh_connections",
  sshConnectionColumns(),
);

// Preserve SQL NULL for a missing left-joined host. The mapped column supplies
// the PostgreSQL boolean decoder, without reading its stored value.
export const sshConnectionNeedsRebind = sql<boolean>`
  (${sshConnections.transport} = 'cloudflare_access' AND ${sshConnections.cloudflareAccessId} IS NULL)
  OR (${sshConnections.transport} = 'tailscale' AND ${sshConnections.tailscaleId} IS NULL)
`.mapWith(sshConnections.defaultEnabledForChats);
