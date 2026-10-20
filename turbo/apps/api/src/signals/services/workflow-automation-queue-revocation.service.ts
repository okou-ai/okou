import { agents } from "@okouai/db/schema/agent";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import {
  chatEvents,
  chatEventRunlessInputPredicate,
} from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { command } from "ccstate";
import { and, asc, eq, notExists } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { parseRawRows } from "../../lib/db-raw-rows";
import { writeDb$ } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { canonicalChatInputModelSelection } from "./canonical-chat-event-read.service";
import { chatEventCommandResultSchema } from "./chat-event-append.service";
import { chatEventReplacementInsertSql } from "./chat-event.service";

/** Deletion retires pending inputs; a winning run claim keeps its provenance. */
export const revokeDeletedWorkflowAutomationInputs$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly automationId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const database = set(writeDb$);
    const revoker = alias(chatEvents, "deleted_automation_input_revoker");
    const sources = await database
      .select({
        id: chatEvents.id,
        chatThreadId: chatEvents.chatThreadId,
        createdAt: chatEvents.createdAt,
        eventType: chatEvents.eventType,
        contextType: chatEvents.contextType,
        contextId: chatEvents.contextId,
        modelSelection: canonicalChatInputModelSelection(),
        userId: chatThreads.userId,
      })
      .from(chatEvents)
      .innerJoin(
        chatAutomationContext,
        eq(chatAutomationContext.id, chatEvents.contextId),
      )
      .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(
        and(
          eq(agents.orgId, args.orgId),
          eq(chatEvents.contextType, "automation"),
          eq(chatEvents.eventType, "input.automation"),
          chatEventRunlessInputPredicate(
            chatEvents.runId,
            chatEvents.eventType,
          ),
          eq(chatAutomationContext.automationId, args.automationId),
          notExists(
            new QueryBuilder()
              .select({ id: workflowAutomations.id })
              .from(workflowAutomations)
              .where(eq(workflowAutomations.id, args.automationId)),
          ),
          notExists(
            new QueryBuilder()
              .select({ id: revoker.id })
              .from(revoker)
              .where(eq(revoker.revokesEventId, chatEvents.id)),
          ),
        ),
      )
      .orderBy(asc(chatEvents.chatThreadId), asc(chatEvents.seqId));
    signal.throwIfAborted();
    const changedThreads = new Map<string, string>();
    for (const source of sources) {
      // The unique revoke edge arbitrates against a concurrent run claim.
      const revoked = parseRawRows(
        chatEventCommandResultSchema,
        await database.execute(
          chatEventReplacementInsertSql(source, {
            chatThreadId: source.chatThreadId,
            eventType: "control.revoke",
            runId: null,
          }),
        ),
      );
      signal.throwIfAborted();
      if (revoked.length > 0) {
        changedThreads.set(source.chatThreadId, source.userId);
      }
    }
    for (const [threadId, userId] of changedThreads) {
      await publishChatThreadMessageCreatedSafely({
        orgId: args.orgId,
        userId,
        threadId,
      });
      signal.throwIfAborted();
    }
  },
);
