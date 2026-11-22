import { connectors } from "@okouai/db/schema/connector";
import {
  gmailProcessedEvents,
  gmailWatchStates,
} from "@okouai/db/schema/gmail-event";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq, inArray, sql } from "drizzle-orm";

export interface GmailQueueSource {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly automationId: string;
  readonly watchStateId: string;
  readonly workflowId: string;
  readonly historyId: string;
  readonly messageId: string;
  readonly pubsubMessageId: string | null;
  readonly threadId: string | null;
  readonly emailAddress: string;
  readonly eventConfig: (typeof workflowAutomations.$inferSelect)["eventConfig"];
}

export class GmailAutomationSourceChangedError extends Error {
  constructor() {
    super("Gmail automation source changed before durable queue admission");
    this.name = "GmailAutomationSourceChangedError";
  }
}

export class GmailAutomationBindingChangedError extends Error {}
export class GmailAutomationAlreadyAdmittedError extends Error {}

function gmailQueueAutomationCondition(source: GmailQueueSource) {
  return and(
    eq(workflowAutomations.id, source.automationId),
    eq(workflowAutomations.orgId, source.orgId),
    eq(workflowAutomations.ownerUserId, source.userId),
    eq(workflowAutomations.kind, "event"),
    inArray(workflowAutomations.eventType, [
      "gmail-new-message",
      "gmail-label-applied",
    ]),
    eq(workflowAutomations.enabled, true),
    eq(workflowAutomations.eventConnectorId, source.connectorId),
    sql`${workflowAutomations.eventConfig} IS NOT DISTINCT FROM ${JSON.stringify(source.eventConfig)}::jsonb`,
  );
}

/** Queue admission gated by the current account, consumer and watch rows. */
function gmailQueueAdmissionSql(source: GmailQueueSource) {
  return sql`SELECT 1 WHERE EXISTS (
      SELECT 1 FROM ${connectors}
      WHERE ${and(
        eq(connectors.id, source.connectorId),
        eq(connectors.orgId, source.orgId),
        eq(connectors.userId, source.userId),
        eq(connectors.connectorSlug, "gmail"),
        eq(connectors.needsReconnect, false),
      )}
    )
    AND EXISTS (
      SELECT 1 FROM ${workflowAutomations}
      WHERE ${gmailQueueAutomationCondition(source)}
    )
    AND EXISTS (
      SELECT 1 FROM ${gmailWatchStates}
      WHERE ${and(
        eq(gmailWatchStates.id, source.watchStateId),
        eq(gmailWatchStates.orgId, source.orgId),
        eq(gmailWatchStates.userId, source.userId),
        eq(gmailWatchStates.connectorId, source.connectorId),
        eq(
          sql`lower(${gmailWatchStates.emailAddress})`,
          source.emailAddress.trim().toLowerCase(),
        ),
      )}
      FOR KEY SHARE
    )`;
}

export function gmailQueueAdmissionPlan(source: GmailQueueSource) {
  const receipt = and(
    eq(gmailProcessedEvents.watchStateId, source.watchStateId),
    eq(gmailProcessedEvents.automationId, source.automationId),
    eq(gmailProcessedEvents.historyId, source.historyId),
    eq(gmailProcessedEvents.messageId, source.messageId),
  );
  return {
    steps: [
      {
        precedingCtes: [
          sql`gmail_current_source AS MATERIALIZED (${gmailQueueAdmissionSql(source)})`,
        ],
        statement: sql`SELECT 1 FROM gmail_current_source`,
        failure: { kind: "gmail" },
      },
      {
        // Serialize durable admission with changes to the observed binding.
        precedingCtes: [
          sql`gmail_current_binding AS MATERIALIZED (
          SELECT id FROM ${workflowAutomations}
          WHERE EXISTS (SELECT 1 FROM gmail_current_source)
            AND ${gmailQueueAutomationCondition(source)}
            AND ${eq(workflowAutomations.workflowId, source.workflowId)}
          FOR SHARE
        )`,
        ],
        statement: sql`SELECT 1 FROM gmail_current_binding`,
        failure: { kind: "gmail-binding" },
      },
      {
        statement: sql`INSERT INTO ${gmailProcessedEvents}
          (watch_state_id, automation_id, pubsub_message_id, history_id, message_id, thread_id)
          SELECT ${source.watchStateId}::uuid, ${source.automationId}::uuid,
            ${source.pubsubMessageId}, ${source.historyId}, ${source.messageId}, ${source.threadId}
          FROM gmail_current_binding
          ON CONFLICT (watch_state_id, automation_id, history_id, message_id)
          DO NOTHING RETURNING id`,
        failure: { kind: "gmail-receipt" },
      },
    ],
    gmailDuplicateSql: sql`SELECT id FROM ${gmailProcessedEvents} WHERE ${receipt} LIMIT 1`,
  } as const;
}
