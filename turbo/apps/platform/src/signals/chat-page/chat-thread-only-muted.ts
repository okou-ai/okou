import { command, computed, state } from "ccstate";

const internalChatThreadOnlyMuted$ = state(false);

export const chatThreadOnlyMuted$ = computed((get) => {
  return get(internalChatThreadOnlyMuted$);
});

export const setChatThreadOnlyMuted$ = command(
  ({ set }, onlyMuted: boolean) => {
    set(internalChatThreadOnlyMuted$, onlyMuted);
  },
);
