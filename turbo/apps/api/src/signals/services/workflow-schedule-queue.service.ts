import { workflowAutomationSnapshotCondition } from "./workflow-automation-snapshot";
import { sql, type SQL } from "drizzle-orm";
import { SCHEDULE_GRACE_MS } from "./schedule-expiry-policy";
import type { WorkflowScheduleClaimPlan } from "./workflow-automation-enqueue.service";

/** Distinguishes a failed admission from preparation that never attempted it. */
export class WorkflowScheduleAdmissionError extends Error {
  constructor(
    readonly claimId: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "WorkflowScheduleAdmissionError";
  }
}

/** Consume the exact Official anchor; a concurrent toggle, claim or expiry wins. */
export function consumeWorkflowScheduleAnchorSql(
  claim: WorkflowScheduleClaimPlan,
  admittedAt: Date,
  eligibility?: SQL,
) {
  const observation = workflowAutomationSnapshotCondition(
    claim.automationSnapshot,
  );
  if (!observation) {
    throw new Error("Morning Brief schedule requires its source observation");
  }
  return sql`UPDATE workflow_automations SET next_run_at = NULL, last_run_at = ${claim.claimedAt}, updated_at = ${claim.claimedAt}
 WHERE id = ${claim.automationId}::uuid AND enabled AND org_id = ${claim.orgId} AND owner_user_id = ${claim.ownerUserId}
 AND workflow_id = ${claim.workflowId}::uuid AND official_blueprint_key = 'daily-delivery'
 AND ${observation}
 AND next_run_at = ${claim.scheduledAnchorAt} AND next_run_at >= ${new Date(admittedAt.getTime() - SCHEDULE_GRACE_MS)}
 AND NOT EXISTS (SELECT 1 FROM morning_brief_schedule_claims
   WHERE automation_id = ${claim.automationId}::uuid AND settlement = 'unsettled')
 AND ${eligibility ?? sql`true`} RETURNING id`;
}

/**
 * Journal the consumed occurrence; its queue event is bound immediately.
 *
 * The compound owner gates this insert on its anchor-consuming UPDATE. The
 * existing unique claim identities reject a stale concurrent sequence; a SQL
 * failure rolls the consumed anchor and input back with the journal.
 */
export function journalWorkflowScheduleClaimSql(
  claim: WorkflowScheduleClaimPlan,
  queueEventId: string,
  admittedAt: Date,
  eligibility?: SQL,
) {
  return sql`
    INSERT INTO morning_brief_schedule_claims (
      id, automation_id, org_id, owner_user_id, workflow_id,
      scheduled_anchor_at, claimed_at, claim_sequence, queue_event_id, updated_at
    )
    SELECT ${claim.claimId}::uuid, ${claim.automationId}::uuid, ${claim.orgId},
      ${claim.ownerUserId}, ${claim.workflowId}::uuid, ${claim.scheduledAnchorAt},
      ${claim.claimedAt}, coalesce((SELECT claim_sequence
        FROM morning_brief_schedule_claims
        WHERE automation_id = ${claim.automationId}::uuid
        ORDER BY claim_sequence DESC LIMIT 1), 0) + 1,
      ${queueEventId}::uuid, ${admittedAt}
    WHERE ${eligibility ?? sql`true`}
    RETURNING id
  `;
}
