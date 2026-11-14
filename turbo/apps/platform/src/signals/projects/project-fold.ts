import { command } from "ccstate";
import { threeColumnSidebarChatThreadScrollSignals } from "../chat-page/sidebar-chat-thread-scroll.ts";
import { pwaChatThreadScrollSignals$ } from "../okou-page/pwa-chat-list.ts";
import {
  collapseProject$,
  expandedProjectIds$,
  expandProject$,
} from "./project-expansion.ts";

export const cancelProjectFoldAnimations$ = command(({ get, set }) => {
  set(threeColumnSidebarChatThreadScrollSignals.cancelProjectFold$);
  set(get(pwaChatThreadScrollSignals$).cancelProjectFold$);
});

/** Only explicit user folds animate; restore and navigation remain immediate. */
export const setProjectExpandedWithMotion$ = command(
  async (
    { get, set },
    projectId: string,
    expanded: boolean,
    signal: AbortSignal,
  ) => {
    const desktop = set(
      threeColumnSidebarChatThreadScrollSignals.foldProject$,
      projectId,
      expanded,
      signal,
    );
    if (desktop !== false) {
      await desktop;
      signal.throwIfAborted();
      return;
    }
    const mobile = set(
      get(pwaChatThreadScrollSignals$).foldProject$,
      projectId,
      expanded,
      signal,
    );
    if (mobile !== false) {
      await mobile;
      signal.throwIfAborted();
      return;
    }
    signal.throwIfAborted();
    set(expanded ? expandProject$ : collapseProject$, projectId);
  },
);

export const toggleProjectWithMotion$ = command(
  async ({ get, set }, projectId: string, signal: AbortSignal) => {
    await set(
      setProjectExpandedWithMotion$,
      projectId,
      !get(expandedProjectIds$).has(projectId),
      signal,
    );
  },
);
