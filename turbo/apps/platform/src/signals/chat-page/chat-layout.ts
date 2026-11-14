import type { Editor, EditorEvents } from "@tiptap/core";
import { command, type Command } from "ccstate";
import { onDomEventFn, onRef } from "../utils.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-thread-pane-state.ts";

/** Reflow keeps native reading anchors; only bottom-follow needs a layout write. */
export const restoreChatLayoutScroll$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const threads = new Set([
      get(currentLeftThread$),
      get(currentRightThread$),
    ]);
    await Promise.all(
      Array.from(threads, async (thread) => {
        if (thread && get(thread.threadScrollPosition$) === null) {
          await set(thread.restoreScrollPosition$, signal);
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
