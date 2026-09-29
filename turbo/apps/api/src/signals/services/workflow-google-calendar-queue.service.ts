import { connectors } from "@okouai/db/schema/connector";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { googleCalendarWatchStates } from "@okouai/db/schema/google-calendar-event";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { builtinConnectorStateLockStatement } from "./auth-state-lock.service";
import {
  appendCanonicalChatEventsSql,
  chatEventAppendResultSchema,
} from "./chat-event-append.service";
import type { PreparedWorkflowAutomationQueueInput } from "./workflow-chat-event-queue.service";

export interface GoogleCalendarQueueSource {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly automationId: string;
  readonly watchStateId: string;
  readonly calendarId: string;
  readonly channelId: string;
}

export class GoogleCalendarSourceTransitionChangedError extends Error {
  constructor() {
    super("Google Calendar source changed before durable queue admission");
    this.name = "GoogleCalendarSourceTransitionChangedError";
  }
}

function googleCalendarQueueAutomationCondition(
  source: GoogleCalendarQueueSource,
) {
  return and(
    eq(workflowAutomations.id, source.automationId),
    eq(workflowAutomations.orgId, source.orgId),
    eq(workflowAutomations.ownerUserId, source.userId),
    eq(workflowAutomations.kind, "event"),
    inArray(workflowAutomations.eventType, [
      "google-calendar-event-created",
      "google-calendar-event-updated",
      "google-calendar-event-cancelled",
    ]),
    eq(workflowAutomations.enabled, true),
    eq(workflowAutomations.eventConnectorId, source.connectorId),
    eq(
      sql`${workflowAutomations.eventConfig} ->> 'calendarId'`,
      source.calendarId,
    ),
  );
}

/** Authorize the current channel and consumer in the local queue transaction. */
export const enqueueGoogleCalendarWorkflowInput$ = command(
  async (
    { set },
    args: {
      readonly input: PreparedWorkflowAutomationQueueInput;
      readonly source: GoogleCalendarQueueSource;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const { input, source } = args;
    if (
      input.context.automationId !== source.automationId ||
      input.context.connectorSourceId !== source.connectorId
    ) {
      throw new Error(
        "Google Calendar input does not match its delivery source",
      );
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
          connectorSlug: "google-calendar",
        }),
      );
      const [state] = await tx
        .select({ id: googleCalendarWatchStates.id })
        .from(googleCalendarWatchStates)
        .innerJoin(
          connectors,
          eq(connectors.id, googleCalendarWatchStates.connectorId),
        )
        .where(
          and(
            eq(connectors.orgId, source.orgId),
            eq(connectors.userId, source.userId),
            eq(connectors.connectorSlug, "google-calendar"),
            eq(connectors.needsReconnect, false),
            eq(googleCalendarWatchStates.id, source.watchStateId),
            eq(googleCalendarWatchStates.orgId, source.orgId),
            eq(googleCalendarWatchStates.userId, source.userId),
            eq(googleCalendarWatchStates.connectorId, source.connectorId),
            eq(googleCalendarWatchStates.calendarId, source.calendarId),
            eq(googleCalendarWatchStates.channelId, source.channelId),
            isNull(googleCalendarWatchStates.actionRequiredReason),
            isNull(googleCalendarWatchStates.actionRequiredAt),
          ),
        )
        .for("share")
        .limit(1);
      const [automation] = await tx
        .select({ id: workflowAutomations.id })
        .from(workflowAutomations)
        .where(googleCalendarQueueAutomationCondition(source))
        .for("update")
        .limit(1);
      signal.throwIfAborted();
      if (!state || !automation) {
        throw new GoogleCalendarSourceTransitionChangedError();
      }
      const currentTime = nowDate();
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
