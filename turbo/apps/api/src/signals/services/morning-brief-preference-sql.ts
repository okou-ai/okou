import { MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { workflows } from "@okouai/db/schema/workflow";
import { inArray, sql } from "drizzle-orm";
import type { MorningBriefMemberIdentity } from "./morning-brief-enrollment-data.service";

export function morningBriefTimezoneTargetSql(
  owner: MorningBriefMemberIdentity,
) {
  return sql`SELECT ${workflows.id} AS "workflowId", ${orgMembersMetadata.timezone} AS timezone
    FROM ${workflows}
    JOIN ${orgMembersMetadata} ON ${orgMembersMetadata.orgId} = ${workflows.orgId}
      AND ${orgMembersMetadata.userId} = ${workflows.ownerUserId}
    WHERE ${workflows.orgId} = ${owner.orgId} AND ${workflows.ownerUserId} = ${owner.userId}
      AND ${workflows.visibility} = 'private'
      AND ${inArray(workflows.officialDefinitionName, [...MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES])}`;
}
