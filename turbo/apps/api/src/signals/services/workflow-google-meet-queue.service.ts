import { googleWorkspaceEventSubscriptionStates } from "@okouai/db/schema/google-workspace-event";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";

export interface GoogleMeetQueueSource {
  readonly automationId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorSourceId: string;
  readonly subscriptionStateId: string;
  readonly subscriptionName: string;
}

export class GoogleMeetAutomationSourceChangedError extends Error {
  constructor() {
    super(
      "Google Meet automation source changed before durable queue admission",
    );
    this.name = "GoogleMeetAutomationSourceChangedError";
  }
}

/** Queue admission gated by the current consumer and subscription rows. */
function googleMeetQueueAdmissionSql(source: GoogleMeetQueueSource) {
  return sql`SELECT 1 WHERE EXISTS (
      SELECT 1 FROM ${workflowAutomations}
      WHERE ${and(
        eq(workflowAutomations.id, source.automationId),
        eq(workflowAutomations.orgId, source.orgId),
        eq(workflowAutomations.ownerUserId, source.userId),
        eq(workflowAutomations.enabled, true),
        eq(workflowAutomations.kind, "event"),
        eq(workflowAutomations.eventType, "google-meet-transcript-generated"),
        eq(workflowAutomations.eventConnectorId, source.connectorSourceId),
      )}
    )
    AND EXISTS (
      SELECT 1 FROM ${googleWorkspaceEventSubscriptionStates}
      WHERE ${and(
        eq(
          googleWorkspaceEventSubscriptionStates.id,
          source.subscriptionStateId,
        ),
        eq(
          googleWorkspaceEventSubscriptionStates.subscriptionName,
          source.subscriptionName,
        ),
        eq(
          googleWorkspaceEventSubscriptionStates.connectorId,
          source.connectorSourceId,
        ),
        eq(googleWorkspaceEventSubscriptionStates.provider, "google-meet"),
      )}
    )`;
}

export async function persistGoogleMeetWorkflowSource(
  tx: Tx,
  args: {
    readonly chatThreadId: string;
    readonly automationId: string;
    readonly source: GoogleMeetQueueSource;
  },
  signal: AbortSignal,
): Promise<void> {
  const { source } = args;
  if ((await tx.execute(googleMeetQueueAdmissionSql(source))).rowCount === 0) {
    throw new GoogleMeetAutomationSourceChangedError();
  }
  signal.throwIfAborted();
}
