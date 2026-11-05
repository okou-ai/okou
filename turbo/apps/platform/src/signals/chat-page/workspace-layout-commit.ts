import { command, computed, state, type Command, type Computed } from "ccstate";
import type { ChatPanelSignals } from "./chat-panel-signals.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-thread-pane-state.ts";
import { restoreChatLayoutScroll$ } from "./chat-layout.ts";
import { pageSignal$ } from "../page-signal.ts";
import { detach, Reason } from "../utils.ts";

export interface WorkspaceLayoutThreads {
  readonly left: ChatPanelSignals | null;
  readonly right: ChatPanelSignals | null;
}

/** A render acknowledges the exact thread pair it committed, not a newer route. */
export const workspaceLayoutThreads$ = computed(
  (get): WorkspaceLayoutThreads => {
    return {
      left: get(currentLeftThread$),
      right: get(currentRightThread$),
    };
  },
);

interface WorkspaceLayoutOwner {
  readonly element: HTMLElement;
  readonly key: string | undefined;
  readonly starting: string | undefined;
  readonly resizing: string | undefined;
}

interface WorkspaceLayoutCommit {
  readonly root: HTMLDivElement;
  readonly threads: WorkspaceLayoutThreads;
  readonly leftContainer: HTMLElement | null;
  readonly rightContainer: HTMLElement | null;
  readonly owners: readonly WorkspaceLayoutOwner[];
}

function sameOwners(
  previous: readonly WorkspaceLayoutOwner[],
  current: readonly WorkspaceLayoutOwner[],
): boolean {
  return (
    previous.length === current.length &&
    previous.every((owner, index) => {
      const next = current[index];
      return (
        next !== undefined &&
        owner.element === next.element &&
        owner.key === next.key &&
        owner.starting === next.starting &&
        owner.resizing === next.resizing
      );
    })
  );
}

/** Only sibling geometry commits share this cache; content and native events do not. */
export function createWorkspaceLayoutCommit(
  sync$: Command<void, []>,
  root$: Computed<HTMLDivElement | null>,
) {
  const lastCommit$ = state<WorkspaceLayoutCommit | null>(null);
  const reset$ = command(({ set }): void => {
    set(lastCommit$, null);
  });
  const commit$ = command(
    ({ get, set }, threads: WorkspaceLayoutThreads): void => {
      const root = get(root$);
      if (!root || threads !== get(workspaceLayoutThreads$)) {
        return;
      }
      const owners = Array.from(
        root.querySelectorAll<HTMLElement>("[data-sidebar-layout-owner]"),
        (element): WorkspaceLayoutOwner => {
          return {
            element,
            key: element.dataset.sidebarLayoutKey,
            starting: element.dataset.sidebarLayoutStarting,
            resizing: element.dataset.sidebarLayoutResizing,
          };
        },
      );
      const leftContainer = threads.left
        ? get(threads.left.scrollContainer$)
        : null;
      const rightContainer = threads.right
        ? get(threads.right.scrollContainer$)
        : null;
      const previous = get(lastCommit$);
      const cacheable =
        owners.length > 0 &&
        owners.every((owner) => {
          return owner.key !== undefined;
        }) &&
        (!threads.left || leftContainer?.isConnected === true) &&
        (!threads.right || rightContainer?.isConnected === true);
      if (
        cacheable &&
        previous?.root === root &&
        previous.threads === threads &&
        previous.leftContainer === leftContainer &&
        previous.rightContainer === rightContainer &&
        sameOwners(previous.owners, owners)
      ) {
        return;
      }
      // Record before sync/restore can trigger a render or asynchronous work.
      set(
        lastCommit$,
        cacheable
          ? { root, threads, leftContainer, rightContainer, owners }
          : null,
      );
      set(sync$);
      detach(
        set(restoreChatLayoutScroll$, get(pageSignal$)),
        Reason.DomCallback,
        "workspace geometry commit",
      );
    },
  );
  return { commit$, reset$ };
}
