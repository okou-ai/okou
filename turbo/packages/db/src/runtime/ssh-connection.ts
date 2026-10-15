import { sql } from "drizzle-orm";
import { pgTable } from "drizzle-orm/pg-core";
import { sshConnectionColumns } from "../columns/ssh-connection";

export const sshConnections = pgTable(
  "ssh_connections",
  sshConnectionColumns(),
);

// Preserve SQL NULL for a missing left-joined host. The mapped column supplies
// the PostgreSQL boolean decoder, without reading its stored value.
export const sshConnectionNeedsRebind = sql<boolean>`
  (${sshConnections.connectionMode} = 'cloudflare_access' AND ${sshConnections.cloudflareAccessId} IS NULL)
  OR (${sshConnections.connectionMode} IN ('tailscale', 'tailscale_ssh') AND ${sshConnections.tailscaleId} IS NULL)
`.mapWith(sshConnections.defaultEnabledForChats);
