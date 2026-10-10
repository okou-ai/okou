import { MORNING_BRIEF_OFFICIAL_DEFINITION_NAME } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { agents } from "@okouai/db/schema/agent";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { workflows } from "@okouai/db/schema/workflow";
import { sql } from "drizzle-orm";
import type { MorningBriefMemberIdentity } from "./morning-brief-enrollment-data.service";

/** Preserve the enrollment, visible default Agent, then oldest-installation precedence. */
export function morningBriefSelectedWorkflowSql(
  owner: MorningBriefMemberIdentity,
) {
  return sql`SELECT ${workflows.id} AS "workflowId"
    FROM ${workflows}
    LEFT JOIN ${morningBriefEnrollments} ON ${morningBriefEnrollments.orgId} = ${workflows.orgId}
      AND ${morningBriefEnrollments.userId} = ${workflows.ownerUserId}
    LEFT JOIN ${orgMetadata} ON ${orgMetadata.orgId} = ${workflows.orgId}
    LEFT JOIN ${agents} ON ${agents.id} = ${orgMetadata.defaultAgentId}
      AND ${agents.orgId} = ${workflows.orgId}
    WHERE ${workflows.orgId} = ${owner.orgId} AND ${workflows.ownerUserId} = ${owner.userId}
      AND ${workflows.visibility} = 'private'
      AND ${workflows.officialDefinitionName} = ${MORNING_BRIEF_OFFICIAL_DEFINITION_NAME}
    ORDER BY CASE WHEN ${workflows.id} = ${morningBriefEnrollments.workflowId} THEN 0
      WHEN ${workflows.agentId} = ${agents.id}
        AND (${agents.visibility} <> 'private' OR ${agents.owner} = ${owner.userId}) THEN 1
      ELSE 2 END, ${workflows.createdAt}, ${workflows.id}
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
