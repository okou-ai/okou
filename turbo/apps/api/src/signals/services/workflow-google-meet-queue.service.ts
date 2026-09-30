import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { googleWorkspaceEventSubscriptionStates } from "@okouai/db/schema/google-workspace-event";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  appendCanonicalChatEventsSql,
  chatEventAppendResultSchema,
} from "./chat-event-append.service";
import type { PreparedWorkflowAutomationQueueInput } from "./workflow-chat-event-queue.service";

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
function googleMeetQueueAdmissionSql(
  source: GoogleMeetQueueSource,
  chatThreadId: string,
  currentTime: Date,
) {
  const timestamp = sql`${currentTime.toISOString()}::timestamp`;
  return sql`INSERT INTO ${queuedChatThreads} (chat_thread_id, org_id, queued_at)
    SELECT ${chatThreadId}::uuid, ${source.orgId}, ${timestamp}
    WHERE EXISTS (
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
    )
    ON CONFLICT (chat_thread_id) DO UPDATE SET claim_id = NULL, claim_expires_at = NULL`;
}

export const enqueueGoogleMeetWorkflowInput$ = command(
  async (
    { set },
    args: {
      readonly input: PreparedWorkflowAutomationQueueInput;
      readonly source: GoogleMeetQueueSource;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const { input, source } = args;
    return await db.transaction(async (tx) => {
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
      // One conditional statement admits the queue record only while the
      // consumer and subscription are current; zero rows rolls the append
      // back. A disable/removal racing this statement may still admit one
      // event, which dispatch re-checks.
      if (
        (
          await tx.execute(
            googleMeetQueueAdmissionSql(
              source,
              input.event.chatThreadId,
              nowDate(),
            ),
          )
        ).rowCount === 0
      ) {
        throw new GoogleMeetAutomationSourceChangedError();
      }
      signal.throwIfAborted();
      return event.id;
    });
  },
);
