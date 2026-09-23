import type { Editor } from "@tiptap/core";
import { command, state } from "ccstate";
import { onRef } from "../utils.ts";

interface ComposerEditorHandlers {
  readonly keyDown: (event: KeyboardEvent) => boolean;
  readonly paste: (event: ClipboardEvent) => boolean;
}

function needsNativeEnterEvent(): boolean {
  const { userAgent, vendor, maxTouchPoints } = navigator;
  // Match ProseMirror 1.42.3's Android Chrome and iOS/iPadOS input paths.
  // https://github.com/ProseMirror/prosemirror-view/blob/1.42.3/src/browser.ts
  return (
    (/Android \d/.test(userAgent) && /Chrome\/\d/.test(userAgent)) ||
    (/Apple Computer/.test(vendor) &&
      (/Mobile\/\w+/.test(userAgent) || maxTouchPoints > 2))
  );
}

/** Bind committed React callbacks without changing the editor's mount lifetime. */
export function createComposerEditorEvents(editor: Editor) {
  const handlers$ = state<ComposerEditorHandlers | null>(null);
  const commit$ = command(({ set }, handlers: ComposerEditorHandlers) => {
    set(handlers$, handlers);
  });
  const mountRef$ = onRef(
    command(({ get, set }, _element: HTMLElement, signal: AbortSignal) => {
      const handlers = get(handlers$);
      if (!handlers) {
        throw new Error("Composer handlers must be committed before binding");
      }
      const view = editor.view;
      const { handleKeyDown, handlePaste, handleDOMEvents } = view.props;
      view.setProps({
        handleDOMEvents: {
          ...handleDOMEvents,
          keydown: (currentView, event) => {
            // ProseMirror skips Android Enter and replays iOS Enter without
            // modifiers. Handle the original event so Shift-Enter splits once
            // and hardware Enter keeps the send preference. Unhandled mobile
            // newlines still reach ProseMirror. This hook runs after NodeView
            // stopEvent and requires explicit cancellation when handled.
            if (
              event.key === "Enter" &&
              needsNativeEnterEvent() &&
              !currentView.composing &&
              handlers.keyDown(event)
            ) {
              event.preventDefault();
              return true;
            }
            return handleDOMEvents?.keydown?.(currentView, event) ?? false;
          },
        },
        handleKeyDown: (_view, event) => {
          return handlers.keyDown(event);
        },
        handlePaste: (_view, event) => {
          return handlers.paste(event);
        },
      });
      signal.addEventListener("abort", () => {
        if (!view.isDestroyed) {
          view.setProps({
            handleKeyDown,
            handlePaste,
            handleDOMEvents,
          });
        }
        set(handlers$, null);
      });
    }),
  );
  return { commit$, mountRef$ };
}
