import { GET_STARTED_REWARDS } from "@okouai/api-contracts/contracts/get-started";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { workflows } from "@okouai/db/schema/workflow";
import { and, eq, isNull, sql } from "drizzle-orm";

/** Pure statement builder: snapshot provenance with the queued input.
 * The enqueue owner executes this SQL; no database capability escapes it.
 */
export function recordGetStartedWorkflowSql(
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
    readonly sourceEventId: string;
  },
  at: Date,
) {
  const reward = GET_STARTED_REWARDS.workflow;
  return sql`INSERT INTO ${getStartedClaims} (
    org_id, actor_user_id, beneficiary_user_id, quest_key, source_key,
    reward_amount, reward_target, workflow_id, source_event_id,
    next_attempt_at, created_at, updated_at
  ) SELECT ${args.orgId}, ${args.userId}, ${workflows.createdBy}, 'workflow', ${args.sourceEventId},
    ${reward.amount}, ${reward.target}, ${args.workflowId}::uuid, ${args.sourceEventId}::uuid,
    ${sql.param(at, getStartedClaims.nextAttemptAt)}, ${sql.param(at, getStartedClaims.createdAt)},
    ${sql.param(at, getStartedClaims.updatedAt)}
  FROM ${workflows}
  WHERE ${and(eq(workflows.id, args.workflowId), eq(workflows.orgId, args.orgId), isNull(workflows.officialDefinitionName))}
    AND NOT EXISTS (SELECT 1 FROM ${getStartedClaims}
      WHERE ${getStartedClaims.rewardKey} = 'workflow:' || ${workflows.createdBy})
  ON CONFLICT (actor_user_id, quest_key, source_key) DO NOTHING`;
}
