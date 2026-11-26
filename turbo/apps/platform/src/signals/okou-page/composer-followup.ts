import type { Editor } from "@tiptap/core";
import { command, computed, type Computed } from "ccstate";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import type { RecommendedFollowupSource } from "../chat-page/chat-event-projection-signals.ts";
import { focusedChatThread$ } from "../chat-page/chat-thread-pane-state.ts";
import { onRef } from "../utils.ts";
import { shouldHandleShortcutPress } from "./nav.ts";
import type { WorkflowComposerSignals } from "./tiptap-workflow-composer.ts";

export function workflowComposerHasContent(editor: Editor): boolean {
  let textblockCount = 0;
  for (let index = 0; index < editor.state.doc.childCount; index++) {
    const node = editor.state.doc.child(index);
    if (!node.isTextblock) {
      continue;
    }
    textblockCount += 1;
    if (node.content.size > 0 || textblockCount > 1) {
      return true;
    }
  }
  return false;
}

export function createComposerFollowupSignals(
  source$: Computed<RecommendedFollowupSource | null>,
  composer: WorkflowComposerSignals,
  sessionActive$: Computed<boolean>,
) {
  const { editor } = composer;
  const prompt$ = computed((get) => {
    return get(source$)?.followups[0]?.prompt;
  });
  const readAvailablePrompt$ = command(({ get }) => {
    if (
      get(composer.hasInput$) ||
      get(sessionActive$) ||
      editor.isDestroyed ||
      editor.view.composing ||
      workflowComposerHasContent(editor)
    ) {
      return undefined;
    }
    return get(prompt$);
  });
  const accept$ = command(({ set }) => {
    const prompt = set(readAvailablePrompt$);
    if (prompt) {
      set(composer.insertText$, prompt);
    }
  });

  // Bind only while the placeholder offers this action. Local key handlers
  // get first use of Tab before it bubbles to the document.
  const setShortcutButtonRef$ = onRef(
    command(({ set }, button: HTMLButtonElement, signal: AbortSignal) => {
      const doc = button.ownerDocument;
      setupGlobalShortcut(
        {
          tab: {
            allowInEditableTarget: true,
            shouldHandle(event) {
              if (
                !shouldHandleShortcutPress(event) ||
                set(focusedChatThread$, doc)?.composer.editor.editor !==
                  editor ||
                !set(readAvailablePrompt$)
              ) {
                return false;
              }
              const target = event.target;
              const otherInput =
                target !== editor.view.dom &&
                target instanceof Element &&
                target.closest(
                  'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
                );
              return (
                !otherInput &&
                !doc.querySelector('[role="menu"], [role="listbox"]') &&
                button.checkVisibility({ visibilityProperty: true })
              );
            },
            run() {
              set(accept$);
            },
          },
        },
        signal,
        { doc, capture: false },
      );
    }),
  );
  return { prompt$, accept$, setShortcutButtonRef$ };
}
