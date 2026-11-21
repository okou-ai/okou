import { command, computed } from "ccstate";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES, type RouteKey } from "../route-paths.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { newChatAgentId$ } from "../agent-chat.ts";
import { setChatShortcutHelpOpen$ } from "../chat-page/chat-shortcut-help.ts";
import { openThreeColumnSearchDialog$ } from "./sidebar-state.ts";
import { writeToClipboard } from "./clipboard.ts";
import { isStandaloneMode } from "./settings/connectors.ts";
import { mobileChatViewport$ } from "./pwa-navigation.ts";
import {
  setStoredChatListHidden$,
  storedChatListHidden$,
} from "./unified-chat-workspace.ts";

export const navigateToChat$ = command(({ set }, chatThreadId: string) => {
  set(detachedNavigateTo$, "/chats/:threadId", {
    pathParams: { threadId: chatThreadId },
  });
});

// With mobile navigation the bare chat page URL is the chat list, so a new
// chat asks for the composer explicitly.
export const navigateToNewChat$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const agentId = await get(newChatAgentId$);
    signal.throwIfAborted();
    if (!agentId) {
      return;
    }
    set(
      detachedNavigateTo$,
      ROUTES.home,
      get(mobileChatViewport$)
        ? { searchParams: new URLSearchParams({ compose: "1" }) }
        : undefined,
    );
  },
);

// The workspace remembers a folded chat list across reloads.
export const sidebarOff$ = computed((get) => {
  return get(storedChatListHidden$);
});

export const toggleSidebarOff$ = command(({ get, set }) => {
  set(setStoredChatListHidden$, !get(sidebarOff$));
});

export function shouldHandleShortcutPress(event: KeyboardEvent): boolean {
  return !event.repeat && !event.isComposing && event.keyCode !== 229;
}

export const setupGlobalKeyboardShortcuts$ = command(
  ({ set }, signal: AbortSignal) => {
    return setupGlobalShortcut(
      {
        [GLOBAL_KEYBOARD_SHORTCUTS.toggleChatList.binding]: {
          allowInEditableTarget: true,
          run: () => {
            set(toggleSidebarOff$);
          },
        },
        "mod+l": {
          allowInEditableTarget: true,
          shouldHandle: () => {
            return isStandaloneMode();
          },
          run: async () => {
            await writeToClipboard(window.location.href);
          },
        },
        [GLOBAL_KEYBOARD_SHORTCUTS.newChat.binding]: {
          allowInEditableTarget: true,
          run: async () => {
            await set(navigateToNewChat$, signal);
          },
        },
        [GLOBAL_KEYBOARD_SHORTCUTS.searchWorkspace.binding]: {
          allowInEditableTarget: true,
          shouldHandle: shouldHandleShortcutPress,
          run: () => {
            set(openThreeColumnSearchDialog$);
          },
        },
        [GLOBAL_KEYBOARD_SHORTCUTS.showShortcuts.binding]: {
          run: () => {
            set(setChatShortcutHelpOpen$, true);
          },
        },
      },
      signal,
    );
  },
);

export const showChatSidebar$ = command(({ set }) => {
  set(setStoredChatListHidden$, false);
});

export function isChatRoute(key: RouteKey | null): boolean {
  return (
    key === "home" ||
    key === "forYou" ||
    key === "agentChat" ||
    key === "chat" ||
    key === "project"
  );
}

export type AccountAction = "lab" | "signout";

export const handleAccountAction$ = command(
  ({ set }, action: AccountAction) => {
    if (action === "lab") {
      set(detachedNavigateTo$, ROUTES.lab);
    }
  },
);
