import { settle } from "../utils";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import {
  googleFormsAutomationCursors,
  googleFormsProcessedEvents,
  googleFormsWatchStates,
} from "@okouai/db/schema/google-forms-event";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";

import { nowDate } from "../../lib/time";

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
function googleFormsQueueAdmissionSql(source: GoogleFormsQueueSource) {
  return sql`SELECT 1 WHERE EXISTS (
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
    )`;
}

/** The input, source receipt, cursor and queue record have one local owner. */

export async function persistGoogleFormsWorkflowSource(
  tx: Tx,
  args: {
    readonly chatThreadId: string;
    readonly automationId: string;
    readonly source: GoogleFormsQueueSource;
  },
  signal: AbortSignal,
): Promise<void> {
  const transitioned = await settle(
    (async () => {
      const { source } = args;
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
        (await tx.execute(googleFormsQueueAdmissionSql(source))).rowCount === 0
      ) {
        throw new GoogleFormsSourceTransitionChangedError();
      }
      signal.throwIfAborted();
    })(),
    signal,
  );
  signal.throwIfAborted();
  if (!transitioned.ok) {
    if (isForeignKeyViolation(transitioned.error)) {
      throw new GoogleFormsSourceTransitionChangedError();
    }
    throw transitioned.error;
  }
}
