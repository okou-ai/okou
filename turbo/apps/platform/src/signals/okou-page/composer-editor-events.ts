import type { Editor } from "@tiptap/core";
import { command, state } from "ccstate";
import { onRef } from "../utils.ts";

interface ComposerEditorHandlers {
  readonly keyDown: (event: KeyboardEvent) => boolean;
  readonly paste: (event: ClipboardEvent) => boolean;
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
      const { handleKeyDown, handlePaste } = editor.options.editorProps;
      const { handleDOMEvents } = editor.options.editorProps;
      editor.setOptions({
        editorProps: {
          ...editor.options.editorProps,
          handleDOMEvents: {
            ...handleDOMEvents,
            keydown: (view, event) => {
              // ProseMirror skips handleKeyDown for every Chrome Android Enter
              // (including hardware send shortcuts). Its native DOM hook runs
              // after NodeView stopEvent and requires explicit cancellation.
              if (
                /Android \d/.test(navigator.userAgent) &&
                /Chrome\/\d/.test(navigator.userAgent) &&
                event.key === "Enter" &&
                !view.composing &&
                handlers.keyDown(event)
              ) {
                event.preventDefault();
                return true;
              }
              return handleDOMEvents?.keydown?.(view, event) ?? false;
            },
          },
          handleKeyDown: (_view, event) => {
            return handlers.keyDown(event);
          },
          handlePaste: (_view, event) => {
            return handlers.paste(event);
          },
        },
      });
      signal.addEventListener("abort", () => {
        editor.setOptions({
          editorProps: {
            ...editor.options.editorProps,
            handleKeyDown,
            handlePaste,
            handleDOMEvents,
          },
        });
        set(handlers$, null);
      });
    }),
  );
  return { commit$, mountRef$ };
}
