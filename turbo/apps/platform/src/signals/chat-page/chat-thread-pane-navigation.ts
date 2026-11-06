import { command } from "ccstate";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-thread-pane-state.ts";
import { withoutThreadMailParams } from "./thread-mail-location.ts";

// Pane navigation only rewrites the chat URL. It stays out of
// chat-thread-panes.ts, which builds every thread's signal graph, so a
// composer that opens its thread after sending does not import that graph.

export const SIDEBAR_PARAM = "sidebar";

// Thread-owned sidebars are anchored to the previous thread's messages.
const closeThreadSidebars$ = command(({ get, set }) => {
  for (const thread of [get(currentLeftThread$), get(currentRightThread$)]) {
    if (thread) {
      set(thread.sidebar.dismiss$);
    }
  }
});

export const loadLeftThread$ = command(
  ({ get, set }, threadId: string): void => {
    if (get(currentChatThreadId$) === threadId) {
      return;
    }

    // Drop sidebar state before switching threads because its content is
    // anchored to the previous thread's messages.
    set(closeThreadSidebars$);

    const params = get(searchParams$);
    const next =
      params.get("mailThread") === threadId ||
      params.get("mailThread") === params.get(SIDEBAR_PARAM)
        ? new URLSearchParams(params)
        : withoutThreadMailParams(params);
    if (next.get(SIDEBAR_PARAM) === threadId) {
      next.delete(SIDEBAR_PARAM);
    }
    set(detachedNavigateTo$, ROUTES.chat, {
      pathParams: { threadId },
      searchParams: next,
    });
  },
);

export const loadRightThread$ = command(
  ({ get, set }, threadId: string): void => {
    const mainThreadId = get(currentChatThreadId$);
    if (!mainThreadId || mainThreadId === threadId) {
      return;
    }

    if (get(currentRightThread$)?.threadId === threadId) {
      return;
    }

    set(closeThreadSidebars$);

    const params = get(searchParams$);
    const next =
      params.get("mailThread") === mainThreadId ||
      params.get("mailThread") === threadId
        ? new URLSearchParams(params)
        : withoutThreadMailParams(params);
    next.set(SIDEBAR_PARAM, threadId);
    set(detachedNavigateTo$, ROUTES.chat, {
      pathParams: { threadId: mainThreadId },
      searchParams: next,
    });
  },
);
