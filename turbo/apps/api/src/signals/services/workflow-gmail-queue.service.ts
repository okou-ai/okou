import { connectors } from "@okouai/db/schema/connector";
import { gmailWatchStates } from "@okouai/db/schema/gmail-event";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";

export interface GmailQueueSource {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly automationId: string;
  readonly watchStateId: string;
  readonly emailAddress: string;
  readonly eventConfig: (typeof workflowAutomations.$inferSelect)["eventConfig"];
}

export class GmailAutomationSourceChangedError extends Error {
  constructor() {
    super("Gmail automation source changed before durable queue admission");
    this.name = "GmailAutomationSourceChangedError";
  }
}

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
    )`;
}

/** Publish one input only while its mailbox, account and consumer remain current. */
export async function persistGmailWorkflowSource(
  tx: Tx,
  args: {
    readonly chatThreadId: string;
    readonly automationId: string;
    readonly source: GmailQueueSource;
  },
  signal: AbortSignal,
): Promise<void> {
  const { source } = args;
  if ((await tx.execute(gmailQueueAdmissionSql(source))).rowCount === 0) {
    throw new GmailAutomationSourceChangedError();
  }
  signal.throwIfAborted();
}
