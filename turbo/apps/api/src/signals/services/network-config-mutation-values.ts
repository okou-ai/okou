import { sshConnections } from "@okouai/db/runtime/ssh-connection";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { eq, ne, sql, type SQLWrapper } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { networkConfigTable } from "./network-config-model";
import { networkReferenceColumns } from "./network-config-references";
import type { NetworkMutationArgs } from "./network-config-mutation-query";

export function networkSshMutationValues(args: NetworkMutationArgs) {
  const column = networkReferenceColumns(args.provider).ssh;
  const detached =
    args.operation === "delete"
      ? sql`NULL::uuid`
      : args.operation === "adopt"
        ? sql`CASE WHEN ${eq(sshConnections.userId, args.owner.userId)} THEN ${column} ELSE NULL END`
        : column;
  return {
    generation: sql`${sshConnections.generation} + 1`,
    updatedAt: nowDate(),
    ...(args.provider === "tailscale"
      ? { tailscaleId: detached }
      : { cloudflareAccessId: detached }),
  };
}
export function networkVncMutationValues(args: NetworkMutationArgs) {
  const columns = networkReferenceColumns(args.provider);
  const detaching =
    args.operation === "delete"
      ? sql`true`
      : args.operation === "adopt"
        ? ne(vncConnections.userId, args.owner.userId)
        : sql`false`;
  const rfb = sql`CASE WHEN ${detaching} AND ${eq(columns.rfb, args.configId)} THEN NULL ELSE ${columns.rfb} END`;
  const kdc = sql`CASE WHEN ${detaching} AND ${eq(columns.kdc, args.configId)} THEN NULL ELSE ${columns.kdc} END`;
  return {
    generation: sql`${vncConnections.generation} + 1`,
    updatedAt: nowDate(),
    ...(args.provider === "tailscale"
      ? { tailscaleId: rfb, kdcTailscaleId: kdc }
      : { cloudflareAccessId: rfb, kdcCloudflareAccessId: kdc }),
  };
}
export function networkConfigMutationValues(
  args: Exclude<NetworkMutationArgs, { operation: "delete" }>,
  effective: SQLWrapper,
) {
  const table = networkConfigTable(args.provider);
  const advanced = {
    revision: sql`${table.revision} + 1`,
    generation: sql`${table.generation} + CASE WHEN ${effective} THEN 1 ELSE 0 END`,
    updatedAt: nowDate(),
  };
  if (args.operation === "update") {
    return { ...advanced, name: args.name, ...args.encrypted };
  }
  return {
    ...advanced,
    scope:
      args.operation === "promote"
        ? ("organization" as const)
        : ("personal" as const),
    userId: args.operation === "promote" ? null : args.owner.userId,
  };
}
