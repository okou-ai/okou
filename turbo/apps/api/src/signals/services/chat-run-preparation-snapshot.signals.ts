import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  chatEvents,
  chatEventRunlessInputPredicate,
} from "@okouai/db/schema/chat-event";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { computed } from "ccstate";
import {
  and,
  asc,
  count,
  eq,
  exists,
  inArray,
  isNotNull,
  lt,
  not,
  notExists,
  sql,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { array, object, string, uuid, type infer as zInfer } from "zod";

import {
  pgBooleanDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import { db$ } from "../external/db";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import {
  canonicalChatEventUserMessage,
  canonicalChatInputModelSelection,
} from "./canonical-chat-event-read.service";
import {
  chatThreadRequestSelection,
  type ChatThreadRequestFacts,
} from "./chat-thread-request-facts";
import { officialWorkflowThreadCondition } from "./official-workflow-policy.service";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

const threadSelectionRowsSchema = array(
  object({
    connectorId: uuid(),
    connectorSlug: string().nullable(),
    customConnectorId: uuid().nullable(),
  }),
);
const threadSelectionRowsDecoder = zodDriverValueDecoder(
  threadSelectionRowsSchema,
);

/** Preparation facts only: neither a connector grant nor commit-time authority. */
export interface ChatRunPreparationFacts {
  readonly isOfficialWorkflowThread: boolean;
  readonly threadConnectorSelections: zInfer<typeof threadSelectionRowsSchema>;
}

function buildPreparationTables(
  claim: { readonly orgId: string; readonly chatThreadId: string },
  capacity: number,
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
  const revoker = alias(chatEvents, "preparation_input_revoker");
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
        userMessage: canonicalChatEventUserMessage().as("user_message"),
        requiredOfficialWorkflowIds: chatEvents.requiredOfficialWorkflowIds,
        modelSelection: chatEvents.modelSelection,
        canonicalModelSelection: canonicalChatInputModelSelection().as(
          "canonical_model_selection",
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
      .where(
        and(
          eq(chatEvents.chatThreadId, claim.chatThreadId),
          chatEventRunlessInputPredicate(
            chatEvents.runId,
            chatEvents.eventType,
          ),
          inArray(chatEvents.eventType, ["input.prompt", "input.automation"]),
          notExists(
            new QueryBuilder()
              .select({ id: revoker.id })
              .from(revoker)
              .where(eq(revoker.revokesEventId, chatEvents.id)),
          ),
        ),
      )
      .orderBy(asc(chatEvents.seqId))
      .limit(1),
  );
  return { occupancy, head };
}

function buildPreparationSelections(
  head: ReturnType<typeof buildPreparationTables>["head"],
  owner: { readonly agentId: string; readonly orgId: string },
) {
  const ownedAgent = exists(
    new QueryBuilder()
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, owner.agentId), eq(agents.orgId, owner.orgId))),
  );
  return new QueryBuilder()
    .select({
      rows: sql`COALESCE(jsonb_agg(jsonb_build_object(
        'connectorId', ${chatThreadConnectorSelections.connectorId},
        'connectorSlug', ${chatThreadConnectorSelections.connectorSlug},
        'customConnectorId', ${chatThreadConnectorSelections.customConnectorId}
      ) ORDER BY ${asc(chatThreadConnectorSelections.connectorSlug)},
        ${asc(chatThreadConnectorSelections.customConnectorId)}), '[]'::jsonb)`
        .mapWith(threadSelectionRowsDecoder)
        .as("selection_rows"),
    })
    .from(chatThreadConnectorSelections)
    .where(
      and(
        eq(chatThreadConnectorSelections.chatThreadId, head.chatThreadId),
        ownedAgent,
      ),
    );
}

/** One statement snapshot, owned by an actual successful queue-claim receipt. */
export function createChatRunPreparationSnapshot(
  claim: { readonly orgId: string; readonly chatThreadId: string },
  bootstrap: AgentRunContextSignals,
  requestFacts?: ChatThreadRequestFacts,
) {
  const threadRow$ = computed(async (get) => {
    // Preserve the request's binding snapshot. Commit still checks that binding.
    if (requestFacts) {
      return requestFacts.thread;
    }
    const [row] = await get(db$)
      .select(chatThreadRequestSelection())
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, claim.chatThreadId),
          eq(chatThreads.userId, bootstrap.userId),
          eq(chatThreads.agentId, bootstrap.agentId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  const snapshot$ = computed(async (get) => {
    const database = get(db$);
    // The limit belongs to the identity context; occupancy is sampled here.
    const capacity = await get(bootstrap.concurrencyCapacity$);
    const { occupancy, head } = buildPreparationTables(claim, capacity);
    const hasCapacity =
      capacity === 0 ? sql`true` : lt(occupancy.activeCount, capacity);
    const selections = buildPreparationSelections(head, {
      agentId: bootstrap.agentId,
      orgId: claim.orgId,
    });
    const [thread, [row]] = await Promise.all([
      get(threadRow$),
      database
        .with(occupancy, head)
        .select({
          hasCapacity: sql`${hasCapacity}`.mapWith(pgBooleanDecoder),
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
            canonicalModelSelection: head.canonicalModelSelection,
            sourceAutonomyBudget: head.sourceAutonomyBudget,
          },
          // No head/full queues do not inspect policy or selections; automation
          // inputs bypass the prompt-only Official thread policy as before.
          isOfficialWorkflowThread: sql`CASE WHEN ${not(hasCapacity)} THEN false
            WHEN ${eq(head.eventType, "input.prompt")} THEN ${officialWorkflowThreadCondition(
              {
                threadId: claim.chatThreadId,
                orgId: claim.orgId,
                userId: bootstrap.userId,
              },
            )} ELSE false END`.mapWith(pgBooleanDecoder),
          threadConnectorSelections:
            sql`CASE WHEN ${not(hasCapacity)} THEN '[]'::jsonb
            WHEN ${isNotNull(head.id)} THEN (${selections})
            ELSE '[]'::jsonb END`.mapWith(threadSelectionRowsDecoder),
        })
        .from(occupancy)
        .leftJoin(head, sql`true`),
    ]);
    if (!row) {
      throw new Error("Chat preparation occupancy returned no row");
    }
    const picked = row.head;
    if (!thread || !picked) {
      return { hasCapacity: row.hasCapacity, pickedEvent: null };
    }
    // Only this request's actual FIFO head may use its canonical input facts.
    const owned =
      requestFacts?.input.id === picked.id ? requestFacts.input : undefined;
    const pickedEvent: PickedThreadInputEvent = {
      ...picked,
      ...(owned
        ? {
            userMessage: owned.userMessage,
            modelSelection: owned.modelSelection,
            canonicalModelSelection: owned.modelSelection,
            requiredOfficialWorkflowIds:
              owned.requiredOfficialWorkflowIds ?? null,
          }
        : {}),
      userId: thread.userId,
      agentId: thread.agentId,
      thread,
      preparation: {
        isOfficialWorkflowThread: row.isOfficialWorkflowThread,
        threadConnectorSelections: row.threadConnectorSelections,
      },
    };
    return { hasCapacity: row.hasCapacity, pickedEvent };
  });
  return snapshot$;
}
