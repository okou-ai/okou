import { command, computed } from "ccstate";
import { refreshChatListLayout$ } from "../chat-page/chat-list-layout.ts";
import { localStorageSignals } from "../external/local-storage.ts";

const manageSectionCollapsedStorage = localStorageSignals(
  "sidebar-manage-section-collapsed",
);

export const manageSectionCollapsed$ = computed((get) => {
  return get(manageSectionCollapsedStorage.get$) === "true";
});

export const setManageSectionCollapsed$ = command(
  async ({ set }, collapsed: boolean, signal: AbortSignal) => {
    set(manageSectionCollapsedStorage.set$, String(collapsed));
    // The section sits above the mobile drawer's chat list.
    await set(refreshChatListLayout$, signal);
  },
);
