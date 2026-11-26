import {
  getStaffOrgRolloutDigests,
  isFeatureEnabled,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { chatThreadConnectorAccessOverrides } from "@okouai/db/schema/chat-thread-connector-access";
import { connectors } from "@okouai/db/schema/connector";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { nowDateSql } from "../../lib/time";

interface MemberIdentity {
  readonly orgId: string | SQL;
  readonly userId: string | SQL;
}

const key = FeatureSwitchKey.MemberConnectorAccountAccess;
const staffOrgRolloutDigests = getStaffOrgRolloutDigests(key);

// This member-scoped switch can be evaluated inside existing account reads and
// conditional writes. The fallback is the registry's non-override evaluation.
export function memberConnectorAccountAccessEnabledSql(owner: MemberIdentity) {
  const registryEnabled = isFeatureEnabled(key, {
    orgId: typeof owner.orgId === "string" ? owner.orgId : undefined,
    userId: typeof owner.userId === "string" ? owner.userId : undefined,
  });
  // Listener reconciliation can supply the member's organization as a column.
  const rolloutEnabled =
    typeof owner.orgId !== "string" &&
    !registryEnabled &&
    staffOrgRolloutDigests.length > 0
      ? inArray(
          sql`encode(sha256(convert_to(${owner.orgId}, 'UTF8')), 'hex')`,
          staffOrgRolloutDigests,
        )
      : registryEnabled;
  return sql`coalesce((
    SELECT (${userFeatureSwitches.switches} ->> ${key})::boolean
    FROM ${userFeatureSwitches}
    WHERE ${userFeatureSwitches.orgId} = ${owner.orgId}
      AND ${userFeatureSwitches.userId} = ${owner.userId}
  ), ${rolloutEnabled})`;
}

export function memberConnectorAccountAllowed(
  account: {
    readonly defaultEnabledForChats: boolean;
    readonly chatAccessAllowed: boolean | null;
    readonly chatAccessExpiresAt: Date | null;
  },
  at: Date,
) {
  return (
    (account.chatAccessAllowed ?? account.defaultEnabledForChats) &&
    (account.chatAccessExpiresAt === null || account.chatAccessExpiresAt > at)
  );
}

function memberConnectorAccountAllowedSql() {
  const at = nowDateSql(sql`(statement_timestamp() AT TIME ZONE 'UTC')`);
  return sql`coalesce(${connectors.chatAccessAllowed}, ${connectors.defaultEnabledForChats})
    AND (${connectors.chatAccessExpiresAt} IS NULL
      OR ${connectors.chatAccessExpiresAt} > ${at})`;
}

export function legacyChatConnectorAccountAllowedSql() {
  return sql`coalesce(${chatThreadConnectorAccessOverrides.enabled}, ${connectors.defaultEnabledForChats})`.mapWith(
    pgBooleanDecoder,
  );
}

export function connectorAccountAllowedSql(owner: MemberIdentity) {
  return sql`CASE WHEN ${memberConnectorAccountAccessEnabledSql(owner)}
    THEN ${memberConnectorAccountAllowedSql()}
    ELSE ${legacyChatConnectorAccountAllowedSql()}
    END`.mapWith(pgBooleanDecoder);
}

export function workflowEventConnectorAllowedSql(
  owner: MemberIdentity,
  connectionId: string,
) {
  return sql`CASE WHEN ${memberConnectorAccountAccessEnabledSql(owner)}
    THEN EXISTS (SELECT 1 FROM ${connectors}
      WHERE ${and(
        eq(connectors.id, connectionId),
        eq(connectors.orgId, owner.orgId),
        eq(connectors.userId, owner.userId),
        memberConnectorAccountAllowedSql(),
      )})
    ELSE TRUE END`;
}
