import { command } from "ccstate";
import {
  renameDialogOpen$,
  renameDialogSession$,
  renameDialogThreadId$,
} from "../okou-page/sidebar-state.ts";
import { chatThreadContainerElement$ } from "./chat-keyboard.ts";

export const restoreChatThreadRenameFocus$ = command(
  (
    { get, set },
    { threadId, session }: { threadId: string | null; session: number },
    signal: AbortSignal,
  ): false | null => {
    const renameSession = get(renameDialogSession$);
    if (
      signal.aborted ||
      !renameSession ||
      renameSession.signal.aborted ||
      get(renameDialogOpen$) ||
      renameSession.id !== session
    ) {
      return false;
    }
    const target = threadId ? set(chatThreadContainerElement$, threadId) : null;
    if (!target?.isConnected) {
      return null;
    }

    // Base UI redirects a non-tabbable finalFocus target to its first tabbable
    // child. Restore the keyboard root itself after its focus manager detaches.
    queueMicrotask(() => {
      if (
        signal.aborted ||
        renameSession.signal.aborted ||
        get(renameDialogOpen$) ||
        get(renameDialogSession$) !== renameSession ||
        get(renameDialogThreadId$) !== threadId ||
        !target.isConnected ||
        !threadId ||
        set(chatThreadContainerElement$, threadId) !== target
      ) {
        return;
      }
      const doc = target.ownerDocument;
      // A still-closing menu does not own the next focus; a newer open popup does.
      if (
        doc.querySelector(
          '[role="dialog"]:not([data-closed]), [role="alertdialog"]:not([data-closed]), [role="menu"]:not([data-closed]), [role="listbox"]:not([data-closed]), [data-slot="popover-content"]:not([data-closed])',
        )
      ) {
        return;
      }
      const active = doc.activeElement;
      if (
        active !== doc.body &&
        active !== doc.documentElement &&
        active !== target
      ) {
        return;
      }
      target.focus({ preventScroll: true });
    });
    return false;
  },
);
