import { command } from "ccstate";

/** Dispatched on `window`; each mounted chat list viewport listens for it. */
export const CHAT_LIST_LAYOUT_EVENT = "okou-chat-list-layout";

/**
 * Called by the operation that changes the space beside the chat list. Every
 * mounted chat list viewport measures itself in the next animation frame,
 * under its own mount lifetime, coalesced with browser resizes.
 */
export const refreshChatListLayout$ = command(() => {
  window.dispatchEvent(new Event(CHAT_LIST_LAYOUT_EVENT));
});
