import { command, computed } from "ccstate";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-thread-pane-state.ts";
import type { ChatPanelSignals } from "./chat-panel-signals.ts";
import type { MailDraftSignals } from "./mail-draft.ts";
import type {
  ArtifactRefInput,
  ThreadSidebarOpenTarget,
  ThreadSidebarTarget,
} from "./thread-sidebar.ts";
import { pageSignal$ } from "../page-signal.ts";

// ---------------------------------------------------------------------------
// Page-level coordinator for the thread-owned utility sidebar. Sidebar state
// lives in the initiating thread's `ChatPanelSignals`; this module only
// enforces "at most one utility sidebar per page" across the two thread panes
// and routes every entry point into that thread-owned state.
// ---------------------------------------------------------------------------

/**
 * The single open utility sidebar on the page, with its owning thread. Null
 * while every pane's sidebar is closed.
 */
export const activeThreadSidebar$ = computed(
  (
    get,
  ): {
    readonly thread: ChatPanelSignals;
    readonly target: ThreadSidebarTarget;
    readonly animateEntry: boolean;
  } | null => {
    for (const thread of [get(currentLeftThread$), get(currentRightThread$)]) {
      if (!thread) {
        continue;
      }
      const target = get(thread.sidebar.target$);
      if (target) {
        return {
          thread,
          target,
          animateEntry: get(thread.sidebar.animateEntry$),
        };
      }
    }
    return null;
  },
);

export const syncActiveBrowserFitAction$ = command(({ get, set }) => {
  const active = get(activeThreadSidebar$);
  if (active?.target.type !== "browser") {
    return;
  }
  set(active.thread.browserSessionSignals.syncFitActionVisibility$);
});

const closeOtherThreadSidebars$ = command(
  ({ get, set }, thread: ChatPanelSignals): void => {
    for (const other of [get(currentLeftThread$), get(currentRightThread$)]) {
      if (other && other.threadId !== thread.threadId) {
        set(other.sidebar.close$);
      }
    }
  },
);

const openOnThread$ = command(
  (
    { set },
    thread: ChatPanelSignals,
    target: ThreadSidebarOpenTarget,
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    set(closeOtherThreadSidebars$, thread);
    set(thread.sidebar.open$, target, signal);
  },
);

const openAttachmentOnThread$ = command(
  (
    { set },
    thread: ChatPanelSignals,
    input: ArtifactRefInput,
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    set(closeOtherThreadSidebars$, thread);
    set(thread.sidebar.openAttachment$, input, signal);
  },
);

export const openThreadArtifacts$ = command(
  ({ get, set }, thread: ChatPanelSignals) => {
    set(openOnThread$, thread, { type: "artifacts" }, get(pageSignal$));
  },
);

export const openThreadAutomations$ = command(
  ({ get, set }, thread: ChatPanelSignals) => {
    set(openOnThread$, thread, { type: "automations" }, get(pageSignal$));
  },
);

/**
 * The card hands over its own signals, which carry the owning thread id, so
 * the sidebar target holds everything its panel renders from — no registry
 * lookup on either side.
 */
export const openThreadMailDraft$ = command(
  ({ get, set }, signals: MailDraftSignals) => {
    const thread = [get(currentLeftThread$), get(currentRightThread$)].find(
      (candidate) => {
        return candidate?.threadId === signals.threadId;
      },
    );
    if (!thread) {
      return;
    }
    set(
      openOnThread$,
      thread,
      { type: "email-draft", signals },
      get(pageSignal$),
    );
  },
);

export const openThreadBrowserSession$ = command(
  ({ get, set }, threadId: string) => {
    const thread = [get(currentLeftThread$), get(currentRightThread$)].find(
      (candidate) => {
        return candidate?.threadId === threadId;
      },
    );
    if (!thread) {
      return;
    }
    set(openOnThread$, thread, { type: "browser" }, get(pageSignal$));
  },
);

/**
 * Promote a message attachment from the lightbox into split view. The lightbox
 * is page-global, so the main (left) thread hosts the sidebar.
 */
export const openThreadArtifactSplitView$ = command(
  ({ get, set }, input: ArtifactRefInput) => {
    const thread = get(currentLeftThread$) ?? get(currentRightThread$);
    if (!thread) {
      return;
    }
    set(openAttachmentOnThread$, thread, input, get(pageSignal$));
  },
);

/**
 * Route an artifact click into an artifact sidebar the page already has open,
 * replacing its content in place. Returns false when the page has no artifact
 * sidebar, leaving the caller on its own preview surface.
 */
export const openArtifactInOpenSidebar$ = command(
  ({ get, set }, input: ArtifactRefInput): boolean => {
    const active = get(activeThreadSidebar$);
    if (
      active?.target.type !== "artifacts" &&
      active?.target.type !== "artifact"
    ) {
      return false;
    }
    // The owning thread already holds the page's only utility sidebar, so this
    // swaps its content without closing and reopening the pane.
    set(active.thread.sidebar.openAttachment$, input, get(pageSignal$));
    return true;
  },
);

/**
 * Card selection indicators for which mail draft / browser session the open
 * sidebar is showing, page-wide.
 */
export const activeSidebarMailDraftId$ = computed((get): string | null => {
  const active = get(activeThreadSidebar$);
  return active?.target.type === "email-draft"
    ? active.target.signals.mailDraftId
    : null;
});

export const activeSidebarBrowserThreadId$ = computed((get): string | null => {
  const active = get(activeThreadSidebar$);
  return active?.target.type === "browser" ? active.thread.threadId : null;
});
