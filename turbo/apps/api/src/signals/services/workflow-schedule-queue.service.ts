import { morningBriefNativeSchedules } from "@okouai/db/schema/morning-brief-native-schedule";
import { sql } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import {
  morningBriefScheduleWhere,
  type MorningBriefNativeScheduleRow,
} from "./morning-brief-native-schedule.service";
import { SCHEDULE_GRACE_MS } from "./schedule-expiry-policy";
import {
  ScheduleOccurrenceUnavailableError,
  type WorkflowScheduleClaimPlan,
} from "./workflow-automation-enqueue.service";

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

/**
 * Consume the exact due anchor with one conditional UPDATE.
 *
 * A selected Morning Brief first consumes the durable legacy-owned anchor on
 * its native row, then the automation row; that is the documented native ->
 * automation order, taken here by the writes themselves rather than by row
 * locks. Both predicates are re-checked against the current row versions, so a
 * concurrent claim, expiry, toggle or settlement that moved the anchor makes
 * this statement return no row.
 */
function consumeWorkflowScheduleAnchorSql(
  claim: WorkflowScheduleClaimPlan,
  native: MorningBriefNativeScheduleRow | undefined,
  admittedAt: Date,
) {
  const selected =
    native?.legacyWorkflowId === claim.workflowId &&
    native?.legacyAutomationId === claim.automationId;
  const consumeNative = selected
    ? sql`UPDATE morning_brief_native_schedules SET next_run_at = NULL,
        schedule_owner = NULL, updated_at = ${claim.claimedAt}
      WHERE org_id = ${claim.orgId} AND user_id = ${claim.ownerUserId}
        AND owner_epoch = ${native.ownerEpoch} AND phase = 'legacy'
        AND enabled AND schedule_owner = 'legacy'
        AND next_run_at = ${claim.scheduledAnchorAt}
        AND legacy_workflow_id = ${claim.workflowId}::uuid
        AND legacy_automation_id = ${claim.automationId}::uuid
      RETURNING owner_epoch`
    : sql`SELECT 1 WHERE false`;
  const nativeGuard = selected
    ? sql`AND EXISTS (SELECT 1 FROM consumed)`
    : sql.empty();
  return sql`
    WITH consumed AS (${consumeNative})
    UPDATE workflow_automations SET next_run_at = NULL,
      last_run_at = ${claim.claimedAt}, updated_at = ${claim.claimedAt}
    WHERE id = ${claim.automationId}::uuid
      AND enabled AND org_id = ${claim.orgId} AND owner_user_id = ${claim.ownerUserId}
      AND workflow_id = ${claim.workflowId}::uuid
      AND next_run_at = ${claim.scheduledAnchorAt}
      AND next_run_at >= ${new Date(admittedAt.getTime() - SCHEDULE_GRACE_MS)}
      ${nativeGuard}
    RETURNING id
  `;
}

/**
 * Journal the consumed occurrence; its queue event is bound immediately.
 *
 * Runs after this transaction's own anchor-consuming UPDATE, so no other
 * claim for this automation can be in flight and the next sequence is read
 * from a snapshot that includes every committed claim.
 */
function journalWorkflowScheduleClaimSql(
  claim: WorkflowScheduleClaimPlan,
  queueEventId: string,
  admittedAt: Date,
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
  `;
}

export async function persistWorkflowScheduleOccurrence(
  tx: Tx,
  claim: WorkflowScheduleClaimPlan,
  eventId: string,
): Promise<void> {
  const [native] = await tx
    .select()
    .from(morningBriefNativeSchedules)
    .where(
      morningBriefScheduleWhere({
        orgId: claim.orgId,
        userId: claim.ownerUserId,
      }),
    )
    .limit(1);
  const admittedAt = nowDate();
  if (
    (
      await tx.execute(
        consumeWorkflowScheduleAnchorSql(claim, native, admittedAt),
      )
    ).rowCount !== 1
  ) {
    throw new ScheduleOccurrenceUnavailableError();
  }
  if (
    (
      await tx.execute(
        journalWorkflowScheduleClaimSql(claim, eventId, admittedAt),
      )
    ).rowCount !== 1
  ) {
    throw new Error("Morning Brief schedule claim was not journaled");
  }
}
