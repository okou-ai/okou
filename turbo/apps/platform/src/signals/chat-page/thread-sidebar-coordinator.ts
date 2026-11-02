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
import { animationFrame, delay } from "signal-timers";
import { hash$, searchParams$, updateSearchParams$ } from "../route.ts";
import {
  threadMailLocation$,
  threadMailParams,
  type ThreadMailDestination,
} from "./thread-mail-location.ts";

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
    const mailLocation = get(threadMailLocation$);
    if (mailLocation?.view === "list") {
      return null;
    }
    for (const thread of [get(currentLeftThread$), get(currentRightThread$)]) {
      // History can restore mail while another pane retains its utility target.
      if (
        !thread ||
        (mailLocation && mailLocation.threadId !== thread.threadId)
      ) {
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

export const activeThreadSidebarFullscreen$ = computed((get) => {
  const active = get(activeThreadSidebar$);
  return active ? get(active.thread.sidebar.fullscreen$) : false;
});

/** The sidebar shell acknowledges its committed panel layout to embedded viewports. */
export const syncActiveSidebarLayout$ = command(({ get, set }) => {
  const active = get(activeThreadSidebar$);
  if (active?.target.type === "artifact") {
    set(active.thread.sidebar.imageCanvas.syncLayout$);
  } else if (active?.target.type === "browser") {
    set(active.thread.browserSessionSignals.browser.syncLayout$);
  }
});

const closeOtherThreadSidebars$ = command(
  ({ get, set }, thread: ChatPanelSignals): void => {
    for (const other of [get(currentLeftThread$), get(currentRightThread$)]) {
      if (other && other.threadId !== thread.threadId) {
        set(other.sidebar.dismiss$);
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

export const closeThreadMailDraft$ = command(
  ({ get, set }, thread: ChatPanelSignals, draft: MailDraftSignals): void => {
    const target = get(thread.sidebar.target$);
    if (target?.type === "email-draft" && target.signals === draft) {
      set(thread.sidebar.close$);
    }
  },
);

/** The deleted output's sidebar disappears; keyboard input returns to its chat. */
export const closeDeletedThreadArtifact$ = command(
  ({ set }, thread: ChatPanelSignals, signal: AbortSignal) => {
    set(thread.sidebar.close$);
    animationFrame(
      () => {
        set(thread.composer.editor.focus$);
      },
      { signal },
    );
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

/** Open a directory summary through the existing on-demand detail preview. */
export const openThreadCatalogArtifact$ = command(
  async (
    { set },
    thread: ChatPanelSignals,
    artifactId: string,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    set(closeOtherThreadSidebars$, thread);
    await set(thread.sidebar.openCatalogArtifact$, artifactId, signal);
  },
);

const changeThreadMailLocation$ = command(
  (
    { get, set },
    thread: ChatPanelSignals,
    destination: ThreadMailDestination,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const params = threadMailParams(
      get(searchParams$),
      thread.threadId,
      destination,
    );
    if (params.toString() === get(searchParams$).toString()) {
      return;
    }
    for (const pane of [get(currentLeftThread$), get(currentRightThread$)]) {
      if (pane) {
        set(pane.sidebar.dismiss$);
      }
    }
    if (destination.view === "detail") {
      const href = `/mail/drafts/${destination.mailDraftId}`;
      set(thread.mail.register$, {
        mailDraftId: destination.mailDraftId,
        href,
        originalUrl: new URL(href, window.location.origin).href,
      });
    }
    set(updateSearchParams$, params, {}, get(hash$));
  },
);

export const openThreadMailList$ = command(
  ({ get, set }, thread: ChatPanelSignals) => {
    set(changeThreadMailLocation$, thread, { view: "list" }, get(pageSignal$));
  },
);

/** Inline cards keep their direct-detail navigation, now represented in the URL. */
export const openThreadMailDraft$ = command(
  ({ get, set }, signals: MailDraftSignals) => {
    const thread = [get(currentLeftThread$), get(currentRightThread$)].find(
      (candidate) => {
        return candidate?.threadId === signals.threadId;
      },
    );
    if (thread) {
      set(
        changeThreadMailLocation$,
        thread,
        { view: "detail", mailDraftId: signals.mailDraftId },
        get(pageSignal$),
      );
    }
  },
);

async function waitForMailLayout(signal: AbortSignal): Promise<void> {
  // View Transitions pause animation frames while React and Floating UI commit.
  await delay(0, { signal });
  signal.throwIfAborted();
  await delay(0, { signal });
  signal.throwIfAborted();
}

/** Navigation commits before the destination reads its data. */
export const navigateThreadMail$ = command(
  async (
    { set },
    thread: ChatPanelSignals,
    destination: ThreadMailDestination,
    signal: AbortSignal,
  ) => {
    if (
      !("startViewTransition" in document) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      set(changeThreadMailLocation$, thread, destination, signal);
      return;
    }
    await document.startViewTransition({
      types: ["thread-mail"],
      update: async () => {
        set(changeThreadMailLocation$, thread, destination, signal);
        await waitForMailLayout(signal);
      },
    }).finished;
    signal.throwIfAborted();
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

/** Open directly on the initiating thread, replacing any utility sidebar. */
export const openArtifactSidebar$ = command(
  ({ get, set }, input: ArtifactRefInput, threadId?: string): boolean => {
    const left = get(currentLeftThread$);
    const right = get(currentRightThread$);
    const thread = threadId
      ? [left, right].find((candidate) => {
          return candidate?.threadId === threadId;
        })
      : (get(activeThreadSidebar$)?.thread ?? left ?? right);
    if (!thread) {
      return false;
    }
    set(openAttachmentOnThread$, thread, input, get(pageSignal$));
    return true;
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
