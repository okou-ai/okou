import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { googleWorkspaceEventSubscriptionStates } from "@okouai/db/schema/google-workspace-event";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
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
      // Row locks arbitrate this admission: account deletion (FK SET NULL),
      // disable and reprojection update the automation row; subscription
      // removal deletes the state row. Lock order: automation -> state.
      const [automation] = await tx
        .select({ id: workflowAutomations.id })
        .from(workflowAutomations)
        .where(
          and(
            eq(workflowAutomations.id, source.automationId),
            eq(workflowAutomations.orgId, source.orgId),
            eq(workflowAutomations.ownerUserId, source.userId),
            eq(workflowAutomations.enabled, true),
            eq(workflowAutomations.kind, "event"),
            eq(
              workflowAutomations.eventType,
              "google-meet-transcript-generated",
            ),
            eq(workflowAutomations.eventConnectorId, source.connectorSourceId),
          ),
        )
        .for("update")
        .limit(1);
      const [state] = await tx
        .select({ id: googleWorkspaceEventSubscriptionStates.id })
        .from(googleWorkspaceEventSubscriptionStates)
        .where(
          and(
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
          ),
        )
        .for("key share")
        .limit(1);
      if (!state || !automation) {
        throw new GoogleMeetAutomationSourceChangedError();
      }
      await tx
        .insert(queuedChatThreads)
        .values({
          chatThreadId: input.event.chatThreadId,
          orgId: source.orgId,
          queuedAt: nowDate(),
        })
        .onConflictDoUpdate({
          target: queuedChatThreads.chatThreadId,
          set: { claimId: null, claimExpiresAt: null },
        });
      signal.throwIfAborted();
      return event.id;
    });
  },
);
