import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import { computed, type Computed } from "ccstate";
import { and, asc, eq } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import { activeUserPermissionGrantCondition } from "./user-permission-grants.service";

export interface ConnectorPermissionScope {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}

export interface ConnectorPermissionGrant {
  readonly connectorSlug: string;
  readonly permission: string;
  readonly action: "allow" | "deny";
  readonly expiresAt: Date | null;
}

/** Capture effective overrides at read time, not at eventual execution time. */
export function createConnectorPermissionGrants(
  scope: ConnectorPermissionScope,
): Computed<Promise<readonly ConnectorPermissionGrant[]>> {
  return computed(async (get) => {
    const checkedAt = nowDate();
    return await get(db$)
      .select({
        connectorSlug: userPermissionGrants.connectorSlug,
        permission: userPermissionGrants.permission,
        action: userPermissionGrants.action,
        expiresAt: userPermissionGrants.expiresAt,
      })
      .from(userPermissionGrants)
      .where(
        and(
          eq(userPermissionGrants.orgId, scope.orgId),
          eq(userPermissionGrants.userId, scope.userId),
          eq(userPermissionGrants.agentId, scope.agentId),
          activeUserPermissionGrantCondition(checkedAt),
        ),
      )
      .orderBy(
        asc(userPermissionGrants.connectorSlug),
        asc(userPermissionGrants.permission),
      );
  });
}
