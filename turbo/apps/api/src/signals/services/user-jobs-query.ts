import { and, eq, ne, sql } from "drizzle-orm";
import { userJobs } from "@okouai/db/schema/user-job";
import type { JobListQuery } from "@okouai/api-contracts/contracts/jobs";

export interface JobOwner {
  readonly orgId: string;
  readonly userId: string;
}
export function jobOwnerCondition(owner: JobOwner) {
  return and(
    eq(userJobs.orgId, owner.orgId),
    eq(userJobs.ownerUserId, owner.userId),
  );
}
export function pendingJobInputSql() {
  return sql`jsonb_array_length(${userJobs.inputs}) > jsonb_array_length(${userJobs.work}->'processedInputIds')`;
}
export function runnableJobCondition() {
  return and(
    ne(userJobs.status, "archived"),
    sql`(${userJobs.status} = 'active' OR ${pendingJobInputSql()})`,
  );
}
export function unseenJobResultSql() {
  return sql`${userJobs.work}->>'currentResultId' IS NOT NULL AND NOT (${userJobs.viewedResultIds} @> jsonb_build_array(${userJobs.work}->>'currentResultId'))`;
}

export function jobListRankSql(filter: JobListQuery["filter"]) {
  return filter === "runnable"
    ? sql`CASE WHEN ${pendingJobInputSql()} THEN 0 ELSE 1 END`
    : sql`CASE WHEN ${userJobs.status} IN ('waiting_decision', 'waiting_authorization') THEN 0 WHEN ${unseenJobResultSql()} THEN 1 ELSE 2 END`;
}

export function runnableJobsExistSql(owner: JobOwner) {
  return sql`EXISTS (SELECT 1 FROM ${userJobs} WHERE ${jobOwnerCondition(owner)} AND ${runnableJobCondition()})`;
}

export function jobsOwnerEnabledSql(owner: JobOwner, agentId: string) {
  return sql`EXISTS (SELECT 1 FROM org_members_metadata AS preference
    JOIN org_metadata AS organization ON organization.org_id = preference.org_id
    JOIN agents AS primary_agent ON primary_agent.id = organization.default_agent_id AND primary_agent.org_id = organization.org_id
    WHERE preference.org_id = ${owner.orgId} AND preference.user_id = ${owner.userId}
      AND preference.proactive_action_enabled = true AND primary_agent.id = ${agentId}::uuid
      AND (primary_agent.visibility = 'public' OR primary_agent.owner = ${owner.userId}))`;
}
