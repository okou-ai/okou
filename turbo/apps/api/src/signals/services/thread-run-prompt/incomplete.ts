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
  ne,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  CHAT_EVENT_TYPES,
  chatEventCompatibilityRole,
  type ChatEventType,
} from "@okouai/api-contracts/contracts/chat-events";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { executeRawRows } from "../../../lib/db-raw-rows";
import { pgBooleanDecoder } from "../../../lib/db-structured-result";
import { db$, rawSqlReadDb$ } from "../../external/db";
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
  "chatThreadId" | "contextType"
>;

type IncompleteRunStatus = "cancelled" | "failed" | "timeout";

const earlierRunEvent = alias(chatEvents, "earlier_run_event");

const incompleteRunAnchor = alias(chatEvents, "incomplete_run_anchor");

const incompleteAnchorCandidate = alias(
  chatEvents,
  "incomplete_anchor_candidate",
);

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

const incompleteRoundFrontierRowSchema = z.object({
  runId: z.string(),
  runStatus: z.string(),
  isSuccess: z.boolean(),
});

function isIncompleteRunStatus(value: string): value is IncompleteRunStatus {
  return value === "cancelled" || value === "failed" || value === "timeout";
}

interface IncompleteRound extends IncompleteRoundSelection {
  readonly events: IncompleteRoundEvent[];
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

function createIncompleteRoundAnchors(
  pickedEvent$: Computed<Promise<IncompletePromptEvent | null>>,
) {
  return computed(async (get) => {
    const event = await get(pickedEvent$);
    if (!event?.contextType || !isWebChatContextType(event.contextType)) {
      return null;
    }
    const threadId = event.chatThreadId;
    const db = get(db$);
    const anchors = [undefined, sql`incomplete_frontier.seq_id`].map(
      (beforeSeq) => {
        const isSuccessfulRun = sql`COALESCE(
    ${and(
      sql`${agentRuns.result} ? 'agentSessionId'`,
      eq(
        sql`jsonb_typeof(${agentRuns.result}->'agentSessionId')`,
        sql`'string'`,
      ),
    )},
    FALSE
  )`.mapWith(pgBooleanDecoder);
        // Grouping prevents PostgreSQL's MIN/MAX optimization from seeking forward
        // through unrelated older runs in the thread-sequence index.
        // Keep eligibility in this run-keyed lookup too: joining runs in the outer
        // candidate scan can sort the entire thread before its caller's LIMIT.
        const firstOwnedEvent = db
          .select({ seqId: min(earlierRunEvent.seqId).as("first_seq") })
          .from(earlierRunEvent)
          .innerJoin(agentRuns, eq(agentRuns.id, earlierRunEvent.runId))
          .where(
            and(
              eq(earlierRunEvent.chatThreadId, threadId),
              eq(earlierRunEvent.runId, incompleteRunAnchor.runId),
              ne(earlierRunEvent.eventType, "control.interrupt"),
              or(
                isSuccessfulRun,
                inArray(
                  agentRuns.status,
                  sql`('cancelled', 'failed', 'timeout')`,
                ),
              ),
            ),
          )
          .groupBy(earlierRunEvent.runId)
          .as("first_owned_event");
        const candidates = db
          .select({
            runId: incompleteRunAnchor.runId,
            seqId: incompleteRunAnchor.seqId,
            firstSeq: firstOwnedEvent.seqId,
          })
          .from(incompleteRunAnchor)
          .crossJoinLateral(firstOwnedEvent)
          .where(
            and(
              eq(incompleteRunAnchor.chatThreadId, threadId),
              beforeSeq === undefined
                ? undefined
                : lt(incompleteRunAnchor.seqId, beforeSeq),
              isNotNull(incompleteRunAnchor.runId),
              ne(incompleteRunAnchor.eventType, "control.interrupt"),
            ),
          )
          .orderBy(desc(incompleteRunAnchor.seqId));
        // Keep the equality outside this planner boundary so the lateral minimum
        // can be memoized by run ID, not recomputed for every candidate sequence.
        // Drizzle omits .offset(0); this shell must retain PostgreSQL's OFFSET 0.
        const candidateSource = sql`(${candidates} OFFSET 0)
      AS incomplete_anchor_candidate(run_id, seq_id, first_seq)`;
        // A later append cannot move the first retained event for a run. Include
        // revoked rows in this ordering fact; visibility only controls eligibility
        // and content. control.interrupt targets a run without belonging to it.
        // This reader remains hot-only: archival retention may remove its anchor.
        return db
          .select({
            runId: agentRuns.id,
            runStatus: agentRuns.status,
            isSuccess: isSuccessfulRun,
            // candidateSource is an opaque SQL FROM fragment; a bare column
            // cannot pass Drizzle's typed-source membership validation here.
            seqId: sql`${incompleteAnchorCandidate.seqId}`.mapWith(
              chatEvents.seqId,
            ),
          })
          .from(candidateSource)
          .innerJoin(
            agentRuns,
            eq(agentRuns.id, incompleteAnchorCandidate.runId),
          )
          .where(
            and(
              eq(
                incompleteAnchorCandidate.seqId,
                sql`incomplete_anchor_candidate.first_seq`,
              ),
              exists(
                db
                  .select({ id: chatEvents.id })
                  .from(chatEvents)
                  .where(
                    and(
                      eq(chatEvents.chatThreadId, threadId),
                      eq(chatEvents.runId, incompleteAnchorCandidate.runId),
                      runOwnedChatEventCondition(),
                      visibleChatEventCondition(),
                      or(isSuccessfulRun, chatEventTypeIn(CHAT_EVENT_TYPES)),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(desc(incompleteAnchorCandidate.seqId))
          .limit(1);
      },
    );
    const [newestAnchor, precedingAnchor] = anchors;
    if (!newestAnchor || !precedingAnchor) {
      throw new Error("Incomplete round anchors were not constructed");
    }
    return { newestAnchor, precedingAnchor };
  });
}

function createIncompleteRoundSelection(
  anchors$: ReturnType<typeof createIncompleteRoundAnchors>,
): Computed<Promise<readonly IncompleteRoundSelection[]>> {
  return computed(async (get): Promise<readonly IncompleteRoundSelection[]> => {
    const anchors = await get(anchors$);
    if (!anchors) {
      return [];
    }
    // Handwritten raw SQL needs `execute`; see rawSqlReadDb$.
    const db = get(rawSqlReadDb$);
    const { newestAnchor, precedingAnchor } = anchors;
    const rows = await executeRawRows(
      db,
      sql`
      WITH RECURSIVE incomplete_frontier AS (
        SELECT candidate.*, 1 AS depth
        FROM (${newestAnchor}) AS candidate(run_id, run_status, is_success, seq_id)

        UNION ALL

        SELECT candidate.*, incomplete_frontier.depth + 1
        FROM incomplete_frontier
        CROSS JOIN LATERAL (${precedingAnchor})
          AS candidate(run_id, run_status, is_success, seq_id)
        WHERE incomplete_frontier.depth < ${INCOMPLETE_ROUND_LIMIT + 1}
          AND NOT incomplete_frontier.is_success
      )
      SELECT run_id AS "runId", run_status AS "runStatus", is_success AS "isSuccess"
      FROM incomplete_frontier
      ORDER BY depth
    `,
      incompleteRoundFrontierRowSchema,
    );
    const rounds: IncompleteRoundSelection[] = [];
    for (const row of rows) {
      if (row.isSuccess) {
        break;
      }
      if (
        rounds.length < INCOMPLETE_ROUND_LIMIT &&
        isIncompleteRunStatus(row.runStatus)
      ) {
        rounds.push({ runId: row.runId, status: row.runStatus });
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
    const rows = await db
      .select({
        runId: chatEvents.runId,
        eventType: chatEvents.eventType,
        content: canonicalChatEventContent(),
        agentPrompt: agentRuns.prompt,
      })
      .from(chatEvents)
      .innerJoin(agentRuns, eq(agentRuns.id, chatEvents.runId))
      .where(
        and(
          eq(chatEvents.chatThreadId, threadId),
          inArray(chatEvents.runId, runIds),
          chatEventTextCondition(),
          visibleChatEventCondition(),
        ),
      )
      .orderBy(asc(chatEvents.seqId));
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
  const anchors$ = createIncompleteRoundAnchors(pickedEvent$);
  const selection$ = createIncompleteRoundSelection(anchors$);
  const rounds$ = createIncompleteRounds(pickedEvent$, selection$);
  return computed(async (get) => {
    return buildWebChatIncompleteContext(await get(rounds$));
  });
}
