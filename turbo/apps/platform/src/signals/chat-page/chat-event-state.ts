import { chatEventCompatibilityRole } from "@okouai/api-contracts/contracts/chat-events";
import type { ChatRunEventContext } from "@okouai/api-contracts/contracts/chat-run-state";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { isCancelledRunEvent } from "./chat-run-lifecycle.ts";
import type { ChatEvent } from "./chat-event-types.ts";

import {
  isUsageEvent,
  type SemanticChatEventState,
  type SemanticChatGroups,
} from "@okouai/api-contracts/contracts/chat-event-semantics";

type QueuedChatEvent = Extract<
  ChatEvent,
  { eventType: "input.prompt" | "input.automation" }
>;

function isQueuedChatEvent(event: ChatEvent): event is QueuedChatEvent {
  return (
    event.eventType === "input.prompt" || event.eventType === "input.automation"
  );
}

export function queuedEventsFromSemanticEvents(
  semanticEvents: readonly SemanticChatEventState[],
): QueuedChatEvent[] {
  return semanticEvents.flatMap((entry) => {
    const { event } = entry;
    return chatEventCompatibilityRole(event.eventType) === "user" &&
      entry.isQueued &&
      isQueuedChatEvent(event)
      ? [event]
      : [];
  });
}

export function lastAssistantCancelledFromGroups(
  groups: SemanticChatGroups,
): boolean {
  const lastGroup = groups.allGroups.at(-1);
  const lastEvent = lastGroup?.events.at(-1)?.event;
  return lastEvent ? isCancelledRunEvent(lastEvent) : false;
}

export function liveRunIdsFromChatEvents(
  events: readonly ChatEvent[],
  { terminatedRunIds, revokedEventIds }: ChatRunEventContext,
): string[] {
  const liveRunIds: string[] = [];
  const seenRunIds = new Set<string>();
  for (const event of events) {
    const runId = event.runId;
    if (
      runId !== undefined &&
      !revokedEventIds.has(event.id) &&
      !terminatedRunIds.has(runId) &&
      !isUsageEvent(event) &&
      !seenRunIds.has(runId)
    ) {
      liveRunIds.push(runId);
      seenRunIds.add(runId);
    }
  }
  return liveRunIds;
}

export interface ChatRunModelSelection {
  readonly selectedModel: string;
  readonly serviceTier?: ChatThreadServiceTier;
}

export function modelSelectionForChatRun(
  events: readonly ChatEvent[],
  runningRunId: string | null,
  revokedEventIds: ReadonlySet<string>,
): ChatRunModelSelection | null {
  if (runningRunId === null) {
    return null;
  }

  for (const event of events) {
    if (
      event.eventType !== "input.prompt" ||
      event.runId !== runningRunId ||
      revokedEventIds.has(event.id)
    ) {
      continue;
    }
    const model = event.userMessage.parts.find((part) => {
      return part.type === "model";
    });
    if (model?.type === "model") {
      return {
        selectedModel: model.selectedModel,
        ...(model.serviceTier === undefined
          ? {}
          : { serviceTier: model.serviceTier }),
      };
    }
  }
  return null;
}
