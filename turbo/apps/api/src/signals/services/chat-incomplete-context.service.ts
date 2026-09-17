import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  CHAT_EVENT_TYPES,
  chatEventCompatibilityRole,
  type ChatEventType,
} from "@okouai/api-contracts/contracts/chat-events";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  lt,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import type { Db } from "../external/db";
import {
  chatEventTextCondition,
  chatEventTypeIn,
  runOwnedChatEventCondition,
} from "./chat-event-type.service";
import { visibleChatEventCondition } from "./chat-event-shared.service";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";

const INCOMPLETE_ROUND_LIMIT = 20;
const INCOMPLETE_EVENT_CHAR_CAP = 4000;
const incompleteRunAnchor = alias(chatEvents, "incomplete_run_anchor");
const earlierRunEvent = alias(chatEvents, "earlier_run_event");

type IncompleteRunStatus = "cancelled" | "failed" | "timeout";

interface IncompleteRoundSelection {
  readonly runId: string;
  readonly status: IncompleteRunStatus;
}

interface IncompleteRoundEvent {
  readonly eventType: ChatEventType;
  readonly role: "user" | "assistant";
  readonly content: string | null;
  readonly agentPrompt: string;
}

interface IncompleteRound extends IncompleteRoundSelection {
  readonly events: IncompleteRoundEvent[];
}

function isIncompleteRunStatus(value: string): value is IncompleteRunStatus {
  return value === "cancelled" || value === "failed" || value === "timeout";
}

async function selectIncompleteRoundFrontier(
  db: Db,
  threadId: string,
): Promise<readonly IncompleteRoundSelection[]> {
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
  // A later append cannot move the first retained event for a run. Include
  // revoked rows in this ordering fact; visibility only controls eligibility
  // and content. control.interrupt targets a run without belonging to it.
  // This reader remains hot-only: archival retention may remove its anchor.
  const rows = await db
    .select({
      runId: agentRuns.id,
      runStatus: agentRuns.status,
      isSuccess: isSuccessfulRun,
    })
    .from(incompleteRunAnchor)
    .innerJoin(agentRuns, eq(agentRuns.id, incompleteRunAnchor.runId))
    .where(
      and(
        eq(incompleteRunAnchor.chatThreadId, threadId),
        isNotNull(incompleteRunAnchor.runId),
        ne(incompleteRunAnchor.eventType, "control.interrupt"),
        or(
          isSuccessfulRun,
          inArray(agentRuns.status, sql`('cancelled', 'failed', 'timeout')`),
        ),
        notExists(
          db
            .select({ id: earlierRunEvent.id })
            .from(earlierRunEvent)
            .where(
              and(
                eq(earlierRunEvent.chatThreadId, threadId),
                eq(earlierRunEvent.runId, incompleteRunAnchor.runId),
                ne(earlierRunEvent.eventType, "control.interrupt"),
                lt(earlierRunEvent.seqId, incompleteRunAnchor.seqId),
              ),
            ),
        ),
        exists(
          db
            .select({ id: chatEvents.id })
            .from(chatEvents)
            .where(
              and(
                eq(chatEvents.chatThreadId, threadId),
                eq(chatEvents.runId, incompleteRunAnchor.runId),
                runOwnedChatEventCondition(),
                visibleChatEventCondition(db),
                or(isSuccessfulRun, chatEventTypeIn(CHAT_EVENT_TYPES)),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(incompleteRunAnchor.seqId))
    // Bound candidate rounds before loading their text. The extra row can be
    // the successful boundary after the maximum 20 incomplete rounds.
    .limit(INCOMPLETE_ROUND_LIMIT + 1);

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
}

async function loadSelectedIncompleteRounds(
  db: Db,
  threadId: string,
  selection: readonly IncompleteRoundSelection[],
): Promise<readonly IncompleteRound[]> {
  if (selection.length === 0) {
    return [];
  }

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
        visibleChatEventCondition(db),
      ),
    )
    .orderBy(asc(chatEvents.seqId));

  // Seed the map in selected run order. Interleaved late text can change the
  // first visible row of a round, but must not change the round's position.
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
}

function truncateIncomplete(value: string): string {
  if (value.length <= INCOMPLETE_EVENT_CHAR_CAP) {
    return value;
  }
  return `${value.slice(0, INCOMPLETE_EVENT_CHAR_CAP)}...[truncated]`;
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

export async function loadWebChatIncompleteContext(
  db: Db,
  threadId: string,
): Promise<string> {
  const selection = await selectIncompleteRoundFrontier(db, threadId);
  const rounds = await loadSelectedIncompleteRounds(db, threadId, selection);
  return buildWebChatIncompleteContext(rounds);
}
