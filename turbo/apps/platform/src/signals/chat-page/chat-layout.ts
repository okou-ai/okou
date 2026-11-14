import type { Editor, EditorEvents } from "@tiptap/core";
import { command, type Command } from "ccstate";
import {
  onDomEventFn,
  onRef,
  resetSignal,
  waitForBrowserPaint,
} from "../utils.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-thread-pane-state.ts";

// Keep aligned with the shell's `hidden xl:flex` transcript visibility.
const THREAD_SIDEBAR_SPLIT_MEDIA_QUERY = "(min-width: 80rem)";
const resetHiddenLayoutRestore$ = resetSignal();

/** Preserve before publication, while the narrow transcript still has geometry. */
export const prepareNarrowSidebarScroll$ = command(({ get, set }) => {
  set(resetHiddenLayoutRestore$);
  if (window.matchMedia(THREAD_SIDEBAR_SPLIT_MEDIA_QUERY).matches) {
    return;
  }
  for (const thread of new Set([
    get(currentLeftThread$),
    get(currentRightThread$),
  ])) {
    if (thread) {
      set(thread.preserveHiddenLayout$);
    }
  }
});

/** The closing command owns the reveal; a reopen cancels only this await. */
export const restoreNarrowSidebarScroll$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const restoreSignal = set(resetHiddenLayoutRestore$, signal);
    const threads = new Set([
      get(currentLeftThread$),
      get(currentRightThread$),
    ]);
    if (
      !Array.from(threads).some((thread) => {
        return thread !== null && set(thread.hasPreservedHiddenLayout$);
      })
    ) {
      return;
    }
    await waitForBrowserPaint(restoreSignal);
    signal.throwIfAborted();
    if (restoreSignal.aborted) {
      return;
    }
    const currentThreads = new Set([
      get(currentLeftThread$),
      get(currentRightThread$),
    ]);
    const restorations = await Promise.allSettled(
      Array.from(threads, async (thread) => {
        if (thread && currentThreads.has(thread)) {
          await set(thread.restoreHiddenLayout$, restoreSignal);
        }
      }),
    );
    signal.throwIfAborted();
    for (const restoration of restorations) {
      // Reopen supersedes only layout work, not the navigation that adopted it.
      if (
        restoration.status === "rejected" &&
        (!restoreSignal.aborted || restoration.reason !== restoreSignal.reason)
      ) {
        throw restoration.reason;
      }
    }
  },
);

/** Reflow keeps measured reading anchors and completes hidden initial requests. */
export const restoreChatLayoutScroll$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const threads = new Set([
      get(currentLeftThread$),
      get(currentRightThread$),
    ]);
    await Promise.all(
      Array.from(threads, async (thread) => {
        if (thread) {
          await set(thread.restoreScrollPositionForLayout$, signal);
        }
      }),
    );
  },
);

/** Transactions acknowledge the editor DOM even when draft sync suppresses onUpdate. */
export function createChatComposerLayoutOnRef(
  editor: Editor,
  restoreScrollPosition$: Command<Promise<void>, [AbortSignal]>,
) {
  return onRef(
    command(({ set }, _element: HTMLElement, signal: AbortSignal) => {
      const restore = onDomEventFn(
        async ({
          transaction,
          appendedTransactions,
        }: EditorEvents["transaction"]) => {
          if (
            transaction.docChanged ||
            appendedTransactions.some((appended) => {
              return appended.docChanged;
            })
          ) {
            await set(restoreScrollPosition$, signal);
          }
        },
      );
      editor.on("transaction", restore);
      signal.addEventListener(
        "abort",
        () => {
          editor.off("transaction", restore);
        },
        { once: true },
      );
    }),
  );
}
