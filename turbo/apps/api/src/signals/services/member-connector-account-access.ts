import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { chatThreadConnectorAccessOverrides } from "@okouai/db/schema/chat-thread-connector-access";
import { connectors } from "@okouai/db/schema/connector";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { and, eq, sql } from "drizzle-orm";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { nowDate, timestampWithoutTimeZone } from "../../lib/time";

interface MemberIdentity {
  readonly orgId: string;
  readonly userId: string;
}

// This member-scoped switch can be evaluated inside existing account reads and
// conditional writes. The fallback is the registry's non-override evaluation.
export function memberConnectorAccountAccessEnabledSql(owner: MemberIdentity) {
  const key = FeatureSwitchKey.MemberConnectorAccountAccess;
  return sql`coalesce((
    SELECT (${userFeatureSwitches.switches} ->> ${key})::boolean
    FROM ${userFeatureSwitches}
    WHERE ${userFeatureSwitches.orgId} = ${owner.orgId}
      AND ${userFeatureSwitches.userId} = ${owner.userId}
  ), ${isFeatureEnabled(key, owner)})`;
}

export function memberConnectorAccountAllowed(
  account: {
    readonly defaultEnabledForChats: boolean;
    readonly memberAccessAllowed: boolean | null;
    readonly memberAccessExpiresAt: Date | null;
  },
  at: Date,
) {
  return (
    (account.memberAccessAllowed ?? account.defaultEnabledForChats) &&
    (account.memberAccessExpiresAt === null ||
      account.memberAccessExpiresAt > at)
  );
}

function memberConnectorAccountAllowedSql(at: Date) {
  return sql`coalesce(${connectors.memberAccessAllowed}, ${connectors.defaultEnabledForChats})
    AND (${connectors.memberAccessExpiresAt} IS NULL
      OR ${connectors.memberAccessExpiresAt} > ${timestampWithoutTimeZone(at)}::timestamp)`;
}

export function connectorAccountAllowedSql(
  owner: MemberIdentity,
  at = nowDate(),
) {
  return sql`CASE WHEN ${memberConnectorAccountAccessEnabledSql(owner)}
    THEN ${memberConnectorAccountAllowedSql(at)}
    ELSE coalesce(${chatThreadConnectorAccessOverrides.enabled}, ${connectors.defaultEnabledForChats})
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
        memberConnectorAccountAllowedSql(nowDate()),
      )})
    ELSE TRUE END`;
}
