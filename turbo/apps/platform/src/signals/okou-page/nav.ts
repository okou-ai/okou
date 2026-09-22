import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isEditableTarget } from "@okouai/ui";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES, type RouteKey } from "../route-paths.ts";
import { openQueueDrawer$ } from "../queue-page/queue-drawer-state.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { setupKeyboardShortcutHints$ } from "../keyboard-shortcut-hints.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { setChatShortcutHelpOpen$ } from "../chat-page/chat-shortcut-help.ts";
import { openThreeColumnSearchDialog$ } from "./sidebar-state.ts";
import { displayedPinnedAgents$ } from "./pinned-agents.ts";
import { writeToClipboard } from "./clipboard.ts";
import { isStandaloneMode } from "./settings/connectors.ts";
import { setupThreadNumberShortcuts$ } from "./thread-number-shortcuts.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { toggleChatThreadUnreadFilter$ } from "./chat-thread-filter.ts";

type PinnedAgentShortcutDirection = "prev" | "next";

export const navigateToChat$ = command(({ set }, chatThreadId: string) => {
  set(detachedNavigateTo$, "/chats/:threadId", {
    pathParams: { threadId: chatThreadId },
  });
});

const navigateToNewChat$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const agentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    if (!agentId) {
      return;
    }
    set(detachedNavigateTo$, "/agents/:agentId/chat", {
      pathParams: { agentId },
    });
  },
);

function adjacentPinnedAgentId(
  pinnedAgents: readonly { readonly agentId: string }[],
  currentAgentId: string | null,
  direction: PinnedAgentShortcutDirection,
): string | null {
  if (pinnedAgents.length === 0) {
    return null;
  }
  const currentIndex = currentAgentId
    ? pinnedAgents.findIndex((agent) => {
        return agent.agentId === currentAgentId;
      })
    : -1;
  if (currentIndex === -1) {
    return direction === "next"
      ? pinnedAgents[0]!.agentId
      : pinnedAgents[pinnedAgents.length - 1]!.agentId;
  }
  const offset = direction === "next" ? 1 : -1;
  return pinnedAgents[
    (currentIndex + offset + pinnedAgents.length) % pinnedAgents.length
  ]!.agentId;
}

const navigateAdjacentPinnedAgent$ = command(
  async (
    { get, set },
    direction: PinnedAgentShortcutDirection,
    signal: AbortSignal,
  ) => {
    const currentAgentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    const targetAgentId = adjacentPinnedAgentId(
      await get(displayedPinnedAgents$),
      currentAgentId,
      direction,
    );
    signal.throwIfAborted();
    if (!targetAgentId) {
      return;
    }
    set(detachedNavigateTo$, "/agents/:agentId/chat", {
      pathParams: { agentId: targetAgentId },
    });
  },
);

const internalSidebarOff$ = state(false);

export const sidebarOff$ = computed((get) => {
  return get(internalSidebarOff$);
});

export const toggleSidebarOff$ = command(({ get, set }) => {
  set(internalSidebarOff$, !get(internalSidebarOff$));
});

function shouldHandleShortcutPress(event: KeyboardEvent): boolean {
  return !event.repeat && !event.isComposing && event.keyCode !== 229;
}

const shouldHandleUnreadOnlyShortcut$ = command(
  ({ get }, event: KeyboardEvent): boolean => {
    if (
      get(featureSwitch$)[FeatureSwitchKey.ChatUnreadOnlyShortcut] !== true ||
      !shouldHandleShortcutPress(event)
    ) {
      return false;
    }
    return !(
      /Linux/u.test(navigator.userAgent) && isEditableTarget(event.target)
    );
  },
);

export const setupGlobalKeyboardShortcuts$ = command(
  ({ set }, signal: AbortSignal) => {
    set(setupThreadNumberShortcuts$, signal);
    set(setupKeyboardShortcutHints$, signal);
    setupGlobalShortcut(
      {
        [GLOBAL_KEYBOARD_SHORTCUTS.toggleChatList.binding]: {
          allowInEditableTarget: true,
          run: () => {
            set(toggleSidebarOff$);
          },
        },
        [GLOBAL_KEYBOARD_SHORTCUTS.toggleUnreadOnly.binding]: {
          allowInEditableTarget: true,
          shouldHandle: (event) => {
            return set(shouldHandleUnreadOnlyShortcut$, event);
          },
          run: () => {
            set(toggleChatThreadUnreadFilter$);
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
        "ctrl+shift+[": {
          allowInEditableTarget: true,
          run: async () => {
            await set(navigateAdjacentPinnedAgent$, "prev", signal);
          },
        },
        "ctrl+shift+]": {
          allowInEditableTarget: true,
          run: async () => {
            await set(navigateAdjacentPinnedAgent$, "next", signal);
          },
        },
        "shift+/": {
          run: () => {
            set(setChatShortcutHelpOpen$, true);
          },
        },
      },
      signal,
    );
  },
);

const internalSidebarExpanded$ = state(false);

export const sidebarExpanded$ = computed((get) => {
  return get(internalSidebarExpanded$);
});

export const setSidebarExpanded$ = command(({ set }, expanded: boolean) => {
  set(internalSidebarExpanded$, expanded);
});

export type SidebarNavId =
  | "chat"
  | "agents"
  | "artifacts"
  | "connectors"
  | "workflows"
  | "works"
  | "settings"
  | "queues";

export function isChatRoute(key: RouteKey | null): boolean {
  return (
    key === "home" ||
    key === "agentChat" ||
    key === "agentIdeas" ||
    key === "chat"
  );
}

export const handleNavSelect$ = command(({ set }, id: SidebarNavId) => {
  if (id === "queues") {
    set(openQueueDrawer$);
  } else {
    const navRoutes = {
      chat: ROUTES.home,
      agents: ROUTES.agents,
      artifacts: ROUTES.artifacts,
      connectors: ROUTES.connectors,
      workflows: ROUTES.workflows,
      works: ROUTES.works,
      settings: ROUTES.settings,
    } satisfies Record<
      Exclude<SidebarNavId, "queues">,
      (typeof ROUTES)[keyof typeof ROUTES]
    >;
    set(detachedNavigateTo$, navRoutes[id]);
  }
});

export type AccountAction = "lab" | "signout";

export const handleAccountAction$ = command(
  ({ set }, action: AccountAction) => {
    set(internalSidebarExpanded$, false);
    if (action === "lab") {
      set(detachedNavigateTo$, ROUTES.lab);
    }
  },
);
