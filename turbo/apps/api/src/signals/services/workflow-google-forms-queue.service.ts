import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import {
  googleFormsAutomationCursors,
  googleFormsProcessedEvents,
  googleFormsWatchStates,
} from "@okouai/db/schema/google-forms-event";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { parseRawRows } from "../../lib/db-raw-rows";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { settle } from "../utils";
import { writeDb$ } from "../external/db";
import {
  appendCanonicalChatEventsSql,
  chatEventAppendResultSchema,
} from "./chat-event-append.service";
import type { PreparedWorkflowAutomationQueueInput } from "./workflow-chat-event-queue.service";

export interface GoogleFormsQueueSource {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly automationId: string;
  readonly watchStateId: string;
  readonly formId: string;
  readonly watchId: string;
  readonly pubsubMessageId: string;
  readonly responseId: string;
  readonly lastSubmittedTime: string;
  readonly cursor: string;
}

export class GoogleFormsSourceTransitionChangedError extends Error {
  constructor() {
    super("Google Forms source changed before durable queue admission");
    this.name = "GoogleFormsSourceTransitionChangedError";
  }
}

function googleFormsQueueAutomationCondition(source: GoogleFormsQueueSource) {
  return and(
    eq(workflowAutomations.id, source.automationId),
    eq(workflowAutomations.orgId, source.orgId),
    eq(workflowAutomations.ownerUserId, source.userId),
    eq(workflowAutomations.kind, "event"),
    eq(workflowAutomations.eventType, "google-forms-response-submitted"),
    eq(workflowAutomations.enabled, true),
    eq(workflowAutomations.eventConnectorId, source.connectorId),
    sql`${workflowAutomations.eventConfig} ->> 'connectorId' = ${source.connectorId}`,
    sql`${workflowAutomations.eventConfig} -> 'form' ->> 'id' = ${source.formId}`,
  );
}

/** Queue admission gated by the current consumer and watch rows. */
function googleFormsQueueAdmissionSql(
  source: GoogleFormsQueueSource,
  chatThreadId: string,
  currentTime: Date,
) {
  const timestamp = sql`${currentTime.toISOString()}::timestamp`;
  return sql`INSERT INTO ${queuedChatThreads} (chat_thread_id, org_id, queued_at)
    SELECT ${chatThreadId}::uuid, ${source.orgId}, ${timestamp}
    WHERE EXISTS (
      SELECT 1 FROM ${workflowAutomations}
      WHERE ${googleFormsQueueAutomationCondition(source)}
    )
    AND EXISTS (
      SELECT 1 FROM ${googleFormsWatchStates}
      WHERE ${and(
        eq(googleFormsWatchStates.id, source.watchStateId),
        eq(googleFormsWatchStates.orgId, source.orgId),
        eq(googleFormsWatchStates.userId, source.userId),
        eq(googleFormsWatchStates.connectorId, source.connectorId),
        eq(googleFormsWatchStates.formId, source.formId),
        eq(googleFormsWatchStates.watchId, source.watchId),
      )}
    )
    ON CONFLICT (chat_thread_id) DO UPDATE SET claim_id = NULL, claim_expires_at = NULL`;
}

/** The input, source receipt, cursor and queue record have one local owner. */
export const enqueueGoogleFormsWorkflowInput$ = command(
  async (
    { set },
    args: {
      readonly input: PreparedWorkflowAutomationQueueInput;
      readonly source: GoogleFormsQueueSource;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const { input, source } = args;
    if (
      input.context.automationId !== source.automationId ||
      input.context.connectorSourceId !== source.connectorId
    ) {
      throw new Error("Google Forms input does not match its delivery source");
    }
    // The receipt's FKs to the watch state and automation are the implicit
    // protection against a concurrent removal; losing that race is the same
    // deterministic source-changed outcome, not a 500.
    const admitted = await settle(
      db.transaction(async (tx) => {
        // Append first; a rejected source rolls the append and its sequence
        // reservation back.
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
        // No source rows are locked. The receipt insert dedupes the response,
        // the cursor advance is a compare-and-set on the observed cursor, and
        // the queue record is admitted only while the consumer and watch are
        // current. Any zero-row step rolls the whole admission back. A
        // disable/removal racing these statements may still admit one event,
        // which dispatch re-checks.
        const cursorCondition = and(
          eq(googleFormsAutomationCursors.automationId, source.automationId),
          eq(googleFormsAutomationCursors.watchStateId, source.watchStateId),
          eq(googleFormsAutomationCursors.lastSeenSubmittedTime, source.cursor),
        );
        signal.throwIfAborted();
        const currentTime = nowDate();
        const [processed] = await tx
          .insert(googleFormsProcessedEvents)
          .values({
            watchStateId: source.watchStateId,
            automationId: source.automationId,
            pubsubMessageId: source.pubsubMessageId,
            responseId: source.responseId,
            lastSubmittedTime: source.lastSubmittedTime,
            createdAt: currentTime,
          })
          .onConflictDoNothing()
          .returning({ id: googleFormsProcessedEvents.id });
        if (!processed) {
          throw new GoogleFormsSourceTransitionChangedError();
        }
        const [advanced] = await tx
          .update(googleFormsAutomationCursors)
          .set({
            lastSeenSubmittedTime: source.lastSubmittedTime,
            updatedAt: currentTime,
          })
          .where(cursorCondition)
          .returning({
            automationId: googleFormsAutomationCursors.automationId,
          });
        if (!advanced) {
          throw new GoogleFormsSourceTransitionChangedError();
        }
        if (
          (
            await tx.execute(
              googleFormsQueueAdmissionSql(
                source,
                input.event.chatThreadId,
                currentTime,
              ),
            )
          ).rowCount === 0
        ) {
          throw new GoogleFormsSourceTransitionChangedError();
        }
        signal.throwIfAborted();
        return event.id;
      }),
      signal,
    );
    if (admitted.ok) {
      return admitted.value;
    }
    if (isForeignKeyViolation(admitted.error)) {
      throw new GoogleFormsSourceTransitionChangedError();
    }
    throw admitted.error;
  },
);
