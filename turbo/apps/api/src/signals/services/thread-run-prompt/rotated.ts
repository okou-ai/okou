import { computed, type Computed } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  max,
  ne,
  or,
} from "drizzle-orm";
import {
  CHAT_EVENT_CONTENT_TEXT_TYPES,
  CHAT_EVENT_USER_MESSAGE_TEXT_TYPES,
  chatEventCompatibilityRole,
} from "@okouai/api-contracts/contracts/chat-events";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { db$ } from "../../external/db";
import { BEFORE_DISPATCH_CANCELLED_ERROR } from "../agent-run-cancellation";
import {
  canonicalChatEventContent,
  canonicalChatEventUserMessage,
} from "../canonical-chat-event-read.service";
import { visibleChatEventCondition } from "../chat-event-shared.service";
import {
  chatEventTextCondition,
  chatEventTypeIn,
} from "../chat-event-type.service";
import {
  isWebChatContextType,
  queuedUserMessageTriggerSource,
  type QueuedUserMessageTriggerSource,
} from "../chat-queued-event.service";
import type { ChatThreadSessionResolution } from "../chat-session-continuity.service";
import {
  buildChatPriorRunsContext,
  type PriorRunEvent,
} from "../internal-chat-run-callback.service";
import type { PickedThreadInputEvent } from "./types";

export interface RotatedPromptInput {
  readonly event: PickedThreadInputEvent;
  readonly chatThreadId: string;
  /** Share the native-session decision used by execution and commit. */
  readonly session: Pick<ChatThreadSessionResolution, "action"> | null;
  readonly triggerSource: QueuedUserMessageTriggerSource;
}

export function createRotatedPrompt(
  input$: Computed<Promise<RotatedPromptInput | null>>,
): Computed<Promise<string>> {
  return computed(async (get) => {
    const input = await get(input$);
    if (!input || input.session?.action !== "rotated") {
      return "";
    }
    const contextType = input.event.contextType;
    if (contextType === null || contextType === "automation") {
      return "";
    }
    const db = get(db$);
    const rows = await db
      .select({
        runId: agentRuns.id,
        status: agentRuns.status,
        prompt: agentRuns.prompt,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.chatThreadId, input.chatThreadId),
          isWebChatContextType(contextType)
            ? inArray(agentRuns.triggerSource, ["web", "agent"])
            : contextType === "feishu"
              ? inArray(agentRuns.triggerSource, ["feishu", "lark"])
              : eq(
                  agentRuns.triggerSource,
                  queuedUserMessageTriggerSource(contextType),
                ),
          or(
            or(ne(agentRuns.status, "cancelled"), isNull(agentRuns.status)),
            or(
              ne(agentRuns.error, BEFORE_DISPATCH_CANCELLED_ERROR),
              isNull(agentRuns.error),
            ),
          ),
        ),
      )
      .orderBy(desc(agentRuns.createdAt))
      .limit(10);
    const runs = rows.reverse();
    const runIds = runs.map((run) => {
      return run.runId;
    });
    if (!runIds.length) {
      return "";
    }
    const events = await db
      .select({
        runId: chatEvents.runId,
        eventType: chatEvents.eventType,
        content: canonicalChatEventContent(),
        userMessage: canonicalChatEventUserMessage(),
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, input.chatThreadId),
          chatEventTextCondition(),
          inArray(chatEvents.runId, runIds),
          visibleChatEventCondition(),
          isWebChatContextType(contextType)
            ? or(
                chatEventTypeIn(CHAT_EVENT_USER_MESSAGE_TEXT_TYPES),
                inArray(
                  chatEvents.seqId,
                  db
                    .select({ seqId: max(chatEvents.seqId) })
                    .from(chatEvents)
                    .where(
                      and(
                        eq(chatEvents.chatThreadId, input.chatThreadId),
                        chatEventTypeIn(CHAT_EVENT_CONTENT_TEXT_TYPES),
                        isNotNull(canonicalChatEventContent()),
                        inArray(chatEvents.runId, runIds),
                        visibleChatEventCondition(),
                      ),
                    )
                    .groupBy(chatEvents.runId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(asc(chatEvents.seqId));
    const grouped = new Map<string, PriorRunEvent[]>();
    for (const event of events) {
      if (event.runId === null) {
        continue;
      }
      const runEvents = grouped.get(event.runId) ?? [];
      runEvents.push({
        eventType: event.eventType,
        role: chatEventCompatibilityRole(event.eventType),
        content: event.content,
        userMessage: event.userMessage,
      });
      grouped.set(event.runId, runEvents);
    }
    return buildChatPriorRunsContext(
      runs.map((run) => {
        return { ...run, events: grouped.get(run.runId) ?? [] };
      }),
      contextType,
      input.triggerSource,
    );
  });
}
