import { command, computed, state } from "ccstate";

const internalChatThreadOnlyArchived$ = state(false);

export const chatThreadOnlyArchived$ = computed((get) => {
  return get(internalChatThreadOnlyArchived$);
});

export const setChatThreadOnlyArchived$ = command(
  ({ set }, onlyArchived: boolean) => {
    set(internalChatThreadOnlyArchived$, onlyArchived);
  },
);
