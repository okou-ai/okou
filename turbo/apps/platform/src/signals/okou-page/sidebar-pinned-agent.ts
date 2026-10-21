import { command, computed } from "ccstate";
import { activeRoute$ } from "../active-route.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { defaultAgentId$, sortedAgents$ } from "../agent.ts";
import { unreadAgentIds$ } from "../chat-page/chat-thread-indicators-from-worker.ts";
import { markAgentThreadsRead$ } from "../chat-page/sidebar-unread-threads.ts";
import { pageSignal$ } from "../page-signal.ts";
import { pathParams$ } from "../route.ts";
import { isChatRoute, selectPinnedAgent$, setSidebarExpanded$ } from "./nav.ts";
import {
  displayedPinnedAgents$,
  movePinnedAgent$,
  pinnedAgents$,
  setAgentPinned$,
} from "./pinned-agents.ts";
import {
  draggingPinnedAgentId$,
  pinnedAgentDropTargetId$,
  setPinnedAgentDropTarget$,
  startPinnedAgentDrag$,
} from "./sidebar-state.ts";

/** Capture the current route owner once, when the action actually starts. */
export const setSidebarAgentPinned$ = command(
  (
    { get, set },
    selection: { readonly agentId: string; readonly pinned: boolean },
  ) => {
    const signal = get(pageSignal$);
    return set(setAgentPinned$, selection, signal);
  },
);

function createSidebarPinnedAgentActions(agentId: string) {
  return {
    // Each mounted menu owns its own useLoadableSet invocation state. Reading
    // the page signal here does not subscribe it to navigation.
    setPinned$: command(({ set }, pinned: boolean) => {
      return set(setSidebarAgentPinned$, { agentId, pinned });
    }),
    markRead$: command(({ get, set }) => {
      const signal = get(pageSignal$);
      return set(markAgentThreadsRead$, agentId, signal);
    }),
    select$: command(({ set }, hasUnread: boolean, closeSidebar = false) => {
      set(selectPinnedAgent$, { agentId, hasUnread });
      if (closeSidebar) {
        set(setSidebarExpanded$, false);
      }
    }),
    startDrag$: command(({ set }) => {
      set(startPinnedAgentDrag$, agentId);
    }),
    dragOver$: command(({ set }) => {
      set(setPinnedAgentDropTarget$, agentId);
    }),
    dragLeave$: command(({ get, set }) => {
      if (get(pinnedAgentDropTargetId$) === agentId) {
        set(setPinnedAgentDropTarget$, null);
      }
    }),
    moveHere$: command(({ get, set }) => {
      // Capture the invocation owner and drag before the DOM callback ends it.
      const signal = get(pageSignal$);
      const draggingId = get(draggingPinnedAgentId$);
      if (draggingId === null) {
        return Promise.resolve();
      }
      return set(
        movePinnedAgent$,
        { agentId: draggingId, targetAgentId: agentId },
        signal,
      );
    }),
  };
}

function createSidebarPinnedAgentSignals(agentId: string) {
  const displayName$ = computed(async (get) => {
    const agents = await get(sortedAgents$);
    return (
      agents.find((agent) => {
        return agent.agentId === agentId;
      })?.displayName ?? agentId
    );
  });
  const selected$ = computed(async (get) => {
    if (!isChatRoute(get(activeRoute$))) {
      return false;
    }
    const routeAgentId = get(pathParams$)?.agentId;
    const selectedAgentId =
      typeof routeAgentId === "string"
        ? routeAgentId
        : await get(currentChatAgentId$);
    return selectedAgentId === agentId;
  });
  const fromChat$ = computed(async (get) => {
    return (await get(currentChatAgentId$)) === agentId;
  });
  const unread$ = computed(async (get) => {
    return (await get(unreadAgentIds$)).has(agentId);
  });
  const pinned$ = computed(async (get) => {
    return (await get(pinnedAgents$)).some((agent) => {
      return agent.agentId === agentId;
    });
  });
  const default$ = computed(async (get) => {
    return (await get(defaultAgentId$)) === agentId;
  });
  const reorderable$ = computed(async (get) => {
    return (await get(pinned$)) && !(await get(default$));
  });
  const hasSideActions$ = computed(async (get) => {
    return (
      (await get(unread$)) || ((await get(pinned$)) && !(await get(default$)))
    );
  });
  const dragging$ = computed((get) => {
    return get(draggingPinnedAgentId$) === agentId;
  });
  const hasDrag$ = computed((get) => {
    return get(draggingPinnedAgentId$) !== null;
  });
  const dropSide$ = computed(
    async (get): Promise<"before" | "after" | null> => {
      const draggingId = get(draggingPinnedAgentId$);
      if (draggingId === null || get(pinnedAgentDropTargetId$) !== agentId) {
        return null;
      }
      const agents = await get(displayedPinnedAgents$);
      const from = agents.findIndex((agent) => {
        return agent.agentId === draggingId;
      });
      const to = agents.findIndex((agent) => {
        return agent.agentId === agentId;
      });
      return from === -1 || to === -1 || from === to
        ? null
        : from > to
          ? "before"
          : "after";
    },
  );

  return {
    agentId,
    displayName$,
    selected$,
    fromChat$,
    unread$,
    pinned$,
    default$,
    reorderable$,
    hasSideActions$,
    dragging$,
    hasDrag$,
    dropSide$,
    ...createSidebarPinnedAgentActions(agentId),
  };
}

export type SidebarPinnedAgentSignals = ReturnType<
  typeof createSidebarPinnedAgentSignals
>;

/**
 * One Store-local registry, bounded by the two last-resolved lists the UI can
 * display. Retain identities across order, unread and metadata changes; evict
 * removed rows once neither the pinned fallback nor displayed list uses them.
 * This is row identity reconciliation, not a cache of agent payloads.
 */
const sidebarPinnedAgentRegistry$ = computed(() => {
  const rows = new Map<string, SidebarPinnedAgentSignals>();
  const lists = { pinned: new Set<string>(), displayed: new Set<string>() };
  return {
    reconcile(source: keyof typeof lists, agentIds: readonly string[]) {
      lists[source] = new Set(agentIds);
      for (const id of rows.keys()) {
        if (!lists.pinned.has(id) && !lists.displayed.has(id)) {
          rows.delete(id);
        }
      }
      return agentIds.map((id) => {
        let row = rows.get(id);
        if (!row) {
          row = createSidebarPinnedAgentSignals(id);
          rows.set(id, row);
        }
        return row;
      });
    },
  };
});

export const sidebarPinnedAgentItems$ = computed(async (get) => {
  const agents = await get(pinnedAgents$);
  return get(sidebarPinnedAgentRegistry$).reconcile(
    "pinned",
    agents.map((agent) => {
      return agent.agentId;
    }),
  );
});

export const sidebarDisplayedPinnedAgentItems$ = computed(async (get) => {
  const agents = await get(displayedPinnedAgents$);
  return get(sidebarPinnedAgentRegistry$).reconcile(
    "displayed",
    agents.map((agent) => {
      return agent.agentId;
    }),
  );
});
