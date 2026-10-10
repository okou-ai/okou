import { eq, ne, sql, type SQLWrapper } from "drizzle-orm";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { nowDate } from "../../lib/time";
import type { TailscaleMutationArgs } from "./tailscale-mutation-plan";

export function tailscaleHostMutationValues(args: TailscaleMutationArgs) {
  const advanced = {
    generation: sql`${sshConnections.generation} + 1`,
    updatedAt: nowDate(),
  };
  if (args.operation === "delete") {
    return {
      ...advanced,
      tailscaleId: null,
      transport: "tailscale" as const,
      legacyNeedsRebind: true,
    };
  }
  if (args.operation === "adopt") {
    return {
      ...advanced,
      tailscaleId: sql`CASE WHEN ${eq(sshConnections.userId, args.owner.userId)}
        THEN ${sshConnections.tailscaleId} ELSE NULL END`,
      transport: "tailscale" as const,
      legacyNeedsRebind: sql`${ne(sshConnections.userId, args.owner.userId)}`,
    };
  }
  return advanced;
}
export function tailscaleConfigMutationValues(
  args: TailscaleMutationArgs,
  effective: SQLWrapper,
) {
  const advanced = {
    revision: sql`${tailscaleConfigs.revision} + 1`,
    generation: sql`${tailscaleConfigs.generation} + CASE WHEN ${effective} THEN 1 ELSE 0 END`,
    updatedAt: nowDate(),
  };
  switch (args.operation) {
    case "update": {
      return {
        ...advanced,
        name: args.body.name,
        tags: args.body.tags,
        ...args.encrypted,
      };
    }
    case "promote": {
      return { ...advanced, scope: "organization" as const, userId: null };
    }
    case "adopt": {
      return {
        ...advanced,
        scope: "personal" as const,
        userId: args.owner.userId,
      };
    }
    case "delete": {
      throw new Error("Deleted Tailscale configuration has no update values");
    }
  }
}
