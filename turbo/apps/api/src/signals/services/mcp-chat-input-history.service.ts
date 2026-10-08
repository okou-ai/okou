import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import type { McpGetChatInputInput } from "@okouai/api-contracts/contracts/mcp-chat-input";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { command } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";
import { writeDb$ } from "../external/db";
import { awaitWithSignal, settleIncludingAbort } from "../utils";
import { chatEventRowFromDbRow } from "./cron-snapshot-chat-events.service";
import {
  addHistorySize,
  chatEventHistoryBytes,
  historyReadFailure,
  McpMessageHistoryError,
  type HistoryBudget,
} from "./mcp-chat-message-history.service";

type InputHistorySelection =
  | { readonly kind: "canonical" }
  | {
      readonly kind: "selected";
      readonly rows: readonly ChatEventRow[] | null;
    };

const inputMetadata = Object.freeze({
  id: chatEvents.id,
  revokesEventId: chatEvents.revokesEventId,
  bytes: chatEventHistoryBytes,
});
const inputRows = Object.freeze({
  id: chatEvents.id,
  chatThreadId: chatEvents.chatThreadId,
  runId: chatEvents.runId,
  revokesEventId: chatEvents.revokesEventId,
  eventType: chatEvents.eventType,
  payload: chatEvents.payload,
  failureReason: chatEvents.failureReason,
  contextType: chatEvents.contextType,
  contextId: chatEvents.contextId,
  runEventSequenceNumber: chatEvents.runEventSequenceNumber,
  runEventId: chatEvents.runEventId,
  seqId: chatEvents.seqId,
  createdAt: chatEvents.createdAt,
});

/**
 * No archive is the eligibility proof, not just origin > archive watermark.
 * Retention requires archive coverage; with no archive in this snapshot, live
 * primary/revoke keys establish complete identities and relevant edges. Once an
 * archive exists, caller-owned Web IDs may have been reused after retention.
 */
const readUnarchivedInputSnapshot$ = command(
  async (
    { set },
    principal: { readonly userId: string; readonly orgId: string },
    input: McpGetChatInputInput,
    budget: HistoryBudget,
    signal: AbortSignal,
  ): Promise<InputHistorySelection> => {
    return await awaitWithSignal(
      set(writeDb$).transaction(
        async (tx): Promise<InputHistorySelection> => {
          budget.check();
          await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
          const [owned] = await tx
            .select({ id: chatThreads.id })
            .from(chatThreads)
            .innerJoin(agents, eq(agents.id, chatThreads.agentId))
            .where(
              and(
                eq(chatThreads.id, input.threadId),
                eq(chatThreads.userId, principal.userId),
                eq(agents.orgId, principal.orgId),
              ),
            )
            .limit(1);
          budget.check();
          if (!owned) {
            return { kind: "selected", rows: null };
          }
          const [archive] = await tx
            .select({ id: chatEventSnapshots.id })
            .from(chatEventSnapshots)
            .where(eq(chatEventSnapshots.chatThreadId, input.threadId))
            .limit(1);
          budget.check();
          if (archive) {
            return { kind: "canonical" };
          }
          const [origin] = await tx
            .select(inputMetadata)
            .from(chatEvents)
            .where(
              and(
                eq(chatEvents.chatThreadId, input.threadId),
                eq(chatEvents.id, input.eventId),
              ),
            )
            .limit(1);
          budget.check();
          if (!origin) {
            // A miss is never evidence of absence, including retention races.
            return { kind: "canonical" };
          }
          addHistorySize(budget, origin.bytes, 1);
          const visited = new Set([origin.id]);
          if (origin.revokesEventId !== null) {
            const [predecessor] = await tx
              .select(inputMetadata)
              .from(chatEvents)
              .where(
                and(
                  eq(chatEvents.chatThreadId, input.threadId),
                  eq(chatEvents.id, origin.revokesEventId),
                ),
              )
              .limit(1);
            budget.check();
            if (!predecessor) {
              throw new McpMessageHistoryError(
                "history_unavailable",
                "Chat input origin cannot be resolved completely.",
              );
            }
            addHistorySize(budget, predecessor.bytes, 1);
            visited.add(predecessor.id);
          }
          let currentId = origin.id;
          for (;;) {
            budget.check();
            const [successor] = await tx
              .select(inputMetadata)
              .from(chatEvents)
              .where(
                and(
                  eq(chatEvents.chatThreadId, input.threadId),
                  eq(chatEvents.revokesEventId, currentId),
                ),
              )
              .limit(1);
            budget.check();
            if (!successor) {
              break;
            }
            if (visited.has(successor.id)) {
              throw new McpMessageHistoryError(
                "history_unavailable",
                "Chat input replacement chain is invalid.",
              );
            }
            addHistorySize(budget, successor.bytes, 1);
            visited.add(successor.id);
            currentId = successor.id;
          }
          const rows = await tx
            .select(inputRows)
            .from(chatEvents)
            .where(
              and(
                eq(chatEvents.chatThreadId, input.threadId),
                inArray(chatEvents.id, [...visited]),
              ),
            );
          budget.check();
          if (rows.length !== visited.size) {
            throw new McpMessageHistoryError(
              "history_unavailable",
              "Chat input facts changed inside their read snapshot.",
            );
          }
          return {
            kind: "selected",
            rows: rows.map(chatEventRowFromDbRow),
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      ),
      signal,
    );
  },
);

/** Normalize read failures without turning them into canonical-reader retries. */
export const readUnarchivedMcpChatInput$ = command(
  async (
    { set },
    principal: { readonly userId: string; readonly orgId: string },
    input: McpGetChatInputInput,
    budget: HistoryBudget,
    signal: AbortSignal,
  ): Promise<InputHistorySelection> => {
    const result = await settleIncludingAbort(
      set(readUnarchivedInputSnapshot$, principal, input, budget, signal),
    );
    signal.throwIfAborted();
    budget.check();
    if (!result.ok) {
      throw historyReadFailure(result.error);
    }
    return result.value;
  },
);
