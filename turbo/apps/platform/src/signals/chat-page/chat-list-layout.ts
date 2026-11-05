import { command, computed, state } from "ccstate";

const internalChatListLayoutRequest$ = state<symbol | null>(null);

/**
 * The latest change to the space beside the chat list. Every mounted chat list
 * viewport fulfills it at the commit that carries the change.
 */
export const chatListLayoutRequest$ = computed((get) => {
  return get(internalChatListLayoutRequest$);
});

/**
 * Called by the operation that changes the chat list's available height, in
 * the same synchronous update as the state that renders the change.
 */
export const requestChatListLayout$ = command(({ set }) => {
  set(internalChatListLayoutRequest$, Symbol("chat-list-layout"));
});
