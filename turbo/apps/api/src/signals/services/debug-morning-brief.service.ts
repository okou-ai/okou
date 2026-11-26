import type { DebugMorningBriefResponse } from "@okouai/api-contracts/contracts/debug-morning-brief";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { computed, type Computed } from "ccstate";
import { and, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db$ } from "../external/db";
interface Owner {
  readonly orgId: string;
  readonly userId: string;
}

export function createDebugMorningBriefReceipt(
  owner$: Computed<Owner>,
  requestId$: Computed<string | Promise<string>>,
) {
  const receipt$ = computed(
    async (get): Promise<DebugMorningBriefResponse | null> => {
      const owner = get(owner$);
      const requestId = await get(requestId$);
      const revoker = alias(chatEvents, "debug_brief_revoker");
      const [row] = await get(db$)
        .select({
          chatThreadId: chatThreads.id,
          runId: chatEvents.runId,
          runStatus: agentRuns.status,
          eventType: chatEvents.eventType,
          revokedBy: revoker.id,
        })
        .from(chatAutomationContext)
        .innerJoin(
          chatThreads,
          eq(chatThreads.id, chatAutomationContext.chatThreadId),
        )
        .innerJoin(
          chatEvents,
          and(
            eq(chatEvents.contextId, chatAutomationContext.id),
            eq(chatEvents.contextType, "automation"),
            inArray(chatEvents.eventType, [
              "input.automation",
              "input.prompt",
              "input.rejected",
            ]),
          ),
        )
        .leftJoin(agentRuns, eq(agentRuns.id, chatEvents.runId))
        .leftJoin(revoker, eq(revoker.revokesEventId, chatEvents.id))
        .where(
          and(
            eq(chatAutomationContext.id, requestId),
            eq(chatAutomationContext.eventType, "morning-brief-debug"),
            eq(chatThreads.userId, owner.userId),
            eq(chatThreads.orgId, owner.orgId),
          ),
        )
        .orderBy(desc(chatEvents.seqId))
        .limit(1);
      if (!row) {
        return null;
      }
      const status =
        row.eventType === "input.rejected" ||
        (row.runId === null && row.revokedBy !== null)
          ? "failed"
          : row.runStatus === "completed"
            ? "completed"
            : row.runStatus === "failed" ||
                row.runStatus === "cancelled" ||
                row.runStatus === "timeout"
              ? "failed"
              : row.runId === null ||
                  row.runStatus === "pending" ||
                  row.runStatus === "queued"
                ? "queued"
                : "running";
      return {
        requestId,
        chatThreadId: row.chatThreadId,
        runId: row.runId,
        status,
      };
    },
  );

  return receipt$;
}
