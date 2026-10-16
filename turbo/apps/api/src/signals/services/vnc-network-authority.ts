import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import type { RunnerVncCheckRequest } from "@okouai/api-contracts/contracts/runner-vnc";
import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  or,
  type SQLWrapper,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";

export const vncNetworkAliases = Object.freeze({
  rfbAccess: alias(cloudflareAccessConfigs, "vnc_rfb_access"),
  rfbTailscale: alias(tailscaleConfigs, "vnc_rfb_tailscale"),
  kdcAccess: alias(cloudflareAccessConfigs, "vnc_kdc_access"),
  kdcTailscale: alias(tailscaleConfigs, "vnc_kdc_tailscale"),
});

export function visibleVncNetworkConfig(
  config: {
    readonly id: SQLWrapper;
    readonly orgId: SQLWrapper;
    readonly userId: SQLWrapper;
    readonly scope: SQLWrapper;
  },
  configId: SQLWrapper,
) {
  return and(
    eq(config.id, configId),
    eq(config.orgId, vncConnections.orgId),
    or(
      eq(config.scope, "organization"),
      and(
        eq(config.scope, "personal"),
        eq(config.userId, vncConnections.userId),
      ),
    ),
  );
}

function roleColumns(role: "rfb" | "kdc") {
  return role === "rfb"
    ? {
        type: vncConnections.transportType,
        access: vncConnections.cloudflareAccessId,
        tailscale: vncConnections.tailscaleId,
      }
    : {
        type: vncConnections.kdcTransportType,
        access: vncConnections.kdcCloudflareAccessId,
        tailscale: vncConnections.kdcTailscaleId,
      };
}

/** Detached native references remain visible as blocked inventory entries. */
export function visibleVncNativeRole(role: "rfb" | "kdc") {
  const columns = roleColumns(role),
    qb = new QueryBuilder();
  return or(
    isNull(columns.type),
    inArray(columns.type, ["direct", "ssh"]),
    and(
      eq(columns.type, "cloudflare_access"),
      or(
        isNull(columns.access),
        exists(
          qb
            .select({ id: cloudflareAccessConfigs.id })
            .from(cloudflareAccessConfigs)
            .where(
              visibleVncNetworkConfig(cloudflareAccessConfigs, columns.access),
            ),
        ),
      ),
    ),
    and(
      eq(columns.type, "tailscale"),
      or(
        isNull(columns.tailscale),
        exists(
          qb
            .select({ id: tailscaleConfigs.id })
            .from(tailscaleConfigs)
            .where(
              visibleVncNetworkConfig(tailscaleConfigs, columns.tailscale),
            ),
        ),
      ),
    ),
  );
}

export function nativeVncSnapshotCondition(
  role: "rfb" | "kdc",
  transport: RunnerVncCheckRequest["expectedTransport"],
) {
  const columns = roleColumns(role),
    qb = new QueryBuilder();
  if (transport.type === "direct" || transport.type === "ssh") {
    return eq(columns.type, transport.type);
  }
  const config =
    transport.type === "cloudflare_access"
      ? cloudflareAccessConfigs
      : tailscaleConfigs;
  const id =
    transport.type === "cloudflare_access" ? columns.access : columns.tailscale;
  return and(
    eq(columns.type, transport.type),
    eq(id, transport.configId),
    exists(
      qb
        .select({ id: config.id })
        .from(config)
        .where(
          and(
            visibleVncNetworkConfig(config, id),
            eq(config.generation, transport.generation),
          ),
        ),
    ),
  );
}
