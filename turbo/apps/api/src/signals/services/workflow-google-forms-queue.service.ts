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
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { builtinConnectorStateLockStatement } from "./auth-state-lock.service";
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
    return await db.transaction(async (tx) => {
      // Match outgoing queue writers: append first, then acquire source locks.
      // A rejected source rolls the append and its sequence reservation back.
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
      await tx.execute(
        builtinConnectorStateLockStatement({
          orgId: source.orgId,
          userId: source.userId,
          connectorSlug: "google-forms",
        }),
      );
      const [state] = await tx
        .select({ id: googleFormsWatchStates.id })
        .from(googleFormsWatchStates)
        .where(
          and(
            eq(googleFormsWatchStates.id, source.watchStateId),
            eq(googleFormsWatchStates.orgId, source.orgId),
            eq(googleFormsWatchStates.userId, source.userId),
            eq(googleFormsWatchStates.connectorId, source.connectorId),
            eq(googleFormsWatchStates.formId, source.formId),
            eq(googleFormsWatchStates.watchId, source.watchId),
          ),
        )
        .for("key share")
        .limit(1);
      const [automation] = await tx
        .select({ id: workflowAutomations.id })
        .from(workflowAutomations)
        .where(googleFormsQueueAutomationCondition(source))
        .for("update")
        .limit(1);
      const cursorCondition = and(
        eq(googleFormsAutomationCursors.automationId, source.automationId),
        eq(googleFormsAutomationCursors.watchStateId, source.watchStateId),
        eq(googleFormsAutomationCursors.lastSeenSubmittedTime, source.cursor),
      );
      const [cursor] = await tx
        .select({ automationId: googleFormsAutomationCursors.automationId })
        .from(googleFormsAutomationCursors)
        .where(cursorCondition)
        .for("update")
        .limit(1);
      signal.throwIfAborted();
      if (!state || !automation || !cursor) {
        throw new GoogleFormsSourceTransitionChangedError();
      }
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
        .returning({ automationId: googleFormsAutomationCursors.automationId });
      if (!advanced) {
        throw new GoogleFormsSourceTransitionChangedError();
      }
      await tx
        .insert(queuedChatThreads)
        .values({
          chatThreadId: input.event.chatThreadId,
          orgId: source.orgId,
          queuedAt: currentTime,
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
