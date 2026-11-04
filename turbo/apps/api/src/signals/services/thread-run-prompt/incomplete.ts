import { computed, type Computed } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  lt,
  min,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  CHAT_EVENT_TYPES,
  chatEventCompatibilityRole,
  type ChatEventType,
} from "@okouai/api-contracts/contracts/chat-events";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { pgBooleanDecoder } from "../../../lib/db-structured-result";
import { db$ } from "../../external/db";
import { canonicalChatEventContent } from "../canonical-chat-event-read.service";
import { visibleChatEventCondition } from "../chat-event-shared.service";
import {
  chatEventTextCondition,
  chatEventTypeIn,
  runOwnedChatEventCondition,
} from "../chat-event-type.service";
import { isWebChatContextType } from "../chat-queued-event.service";
import type { PickedThreadInputEvent } from "./types";

type IncompletePromptEvent = Pick<
  PickedThreadInputEvent,
  "chatThreadId" | "contextType" | "thread"
>;

type IncompleteRunStatus = "cancelled" | "failed" | "timeout";

interface IncompleteRoundEvent {
  readonly eventType: ChatEventType;
  readonly role: "user" | "assistant";
  readonly content: string | null;
  readonly agentPrompt: string;
}

function formatIncompleteEvent(event: IncompleteRoundEvent): string {
  if (event.role === "user") {
    return `User: ${truncateIncomplete(event.agentPrompt) || "[empty message]"}`;
  }
  if (event.content !== null && event.content !== "") {
    return `Assistant (partial): ${truncateIncomplete(event.content)}`;
  }
  return "Assistant: [no response before run ended]";
}

interface IncompleteRoundSelection {
  readonly runId: string;
  readonly status: IncompleteRunStatus;
}

const INCOMPLETE_ROUND_LIMIT = 20;
const INCOMPLETE_EVENT_PAGE_SIZE = 16;

interface IncompleteRunFacts {
  readonly runId: string;
  readonly status: string;
  readonly firstSeq: number;
  readonly visible: boolean;
}

function isIncompleteRunStatus(value: string): value is IncompleteRunStatus {
  return value === "cancelled" || value === "failed" || value === "timeout";
}

interface IncompleteRound extends IncompleteRoundSelection {
  readonly events: IncompleteRoundEvent[];
}

function incompleteRunFactsQuery(threadId: string, runIds: readonly string[]) {
  const query = new QueryBuilder();
  // Revoked rows still determine ordering; the minimum covers the whole retained
  // Run, including events outside the current page and its cursor.
  const firstOwnedEvents = query
    .select({
      runId: chatEvents.runId,
      firstSeq: min(chatEvents.seqId).mapWith(chatEvents.seqId).as("first_seq"),
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, threadId),
        inArray(chatEvents.runId, runIds),
        runOwnedChatEventCondition(),
      ),
    )
    .groupBy(chatEvents.runId)
    .as("first_owned_events");
  return query
    .select({
      runId: agentRuns.id,
      status: agentRuns.status,
      firstSeq: firstOwnedEvents.firstSeq,
      visible: exists(
        query
          .select({ id: chatEvents.id })
          .from(chatEvents)
          .where(
            and(
              eq(chatEvents.chatThreadId, threadId),
              eq(chatEvents.runId, agentRuns.id),
              runOwnedChatEventCondition(),
              visibleChatEventCondition(),
              or(
                eq(agentRuns.status, "completed"),
                chatEventTypeIn(CHAT_EVENT_TYPES),
              ),
            ),
          ),
      )
        .mapWith(pgBooleanDecoder)
        .as("visible"),
    })
    .from(agentRuns)
    .innerJoin(firstOwnedEvents, eq(firstOwnedEvents.runId, agentRuns.id))
    .where(
      and(
        inArray(agentRuns.id, runIds),
        inArray(agentRuns.status, [
          "completed",
          "cancelled",
          "failed",
          "timeout",
        ]),
      ),
    )
    .as("incomplete_run_facts");
}

function incompleteRoundAnchors(
  page: readonly Pick<typeof chatEvents.$inferSelect, "runId" | "seqId">[],
  factsByRunId: ReadonlyMap<string, IncompleteRunFacts | null>,
): IncompleteRunFacts[] {
  return page.flatMap((event) => {
    const fact =
      event.runId === null ? undefined : factsByRunId.get(event.runId);
    return fact?.visible && event.seqId === fact.firstSeq ? [fact] : [];
  });
}

function buildWebChatIncompleteContext(
  rounds: readonly IncompleteRound[],
): string {
  if (rounds.length === 0) {
    return "";
  }
  const total = rounds.length;
  const blocks = rounds.map((round, index) => {
    const relativeIndex = index - total + 1;
    const rendered = round.events.map((event) => {
      return formatIncompleteEvent(event);
    });
    const hasAssistant = round.events.some((event) => {
      return event.role === "assistant";
    });
    if (!hasAssistant) {
      rendered.push("Assistant: [no response before run ended]");
    }
    return [
      "---",
      "",
      `- RELATIVE_INDEX: ${relativeIndex}`,
      `- RUN_STATUS: ${round.status}`,
      "",
      ...rendered,
    ].join("\n");
  });
  return [
    "# Incomplete Rounds Context",
    "",
    "The rounds below were sent in this thread but their runs did not complete",
    "(cancelled, failed, or timed out), so the CLI session history does not",
    "contain them. Treat them as part of the conversation you are having with",
    "the user. RELATIVE_INDEX 0 is the most recent incomplete round.",
    "",
    blocks.join("\n\n"),
    "",
    "---",
  ].join("\n");
}

function truncateIncomplete(value: string): string {
  if (value.length <= INCOMPLETE_EVENT_CHAR_CAP) {
    return value;
  }
  return `${value.slice(0, INCOMPLETE_EVENT_CHAR_CAP)}...[truncated]`;
}

const INCOMPLETE_EVENT_CHAR_CAP = 4000;

function createIncompleteRoundSelection(
  pickedEvent$: Computed<Promise<IncompletePromptEvent | null>>,
): Computed<Promise<readonly IncompleteRoundSelection[]>> {
  return computed(async (get): Promise<readonly IncompleteRoundSelection[]> => {
    const event = await get(pickedEvent$);
    if (!event?.contextType || !isWebChatContextType(event.contextType)) {
      return [];
    }
    const threadId = event.chatThreadId;
    const db = get(db$);
    const predecessorId = event.thread.frameworkSessionRunId;
    if (predecessorId !== null) {
      const [predecessor] = await db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, predecessorId),
            eq(agentRuns.chatThreadId, threadId),
            eq(agentRuns.userId, event.thread.userId),
            exists(
              db
                .select({ id: chatEvents.id })
                .from(chatEvents)
                .where(
                  and(
                    eq(chatEvents.chatThreadId, threadId),
                    eq(chatEvents.runId, predecessorId),
                    runOwnedChatEventCondition(),
                    visibleChatEventCondition(),
                  ),
                ),
            ),
          ),
        );
      // The latest executed predecessor defines the fast path, even when a
      // newer pending Run failed before a Runner could start it.
      if (predecessor?.status === "completed") {
        return [];
      }
    }

    const rounds: IncompleteRoundSelection[] = [];
    const factsByRunId = new Map<string, IncompleteRunFacts | null>();
    let beforeSeq: number | undefined;
    while (rounds.length < INCOMPLETE_ROUND_LIMIT) {
      const page = await db
        .select({ seqId: chatEvents.seqId, runId: chatEvents.runId })
        .from(chatEvents)
        .where(
          and(
            eq(chatEvents.chatThreadId, threadId),
            isNotNull(chatEvents.runId),
            runOwnedChatEventCondition(),
            beforeSeq === undefined
              ? undefined
              : lt(chatEvents.seqId, beforeSeq),
          ),
        )
        .orderBy(desc(chatEvents.seqId))
        .limit(INCOMPLETE_EVENT_PAGE_SIZE);
      const lastEvent = page.at(-1);
      if (!lastEvent) {
        break;
      }
      const runIds = [
        ...new Set(
          page.flatMap((row) => {
            return row.runId !== null && !factsByRunId.has(row.runId)
              ? [row.runId]
              : [];
          }),
        ),
      ];
      if (runIds.length > 0) {
        const runFacts = incompleteRunFactsQuery(threadId, runIds);
        const facts = await db.select().from(runFacts);
        for (const runId of runIds) {
          factsByRunId.set(runId, null);
        }
        for (const fact of facts) {
          factsByRunId.set(fact.runId, fact);
        }
      }
      for (const fact of incompleteRoundAnchors(page, factsByRunId)) {
        if (fact.status === "completed") {
          return rounds.reverse();
        }
        if (isIncompleteRunStatus(fact.status)) {
          rounds.push({ runId: fact.runId, status: fact.status });
          if (rounds.length === INCOMPLETE_ROUND_LIMIT) {
            return rounds.reverse();
          }
        }
      }
      // Always advance by the raw page, including pages with no eligible anchor.
      beforeSeq = lastEvent.seqId;
      if (page.length < INCOMPLETE_EVENT_PAGE_SIZE) {
        break;
      }
    }
    return rounds.reverse();
  });
}

function createIncompleteRounds(
  pickedEvent$: Computed<Promise<IncompletePromptEvent | null>>,
  selection$: Computed<Promise<readonly IncompleteRoundSelection[]>>,
): Computed<Promise<readonly IncompleteRound[]>> {
  return computed(async (get): Promise<readonly IncompleteRound[]> => {
    const [event, selection] = await Promise.all([
      get(pickedEvent$),
      get(selection$),
    ]);
    if (!event || selection.length === 0) {
      return [];
    }
    const threadId = event.chatThreadId;
    const db = get(db$);
    const runIds = selection.map((round) => {
      return round.runId;
    });
    const selectedEvents = db
      .select()
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, threadId),
          inArray(chatEvents.runId, runIds),
        ),
      )
      // Keep acquisition before the prompt join without moving visibility/text
      // guards. A bound zero retains OFFSET, which Drizzle omits for .offset(0).
      .offset(sql.placeholder("incomplete_content_offset"))
      .as("chat_events");
    const rows = await db
      .select({
        runId: selectedEvents.runId,
        eventType: selectedEvents.eventType,
        content: canonicalChatEventContent(selectedEvents.payload),
        agentPrompt: agentRuns.prompt,
      })
      .from(selectedEvents)
      .innerJoin(agentRuns, eq(agentRuns.id, selectedEvents.runId))
      .where(
        and(
          eq(selectedEvents.chatThreadId, threadId),
          inArray(selectedEvents.runId, runIds),
          chatEventTextCondition(),
          visibleChatEventCondition(),
        ),
      )
      .orderBy(asc(selectedEvents.seqId))
      .execute({ incomplete_content_offset: 0 });
    const roundsByRunId = new Map<string, IncompleteRound>();
    for (const round of selection) {
      roundsByRunId.set(round.runId, { ...round, events: [] });
    }
    for (const row of rows) {
      if (row.runId === null) {
        continue;
      }
      const round = roundsByRunId.get(row.runId);
      if (round === undefined) {
        continue;
      }
      round.events.push({
        eventType: row.eventType,
        role: chatEventCompatibilityRole(row.eventType),
        content: row.content,
        agentPrompt: row.agentPrompt,
      });
    }
    return [...roundsByRunId.values()].filter((round) => {
      return round.events.length > 0;
    });
  });
}

/** Private continuation material; the claim graph reads createRotatedPrompt. */
export function createIncompletePrompt(
  pickedEvent$: Computed<Promise<IncompletePromptEvent | null>>,
): Computed<Promise<string>> {
  const selection$ = createIncompleteRoundSelection(pickedEvent$);
  const rounds$ = createIncompleteRounds(pickedEvent$, selection$);
  return computed(async (get) => {
    return buildWebChatIncompleteContext(await get(rounds$));
  });
}
