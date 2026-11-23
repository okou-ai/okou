import {
  chatEventCompatibilityRole,
  isChatEventContentTextType,
} from "@okouai/api-contracts/contracts/chat-events";
import { messageDocumentToDisplayText } from "../okou-page/user-message-document-codec.ts";
import {
  isFollowupsEvent,
  isInterruptControlEvent,
  isRecallControlEvent,
} from "@okouai/api-contracts/contracts/chat-event-semantics";
import {
  eventBodyPlan,
  type CardDescriptorBlock,
} from "./parse-body-blocks.ts";
import type { ChatActionContext } from "./chat-action-context.ts";
import type { ChatEvent } from "./chat-event-types.ts";

function chatEventBodyContent(event: ChatEvent): string {
  if (chatEventCompatibilityRole(event.eventType) === "assistant") {
    return isChatEventContentTextType(event.eventType)
      ? (event.content ?? "")
      : "";
  }
  if (
    event.eventType === "input.prompt" ||
    event.eventType === "input.automation" ||
    event.eventType === "input.rejected"
  ) {
    if (event.eventType === "input.automation" && !event.userMessage) {
      return "";
    }
    const content = messageDocumentToDisplayText(event.userMessage);
    if (content === null) {
      throw new Error(`${event.eventType} is missing a valid userMessage`);
    }
    return content.trim();
  }
  return event.content?.trim() ?? "";
}

function skipsEventBodyRendering(event: ChatEvent): boolean {
  return (
    isInterruptControlEvent(event) ||
    isRecallControlEvent(event) ||
    isFollowupsEvent(event)
  );
}

/** A provisional message can still gain more bytes at its current URL tail. */
export function isTransientOutputMessage(event: ChatEvent): boolean {
  return event.eventType === "output.message" && event.seqId === undefined;
}

/** Whether the event carries an assistant body rendered as markdown. */
export function hasChatEventBodyContent(event: ChatEvent): boolean {
  return chatEventTreeContent(event) !== null;
}

/**
 * The raw assistant body a markdown tree is parsed from, or null when the event
 * does not use markdown rendering. Cheap relative to planning: the
 * visibility-driven ensure pass runs on every scroll capture, so the
 * unchanged-content skip has to cost a lookup, not a card scan.
 */
export function chatEventTreeContent(event: ChatEvent): string | null {
  if (
    chatEventCompatibilityRole(event.eventType) !== "assistant" ||
    skipsEventBodyRendering(event)
  ) {
    return null;
  }
  const content = chatEventBodyContent(event);
  return /\S/.test(content) ? content : null;
}

interface ChatEventTreePlan {
  /** The raw body the plan was made from; a cache key for the parsed tree. */
  readonly content: string;
  readonly treeSource: string;
  readonly descriptors: readonly CardDescriptorBlock[];
  readonly requireUrlTerminator: boolean;
}

/**
 * Plans the single markdown document an assistant event renders as.
 */
export function chatEventTreePlan(
  event: ChatEvent,
  chatActionContext: ChatActionContext,
): ChatEventTreePlan | null {
  const content = chatEventTreeContent(event);
  if (content === null) {
    return null;
  }
  const requireUrlTerminator = isTransientOutputMessage(event);
  const plan = eventBodyPlan(content, {
    requireUrlTerminator,
    chatActionContext,
  });
  return {
    content,
    treeSource: plan.treeSource,
    descriptors: plan.descriptors,
    requireUrlTerminator,
  };
}
