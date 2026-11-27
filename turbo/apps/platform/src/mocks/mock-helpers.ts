/**
 * High-level Ably-event helpers for use in tests.
 *
 * Each function fires the real-time event that the production app subscribes
 * to for a given chat-thread lifecycle transition. Use these instead of
 * calling triggerAblyEvent() directly with raw topic strings.
 */
import { triggerAblyEvent } from "./ably.ts";

/** Simulate a new chat event being created in a thread. */
export function createChatEvent(threadId: string, payload?: unknown): void {
  triggerAblyEvent(`chatThreadMessageCreated:${threadId}`, payload);
}

/** Simulate a persisted chat-thread event changing the shared thread list. */
export function changeChatThreadList(): void {
  triggerAblyEvent("threadListChanged");
}

/** Simulate a Run start, Run terminal marker, mute, hide, or delete changing indicators. */
export function changeChatIndicators(): void {
  triggerAblyEvent("chatIndicatorsChanged");
}
