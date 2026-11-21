import { MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { workflows } from "@okouai/db/schema/workflow";
import { inArray, sql } from "drizzle-orm";
import type { MorningBriefMemberIdentity } from "./morning-brief-enrollment-data.service";

/** Both rollout definition names share one workspace-member identity. */
export function morningBriefSelectedWorkflowSql(
  owner: MorningBriefMemberIdentity,
) {
  return sql`SELECT ${workflows.id} AS "workflowId"
    FROM ${workflows}
    WHERE ${workflows.orgId} = ${owner.orgId} AND ${workflows.ownerUserId} = ${owner.userId}
      AND ${workflows.visibility} = 'private'
      AND ${inArray(workflows.officialDefinitionName, [...MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES])}
    LIMIT 1`;
}

export function morningBriefTimezoneTargetSql(
  owner: MorningBriefMemberIdentity,
) {
  return sql`WITH selected AS (${morningBriefSelectedWorkflowSql(owner)})
    SELECT selected."workflowId", ${orgMembersMetadata.timezone} AS timezone
    FROM selected JOIN ${orgMembersMetadata} ON ${orgMembersMetadata.orgId} = ${owner.orgId}
      AND ${orgMembersMetadata.userId} = ${owner.userId}`;
}
