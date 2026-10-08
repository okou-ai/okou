import {
  googleFormsAutomationCursors,
  googleFormsProcessedEvents,
  googleFormsWatchStates,
} from "@okouai/db/schema/google-forms-event";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq, sql } from "drizzle-orm";

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

function googleFormsQueueAdmissionSql(source: GoogleFormsQueueSource) {
  return sql`SELECT 1 WHERE EXISTS (
      SELECT 1 FROM ${workflowAutomations}
      WHERE ${and(
        eq(workflowAutomations.id, source.automationId),
        eq(workflowAutomations.orgId, source.orgId),
        eq(workflowAutomations.ownerUserId, source.userId),
        eq(workflowAutomations.kind, "event"),
        eq(workflowAutomations.eventType, "google-forms-response-submitted"),
        eq(workflowAutomations.enabled, true),
        eq(workflowAutomations.eventConnectorId, source.connectorId),
        sql`${workflowAutomations.eventConfig} ->> 'connectorId' = ${source.connectorId}`,
        sql`${workflowAutomations.eventConfig} -> 'form' ->> 'id' = ${source.formId}`,
      )}
    ) AND EXISTS (
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

/** The owner's transaction rolls back the receipt if cursor/authority loses. */
export function googleFormsQueueReceiptSql(
  source: GoogleFormsQueueSource,
  currentTime: Date,
) {
  const timestamp = currentTime.toISOString();
  return sql`WITH processed AS (
    INSERT INTO ${googleFormsProcessedEvents} (watch_state_id, automation_id, pubsub_message_id, response_id, last_submitted_time, created_at)
    VALUES (${source.watchStateId}::uuid, ${source.automationId}::uuid, ${source.pubsubMessageId}, ${source.responseId}, ${source.lastSubmittedTime}, ${timestamp}::timestamp)
    ON CONFLICT DO NOTHING RETURNING id
  ) UPDATE ${googleFormsAutomationCursors}
    SET last_seen_submitted_time = ${source.lastSubmittedTime}, updated_at = ${timestamp}::timestamp
    WHERE ${and(
      eq(googleFormsAutomationCursors.automationId, source.automationId),
      eq(googleFormsAutomationCursors.watchStateId, source.watchStateId),
      eq(googleFormsAutomationCursors.lastSeenSubmittedTime, source.cursor),
    )} AND EXISTS (SELECT 1 FROM processed)
      AND EXISTS (${googleFormsQueueAdmissionSql(source)})
    RETURNING automation_id`;
}
