import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { morningBriefNativeSchedules } from "@okouai/db/schema/morning-brief-native-schedule";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { command } from "ccstate";
import { sql } from "drizzle-orm";
import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settleIncludingAbort } from "../utils";
import {
  appendCanonicalChatEventsSql,
  chatEventAppendResultSchema,
} from "./chat-event-append.service";
import {
  ScheduleOccurrenceUnavailableError,
  type PreparedWorkflowAutomationQueueInput,
  type WorkflowScheduleClaimPlan,
} from "./workflow-chat-event-queue.service";
import {
  morningBriefScheduleWhere,
  type MorningBriefNativeScheduleRow,
} from "./morning-brief-native-schedule.service";
import { SCHEDULE_GRACE_MS } from "./schedule-expiry-policy";

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
    native.legacyAutomationId === claim.automationId;
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

/** Coalesce only this automation's run-less schedule inputs; manual input stays distinct. */
function revokePendingWorkflowTicksSql(
  input: PreparedWorkflowAutomationQueueInput,
  admittedAt: Date,
) {
  return sql`
    WITH pending AS MATERIALIZED (
      SELECT event.id, event.chat_thread_id, event.created_at, event.seq_id,
        event.context_type, event.context_id
      FROM chat_events event JOIN chat_automation_context context ON context.id = event.context_id
      WHERE event.chat_thread_id = ${input.event.chatThreadId}::uuid
        AND event.event_type = 'input.automation' AND event.run_id IS NULL
        AND event.context_type = 'automation'
        AND context.automation_id = ${input.context.automationId}::uuid
        AND context.event_type IS DISTINCT FROM 'manual'
        AND event.id <> ${input.event.id}::uuid
        AND NOT EXISTS (SELECT 1 FROM chat_events revoked WHERE revoked.revokes_event_id = event.id)
    ), reserved AS (
      INSERT INTO chat_event_sequences (chat_thread_id, last_seq_id)
      SELECT chat_thread_id, count(*) FROM pending GROUP BY chat_thread_id
      ON CONFLICT (chat_thread_id) DO UPDATE
        SET last_seq_id = chat_event_sequences.last_seq_id + EXCLUDED.last_seq_id
      RETURNING chat_thread_id, last_seq_id
    ) INSERT INTO chat_events (id, chat_thread_id, run_id, revokes_event_id,
        event_type, payload, context_type, context_id, seq_id, created_at)
      SELECT gen_random_uuid(), pending.chat_thread_id, NULL, pending.id,
        'control.revoke', NULL, pending.context_type, pending.context_id,
        reserved.last_seq_id - count(*) OVER () + row_number() OVER (ORDER BY pending.seq_id),
        greatest(${admittedAt}::timestamp, pending.created_at + interval '1 millisecond')
      FROM pending JOIN reserved USING (chat_thread_id)
      ORDER BY pending.seq_id ON CONFLICT DO NOTHING
  `;
}

/** Schedule occurrence, input and queue wake-up are one local SQL operation. */
export const enqueueWorkflowScheduleInput$ = command(
  async (
    { set },
    args: {
      readonly input: PreparedWorkflowAutomationQueueInput;
      readonly orgId: string;
      readonly scheduleClaim?: WorkflowScheduleClaimPlan;
      readonly replacePendingTicks: boolean;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const { input, scheduleClaim } = args;
    let claimCreated = false;
    const result = await settleIncludingAbort(
      db.transaction(async (tx) => {
        await tx
          .insert(chatAutomationContext)
          .values(input.context)
          .onConflictDoNothing();
        const [event] = parseRawRows(
          chatEventAppendResultSchema,
          await tx.execute(
            appendCanonicalChatEventsSql([input.event], input.conflict),
          ),
        );
        if (!event) {
          if (input.conflict === "none") {
            throw new Error("Workflow queue event insert returned no row");
          }
          return null;
        }
        if (scheduleClaim) {
          const owner = {
            orgId: scheduleClaim.orgId,
            userId: scheduleClaim.ownerUserId,
          };
          // A plain read classifies the owner; no absent-owner key is taken.
          const [native] = await tx
            .select()
            .from(morningBriefNativeSchedules)
            .where(morningBriefScheduleWhere(owner))
            .limit(1);
          const admittedAt = nowDate();
          const { rowCount: consumed } = await tx.execute(
            consumeWorkflowScheduleAnchorSql(scheduleClaim, native, admittedAt),
          );
          if (consumed !== 1) {
            throw new ScheduleOccurrenceUnavailableError();
          }
          const { rowCount } = await tx.execute(
            journalWorkflowScheduleClaimSql(
              scheduleClaim,
              event.id,
              admittedAt,
            ),
          );
          if (rowCount !== 1) {
            throw new Error("Morning Brief schedule claim was not journaled");
          }
          claimCreated = true;
        }
        if (args.replacePendingTicks) {
          await tx.execute(revokePendingWorkflowTicksSql(input, nowDate()));
        }
        await tx
          .insert(queuedChatThreads)
          .values({
            chatThreadId: input.event.chatThreadId,
            orgId: args.orgId,
            queuedAt: nowDate(),
          })
          .onConflictDoUpdate({
            target: queuedChatThreads.chatThreadId,
            set: { claimId: null, claimExpiresAt: null },
          });
        signal.throwIfAborted();
        return event.id;
      }),
    );
    signal.throwIfAborted();
    if (!result.ok) {
      if (
        result.error instanceof ScheduleOccurrenceUnavailableError ||
        !scheduleClaim ||
        !claimCreated
      ) {
        throw result.error;
      }
      throw new WorkflowScheduleAdmissionError(
        scheduleClaim.claimId,
        result.error,
      );
    }
    return result.value;
  },
);
