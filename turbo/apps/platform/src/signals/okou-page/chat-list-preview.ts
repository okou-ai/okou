import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";
import { sidebarOff$, toggleSidebarOff$ } from "./nav.ts";

const internalChatListColumn$ = state<HTMLElement | null>(null);
const internalFocusPinnedToggle$ = state(false);

export const chatListColumnMounted$ = computed((get) => {
  return get(internalChatListColumn$) !== null;
});

export const chatListColumnRef$ = onRef(
  command(({ get, set }, column: HTMLElement, signal: AbortSignal) => {
    set(internalChatListColumn$, column);
    signal.addEventListener(
      "abort",
      () => {
        if (get(internalChatListColumn$) === column) {
          set(internalChatListColumn$, null);
        }
      },
      { once: true },
    );
    if (get(internalFocusPinnedToggle$)) {
      set(internalFocusPinnedToggle$, false);
      column.querySelector<HTMLElement>("[data-chat-list-toggle]")?.focus();
    }
  }),
);

export const toggleChatListFromButton$ = command(
  ({ get, set }, button: HTMLElement) => {
    set(
      internalFocusPinnedToggle$,
      get(sidebarOff$) &&
        !get(internalChatListColumn$) &&
        button.contains(button.ownerDocument.activeElement),
    );
    set(toggleSidebarOff$);
  },
);
