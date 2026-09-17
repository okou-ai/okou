import type { Editor, EditorEvents } from "@tiptap/core";
import { command, type Command } from "ccstate";
import { animationFrame } from "signal-timers";
import { onDomEventFn, onRef, resetSignal } from "../utils.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-thread-pane-state.ts";

/** Both panes share the composer/sidebar layout, but keep separate reading anchors. */
const restoreChatLayoutScroll$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const threads = new Set([
      get(currentLeftThread$),
      get(currentRightThread$),
    ]);
    await Promise.all(
      Array.from(threads, async (thread) => {
        if (thread) {
          await set(thread.restoreScrollPosition$, signal);
        }
      }),
    );
  },
);

export interface ChatLayoutSignals {
  readonly transitionOnRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
}

/** Each mounted surface owns its overlapping sidebar transitions. */
export function createChatLayoutSignals(): ChatLayoutSignals {
  const resetFrames$ = resetSignal();
  const transitionOnRef$ = onRef(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      const transitions = new Map<EventTarget, Set<string>>();
      let frames: AbortSignal | null = null;
      const startFrames = (frameSignal: AbortSignal) => {
        animationFrame(
          onDomEventFn(async () => {
            await set(restoreChatLayoutScroll$, frameSignal);
            if (!frameSignal.aborted) {
              startFrames(frameSignal);
            }
          }),
          { signal: frameSignal },
        );
      };
      const handleTransition = onDomEventFn(async (event: TransitionEvent) => {
        if (
          !event.target ||
          !["width", "flex-basis"].includes(event.propertyName)
        ) {
          return;
        }
        if (event.type === "transitionrun") {
          const properties = transitions.get(event.target) ?? new Set<string>();
          properties.add(event.propertyName);
          transitions.set(event.target, properties);
          if (!frames) {
            frames = set(resetFrames$, signal);
            startFrames(frames);
          }
        } else {
          const properties = transitions.get(event.target);
          properties?.delete(event.propertyName);
          if (properties?.size === 0) {
            transitions.delete(event.target);
          }
          if (transitions.size === 0) {
            if (frames && !frames.aborted) {
              set(resetFrames$);
            }
            frames = null;
          }
        }
        await set(restoreChatLayoutScroll$, signal);
      });
      for (const type of [
        "transitionrun",
        "transitionend",
        "transitioncancel",
      ] as const) {
        element.addEventListener(type, handleTransition, { signal });
      }
    }),
  );
  return { transitionOnRef$ };
}

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
