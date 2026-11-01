import type { UserPermissionGrantExpiresIn } from "@okouai/api-contracts/contracts/user-permission-grants";
import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import { and, eq } from "drizzle-orm";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function permissionGrantCondition(
  scope: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly connectorSlug: string;
  },
  permission?: string,
) {
  return and(
    eq(userPermissionGrants.orgId, scope.orgId),
    eq(userPermissionGrants.userId, scope.userId),
    eq(userPermissionGrants.agentId, scope.agentId),
    eq(userPermissionGrants.connectorSlug, scope.connectorSlug),
    permission === undefined
      ? undefined
      : eq(userPermissionGrants.permission, permission),
  );
}

export function resolveGrantExpiresAt(
  expiresIn: UserPermissionGrantExpiresIn | undefined,
  timestamp: Date,
): Date | null {
  switch (expiresIn) {
    case "1h": {
      return new Date(timestamp.getTime() + HOUR_MS);
    }
    case "24h": {
      return new Date(timestamp.getTime() + DAY_MS);
    }
    case "7d": {
      return new Date(timestamp.getTime() + 7 * DAY_MS);
    }
    case "always":
    case undefined: {
      return null;
    }
  }
}
