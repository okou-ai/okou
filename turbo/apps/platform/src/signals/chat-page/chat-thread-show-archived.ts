import { command, computed, state } from "ccstate";

const internalChatThreadShowArchived$ = state(false);

export const chatThreadShowArchived$ = computed((get) => {
  return get(internalChatThreadShowArchived$);
});

export const setChatThreadShowArchived$ = command(
  ({ set }, showArchived: boolean) => {
    set(internalChatThreadShowArchived$, showArchived);
  },
);
