import { connectors } from "@okouai/db/schema/connector";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { gmailWatchStates } from "@okouai/db/schema/gmail-event";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";

import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { builtinConnectorStateLockStatement } from "./auth-state-lock.service";
import {
  appendCanonicalChatEventsSql,
  chatEventAppendResultSchema,
} from "./chat-event-append.service";
import type { PreparedWorkflowAutomationQueueInput } from "./workflow-chat-event-queue.service";

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

/** Publish one input only while its mailbox, account and consumer remain current. */
export const enqueueGmailWorkflowInput$ = command(
  async (
    { set },
    args: {
      readonly input: PreparedWorkflowAutomationQueueInput;
      readonly source: GmailQueueSource;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const { input, source } = args;
    if (
      input.context.automationId !== source.automationId ||
      input.context.connectorSourceId !== source.connectorId
    ) {
      throw new Error("Gmail input does not match its delivery source");
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
          connectorSlug: "gmail",
        }),
      );
      const [state] = await tx
        .select({ id: gmailWatchStates.id })
        .from(gmailWatchStates)
        .innerJoin(connectors, eq(connectors.id, gmailWatchStates.connectorId))
        .where(
          and(
            eq(connectors.orgId, source.orgId),
            eq(connectors.userId, source.userId),
            eq(connectors.connectorSlug, "gmail"),
            eq(connectors.needsReconnect, false),
            eq(gmailWatchStates.id, source.watchStateId),
            eq(gmailWatchStates.orgId, source.orgId),
            eq(gmailWatchStates.userId, source.userId),
            eq(gmailWatchStates.connectorId, source.connectorId),
            eq(
              sql`lower(${gmailWatchStates.emailAddress})`,
              source.emailAddress.trim().toLowerCase(),
            ),
          ),
        )
        .for("share")
        .limit(1);
      const [automation] = await tx
        .select({ id: workflowAutomations.id })
        .from(workflowAutomations)
        .where(gmailQueueAutomationCondition(source))
        .for("update")
        .limit(1);
      signal.throwIfAborted();
      if (!state || !automation) {
        throw new GmailAutomationSourceChangedError();
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
