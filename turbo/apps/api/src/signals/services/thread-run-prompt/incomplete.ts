import { computed, type Computed } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  gt,
  lt,
  ne,
  notExists,
  or,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import {
  CHAT_EVENT_TYPES,
  chatEventCompatibilityRole,
  type ChatEventType,
} from "@okouai/api-contracts/contracts/chat-events";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { db$ } from "../../external/db";
import {
  canonicalChatEventContent,
  canonicalChatEventUserMessage,
} from "../canonical-chat-event-read.service";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "../chat-user-message.service";
import { visibleChatEventCondition } from "../chat-event-visibility.service";
import {
  chatEventTextCondition,
  chatEventTypeIn,
  runOwnedChatEventCondition,
} from "../chat-event-type.service";
import { isWebChatContextType } from "../chat-queued-event.service";
import type { PickedThreadInputEvent } from "./types";

type IncompletePromptEvent = Pick<
  PickedThreadInputEvent,
  "chatThreadId" | "contextType" | "preparation"
>;

type IncompleteRunStatus = "cancelled" | "failed" | "timeout";

interface IncompleteRoundEvent {
  readonly eventType: ChatEventType;
  readonly role: "user" | "assistant";
  readonly content: string | null;
  readonly userMessage: UserMessageDocument | null;
}

function formatIncompleteEvent(event: IncompleteRoundEvent): string {
  if (event.role === "user") {
    const document = requiredUserMessageForEvent(
      event.eventType,
      event.userMessage,
    );
    if (!document) {
      throw new Error("Incomplete input event is missing userMessage");
    }
    return `User: ${truncateIncomplete(projectUserMessage(document).agentPrompt) || "[empty message]"}`;
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
interface IncompleteRound extends IncompleteRoundSelection {
  readonly events: IncompleteRoundEvent[];
}

function isIncompleteRunStatus(value: string): value is IncompleteRunStatus {
  return value === "cancelled" || value === "failed" || value === "timeout";
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

function recentRoundAnchors(event: IncompletePromptEvent) {
  const query = new QueryBuilder();
  const anchor = alias(chatEvents, "incomplete_anchor");
  const sameRunEvents = and(
    eq(chatEvents.chatThreadId, event.chatThreadId),
    eq(chatEvents.runId, anchor.runId),
    runOwnedChatEventCondition(),
  );
  return query.$with("incomplete_round_anchors").as(
    query
      .select({
        runId: agentRuns.id,
        status: agentRuns.status,
        firstSeq: anchor.seqId,
      })
      .from(anchor)
      .innerJoin(agentRuns, eq(agentRuns.id, anchor.runId))
      .where(
        and(
          eq(anchor.chatThreadId, event.chatThreadId),
          ne(anchor.eventType, "control.interrupt"),
          inArray(agentRuns.status, [
            "completed",
            "cancelled",
            "failed",
            "timeout",
          ]),
          // Even a revoked first event anchors its Run's chronological position.
          notExists(
            query
              .select({ id: chatEvents.id })
              .from(chatEvents)
              .where(and(sameRunEvents, lt(chatEvents.seqId, anchor.seqId))),
          ),
          exists(
            query
              .select({ id: chatEvents.id })
              .from(chatEvents)
              .where(
                and(
                  sameRunEvents,
                  visibleChatEventCondition(),
                  or(
                    eq(agentRuns.status, "completed"),
                    chatEventTypeIn(CHAT_EVENT_TYPES),
                  ),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(anchor.seqId))
      .limit(INCOMPLETE_ROUND_LIMIT),
  );
}

/** Thread-owned continuation material, shared by early acquisition and Prompt. */
export function createIncompletePrompt(
  pickedEvent$: Computed<Promise<IncompletePromptEvent | null>>,
): Computed<Promise<string>> {
  return computed(async (get) => {
    const event = await get(pickedEvent$);
    if (
      !event?.contextType ||
      !isWebChatContextType(event.contextType) ||
      event.preparation.hasCompletedPredecessorHistory
    ) {
      return "";
    }
    const db = get(db$);
    const anchors = recentRoundAnchors(event);
    const completedBoundary = new QueryBuilder()
      .select({ firstSeq: anchors.firstSeq })
      .from(anchors)
      .where(eq(anchors.status, "completed"))
      .orderBy(desc(anchors.firstSeq))
      .limit(1)
      .as("incomplete_completed_boundary");
    const rows = await db
      .with(anchors)
      .select({
        runId: anchors.runId,
        status: anchors.status,
        eventType: chatEvents.eventType,
        content: canonicalChatEventContent(),
        userMessage: canonicalChatEventUserMessage(),
      })
      .from(anchors)
      .innerJoin(
        chatEvents,
        and(
          eq(chatEvents.chatThreadId, event.chatThreadId),
          eq(chatEvents.runId, anchors.runId),
        ),
      )
      .where(
        and(
          ne(anchors.status, "completed"),
          notExists(
            new QueryBuilder()
              .select({ firstSeq: completedBoundary.firstSeq })
              .from(completedBoundary)
              .where(gt(completedBoundary.firstSeq, anchors.firstSeq)),
          ),
          chatEventTextCondition(),
          visibleChatEventCondition(),
        ),
      )
      .orderBy(asc(anchors.firstSeq), asc(chatEvents.seqId));
    const rounds = new Map<string, IncompleteRound>();
    for (const row of rows) {
      if (!isIncompleteRunStatus(row.status)) {
        throw new Error("Unexpected incomplete Run status");
      }
      let round = rounds.get(row.runId);
      if (!round) {
        round = { runId: row.runId, status: row.status, events: [] };
        rounds.set(row.runId, round);
      }
      round.events.push({
        eventType: row.eventType,
        role: chatEventCompatibilityRole(row.eventType),
        content: row.content,
        userMessage: row.userMessage,
      });
    }
    return buildWebChatIncompleteContext([...rounds.values()]);
  });
}
