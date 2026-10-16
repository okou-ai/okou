import { createHash } from "node:crypto";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import { and, eq, or, sql } from "drizzle-orm";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";

export type NetworkProvider = "cloudflare_access" | "tailscale";
export interface NetworkOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly orgRole?: "admin" | "member";
}
export interface NetworkReference {
  readonly protocol: "ssh" | "vnc";
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly generation: number;
  readonly version: string;
  readonly rfb: boolean;
  readonly kdc: boolean;
}
export function presentNetworkReference(
  host: {
    readonly protocol: "ssh" | "vnc";
    readonly id: string | null;
    readonly userId: string | null;
    readonly displayName: string | null;
    readonly generation: number | null;
    readonly version: string;
    readonly rfb: boolean;
    readonly kdc: boolean;
  } | null,
): NetworkReference | undefined {
  if (host === null || host.id === null) {
    return undefined;
  }
  if (
    host.userId === null ||
    host.displayName === null ||
    host.generation === null
  ) {
    throw new Error("Network reference has incomplete Host identity");
  }
  return {
    ...host,
    id: host.id,
    userId: host.userId,
    displayName: host.displayName,
    generation: host.generation,
  };
}
export function networkConfigTable(provider: NetworkProvider) {
  return provider === "tailscale" ? tailscaleConfigs : cloudflareAccessConfigs;
}
export function networkConfigFields(
  provider: NetworkProvider,
  tagsAlias: "observed_network_tags" | "changed_network_tags",
) {
  const table = networkConfigTable(provider);
  return {
    id: table.id,
    name: table.name,
    scope: table.scope,
    revision: table.revision,
    generation: table.generation,
    createdAt: table.createdAt,
    updatedAt: table.updatedAt,
    tags: (provider === "tailscale"
      ? sql`${tailscaleConfigs.tags}`
      : sql`NULL::text[]`
    )
      .mapWith(nullableDriverValueDecoder(tailscaleConfigs.tags))
      .as(tagsAlias),
  };
}
export interface NetworkMetadata {
  readonly id: string;
  readonly name: string;
  readonly scope: "personal" | "organization";
  readonly revision: number;
  readonly generation: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly tags: string[] | null;
}
export function cloudflareNetworkMetadata(row: NetworkMetadata) {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    revision: row.revision,
    generation: row.generation,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
export function tailscaleNetworkMetadata(row: NetworkMetadata) {
  if (row.tags === null) {
    throw new Error("Tailscale configuration has no tags");
  }
  return { ...cloudflareNetworkMetadata(row), tags: row.tags };
}
export function visibleNetworkConfig(
  provider: NetworkProvider,
  owner: NetworkOwner,
  id: string,
) {
  const table = networkConfigTable(provider);
  return and(
    eq(table.orgId, owner.orgId),
    eq(table.id, id),
    or(
      eq(table.scope, "organization"),
      and(eq(table.scope, "personal"), eq(table.userId, owner.userId)),
    ),
  );
}
export function networkImpactSnapshot(
  config: { readonly id: string; readonly revision: number },
  references: readonly NetworkReference[],
) {
  const sorted = [...references].sort((a, b) => {
    return a.protocol.localeCompare(b.protocol) || a.id.localeCompare(b.id);
  });
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.id,
        config.revision,
        sorted.map((host) => {
          return [
            host.protocol,
            host.id,
            host.userId,
            host.generation,
            host.rfb,
            host.kdc,
          ];
        }),
      ]),
    )
    .digest("hex");
}
export function ownNetworkReferences(
  references: readonly NetworkReference[],
  userId: string,
) {
  return references.filter((host) => {
    return host.userId === userId;
  });
}
export function networkHostMetadata(references: readonly NetworkReference[]) {
  const sshHosts = references
    .filter((host) => {
      return host.protocol === "ssh";
    })
    .map(({ id, displayName }) => {
      return { id, displayName };
    });
  const vncHosts = references
    .filter((host) => {
      return host.protocol === "vnc";
    })
    .map((host) => {
      const roles: ("rfb" | "kdc")[] = [];
      if (host.rfb) {
        roles.push("rfb");
      }
      if (host.kdc) {
        roles.push("kdc");
      }
      return { id: host.id, displayName: host.displayName, roles };
    });
  return { sshHosts, ...(vncHosts.length === 0 ? {} : { vncHosts }) };
}
