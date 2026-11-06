import {
  chatEventCompatibilityRole,
  isChatEventContentTextType,
} from "@okouai/api-contracts/contracts/chat-events";
import { hasChatEventBodyContent } from "./chat-event-body-blocks.ts";
import type { EnrichedChatEvent } from "./chat-event.ts";
import type { ChatEvent, ChatInputEvent } from "./chat-event-types.ts";

export function chatEventDisplayError(event: ChatEvent): string | undefined {
  if (
    event.eventType === "input.rejected" ||
    event.eventType === "output.error" ||
    event.eventType === "run.failed" ||
    event.eventType === "run.cancelled"
  ) {
    return event.error;
  }
  return undefined;
}

function chatEventHasAttachments(event: EnrichedChatEvent): boolean {
  return (
    "userMessage" in event &&
    (event.userMessage?.parts.some((part) => {
      return part.type === "file";
    }) ??
      false)
  );
}

export function isRenderableAssistantEvent(event: EnrichedChatEvent): boolean {
  return (
    chatEventCompatibilityRole(event.eventType) === "assistant" &&
    ((isChatEventContentTextType(event.eventType) && Boolean(event.content)) ||
      Boolean(chatEventDisplayError(event)) ||
      hasChatEventBodyContent(event) ||
      chatEventHasAttachments(event))
  );
}

export function isInputChatEvent(event: ChatEvent): event is ChatInputEvent {
  return (
    event.eventType === "input.prompt" ||
    event.eventType === "input.automation" ||
    event.eventType === "input.rejected"
  );
}

export function asInputChatEvent(event: ChatEvent): ChatInputEvent | undefined {
  return isInputChatEvent(event) ? event : undefined;
}

export function isWorkflowUserMessage(
  event: EnrichedChatEvent,
): event is EnrichedChatEvent & ChatInputEvent {
  return (
    isInputChatEvent(event) &&
    event.userMessage?.parts.find((part) => {
      return part.type === "source" || part.type === "automation";
    })?.type === "automation"
  );
}

// A user event does not always render as a bubble: a workflow run renders as
// its own card.
export function rendersUserBubble(event: EnrichedChatEvent): boolean {
  return !isWorkflowUserMessage(event);
}
