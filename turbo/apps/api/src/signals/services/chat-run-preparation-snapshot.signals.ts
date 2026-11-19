import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { computed } from "ccstate";
import { and, asc, count, eq, exists, lt, not, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import { db$ } from "../external/db";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import {
  canonicalChatEventUserMessage,
  canonicalChatInputModelSelection,
} from "./canonical-chat-event-read.service";
import { queuedThreadInputCondition } from "./chat-queued-event.service";
import {
  chatThreadRequestSelection,
  type ChatThreadRequestFacts,
} from "./chat-thread-request-facts";
import { officialWorkflowThreadCondition } from "./official-workflow-policy.service";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

/** Preparation facts only: neither a connector grant nor commit-time authority. */
export interface ChatRunPreparationFacts {
  readonly isOfficialWorkflowThread: boolean;
}

function buildPreparationTables(
  claim: { readonly orgId: string; readonly chatThreadId: string },
  capacity: number,
  requestInputId: string | undefined,
) {
  const builder = new QueryBuilder();
  const occupancy = builder.$with("preparation_occupancy").as(
    builder
      .select({ activeCount: count().as("active_count") })
      .from(activeAgentRuns)
      // An unlimited context needs no active-table scan. The aggregate still
      // supplies the single envelope row when this predicate is constant false.
      .where(
        capacity === 0 ? sql`false` : eq(activeAgentRuns.orgId, claim.orgId),
      ),
  );
  // This request already validated and committed its canonical input facts.
  // Other FIFO heads still read and strictly decode their stored payload.
  const payload =
    requestInputId === undefined
      ? chatEvents.payload
      : sql`CASE WHEN ${eq(chatEvents.id, requestInputId)} THEN NULL
          ELSE ${chatEvents.payload} END`;
  const modelSelection =
    requestInputId === undefined
      ? chatEvents.modelSelection
      : sql`CASE WHEN ${eq(chatEvents.id, requestInputId)} THEN NULL
          ELSE ${chatEvents.modelSelection} END`;
  const requiredOfficialWorkflowIds =
    requestInputId === undefined
      ? chatEvents.requiredOfficialWorkflowIds
      : sql`CASE WHEN ${eq(chatEvents.id, requestInputId)} THEN NULL
          ELSE ${chatEvents.requiredOfficialWorkflowIds} END`;
  const head = builder.$with("preparation_head").as(
    builder
      .select({
        id: chatEvents.id,
        chatThreadId: chatEvents.chatThreadId,
        createdAt: chatEvents.createdAt,
        seqId: chatEvents.seqId,
        eventType: chatEvents.eventType,
        contextType: chatEvents.contextType,
        contextId: chatEvents.contextId,
        userMessage: canonicalChatEventUserMessage(payload).as("user_message"),
        requiredOfficialWorkflowIds: sql`${requiredOfficialWorkflowIds}`
          .mapWith(
            nullableDriverValueDecoder(chatEvents.requiredOfficialWorkflowIds),
          )
          .as("required_official_workflow_ids"),
        modelSelection:
          canonicalChatInputModelSelection(modelSelection).as(
            "model_selection",
          ),
        sourceAutonomyBudget: agentRuns.autonomyBudget,
      })
      .from(chatEvents)
      .leftJoin(
        agentRuns,
        and(
          eq(chatEvents.contextType, "agent_run"),
          eq(agentRuns.id, chatEvents.contextId),
        ),
      )
      .where(queuedThreadInputCondition(claim.chatThreadId))
      .orderBy(asc(chatEvents.seqId))
      .limit(1),
  );
  return { occupancy, head };
}

/** Read the FIFO head and its owned Thread in one availability statement. */
export function createChatRunPreparationSnapshot(
  claim: { readonly orgId: string; readonly chatThreadId: string },
  bootstrap: AgentRunContextSignals,
  requestFacts?: ChatThreadRequestFacts,
) {
  return computed(async (get) => {
    const database = get(db$);
    // The limit belongs to the identity context; occupancy is sampled here.
    const capacity = await get(bootstrap.concurrencyCapacity$);
    const { occupancy, head } = buildPreparationTables(
      claim,
      capacity,
      requestFacts?.input.id,
    );
    const hasCapacity =
      capacity === 0 ? sql`true` : lt(occupancy.activeCount, capacity);
    const [row] = await database
      .with(occupancy, head)
      .select({
        hasCapacity: sql`${hasCapacity}`.mapWith(pgBooleanDecoder),
        threadHasActiveRun: exists(
          new QueryBuilder()
            .select({ runId: activeAgentRuns.runId })
            .from(activeAgentRuns)
            .where(eq(activeAgentRuns.chatThreadId, claim.chatThreadId)),
        ).mapWith(pgBooleanDecoder),
        // An immediate send already owns its Thread snapshot.
        ...(requestFacts ? {} : { thread: chatThreadRequestSelection() }),
        head: {
          id: head.id,
          chatThreadId: head.chatThreadId,
          createdAt: head.createdAt,
          seqId: head.seqId,
          eventType: head.eventType,
          contextType: head.contextType,
          contextId: head.contextId,
          userMessage: head.userMessage,
          requiredOfficialWorkflowIds: head.requiredOfficialWorkflowIds,
          modelSelection: head.modelSelection,
          sourceAutonomyBudget: head.sourceAutonomyBudget,
        },
        // No head/full queues do not inspect policy; automation
        // inputs bypass the prompt-only Official thread policy as before.
        isOfficialWorkflowThread: sql`CASE WHEN ${not(hasCapacity)} THEN false
            WHEN ${eq(head.eventType, "input.prompt")} THEN ${officialWorkflowThreadCondition(
              {
                threadId: claim.chatThreadId,
                orgId: claim.orgId,
                userId: bootstrap.userId,
              },
            )} ELSE false END`.mapWith(pgBooleanDecoder),
      })
      .from(occupancy)
      .leftJoin(head, sql`true`)
      .leftJoin(
        chatThreads,
        requestFacts
          ? sql`false`
          : and(
              eq(chatThreads.id, head.chatThreadId),
              eq(chatThreads.userId, bootstrap.userId),
              eq(chatThreads.agentId, bootstrap.agentId),
            ),
      );
    if (!row) {
      throw new Error("Chat preparation occupancy returned no row");
    }
    const thread = requestFacts?.thread ?? row.thread;
    const picked = row.head;
    if (!thread || !picked) {
      return {
        hasCapacity: row.hasCapacity,
        threadHasActiveRun: row.threadHasActiveRun,
        pickedEvent: null,
      };
    }
    // Only this request's actual FIFO head may use its canonical input facts.
    const owned =
      requestFacts?.input.id === picked.id ? requestFacts.input : undefined;
    const pickedEvent: PickedThreadInputEvent = {
      ...picked,
      userMessage: owned ? owned.userMessage : picked.userMessage,
      modelSelection: owned ? owned.modelSelection : picked.modelSelection,
      requiredOfficialWorkflowIds: owned
        ? (owned.requiredOfficialWorkflowIds ?? null)
        : picked.requiredOfficialWorkflowIds,
      userId: thread.userId,
      agentId: thread.agentId,
      thread,
      preparation: {
        isOfficialWorkflowThread: row.isOfficialWorkflowThread,
      },
    };
    return {
      hasCapacity: row.hasCapacity,
      threadHasActiveRun: row.threadHasActiveRun,
      pickedEvent,
    };
  });
}
