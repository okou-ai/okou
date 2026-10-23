import { sshConnections } from "@okouai/db/runtime/ssh-connection";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { and, asc, eq, or, sql, type SQLWrapper } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import * as z from "zod";
import {
  pgBooleanDecoder,
  pgTextDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import {
  networkConfigTable,
  type NetworkOwner,
  type NetworkProvider,
} from "./network-config-model";

const protocolDecoder = zodEnumDriverValueDecoder(z.enum(["ssh", "vnc"]));
export function networkReferenceColumns(provider: NetworkProvider) {
  return provider === "tailscale"
    ? {
        ssh: sshConnections.tailscaleId,
        rfb: vncConnections.tailscaleId,
        kdc: vncConnections.kdcTailscaleId,
      }
    : {
        ssh: sshConnections.cloudflareAccessId,
        rfb: vncConnections.cloudflareAccessId,
        kdc: vncConnections.kdcCloudflareAccessId,
      };
}

/** One row per protocol/host, including a native Host that uses both roles. */
export function networkReferencesQuery(
  provider: NetworkProvider,
  orgId: string,
  configId: string | SQLWrapper,
) {
  const qb = new QueryBuilder();
  const columns = networkReferenceColumns(provider);
  return qb
    .select({
      protocol: sql`'ssh'::text`.mapWith(protocolDecoder).as("protocol"),
      id: sshConnections.id,
      userId: sshConnections.userId,
      displayName: sshConnections.displayName,
      generation: sshConnections.generation,
      version: sql`${sshConnections}.xmin::text`
        .mapWith(pgTextDecoder)
        .as("host_version"),
      rfb: sql`false`.mapWith(pgBooleanDecoder).as("rfb"),
      kdc: sql`false`.mapWith(pgBooleanDecoder).as("kdc"),
    })
    .from(sshConnections)
    .where(and(eq(sshConnections.orgId, orgId), eq(columns.ssh, configId)))
    .unionAll(
      qb
        .select({
          protocol: sql`'vnc'::text`.mapWith(protocolDecoder).as("protocol"),
          id: vncConnections.id,
          userId: vncConnections.userId,
          displayName: vncConnections.displayName,
          generation: vncConnections.generation,
          version: sql`${vncConnections}.xmin::text`
            .mapWith(pgTextDecoder)
            .as("host_version"),
          rfb: sql`coalesce(${eq(columns.rfb, configId)}, false)`
            .mapWith(pgBooleanDecoder)
            .as("rfb"),
          kdc: sql`coalesce(${eq(columns.kdc, configId)}, false)`
            .mapWith(pgBooleanDecoder)
            .as("kdc"),
        })
        .from(vncConnections)
        .where(
          and(
            eq(vncConnections.orgId, orgId),
            or(eq(columns.rfb, configId), eq(columns.kdc, configId)),
          ),
        ),
    )
    .orderBy(asc(sql`protocol`), asc(sql`id`));
}

export function networkConfigListReads(
  provider: NetworkProvider,
  owner: NetworkOwner,
) {
  const table = networkConfigTable(provider);
  const refs = networkReferencesQuery(provider, owner.orgId, table.id).as(
    "network_host_references",
  );
  const predicate = and(
    eq(table.orgId, owner.orgId),
    or(
      eq(table.scope, "organization"),
      and(eq(table.scope, "personal"), eq(table.userId, owner.userId)),
    ),
  );
  return { table, refs, predicate };
}
