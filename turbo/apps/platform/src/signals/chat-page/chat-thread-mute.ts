import { command } from "ccstate";
import { TEXT_TOAST_ACTION, toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { rootSignal$ } from "../root-signal.ts";
import { onDomEventFn } from "../utils.ts";
import { setChatThreadMuted$ } from "./chat-event.ts";
import { chatThreadMetaMap$ } from "./chat-thread-event-sourcing.ts";
import { markChatThreadRead$ } from "./chat-thread-mark-read.ts";

function muteToastMessage(muted: boolean) {
  return muted
    ? i18n.t(($) => {
        return $.chat.toasts.muted;
      })
    : i18n.t(($) => {
        return $.chat.toasts.unmuted;
      });
}

// Every mute entry point shares this feedback. Muting changes nothing on
// screen until the next reply, so the toast says what it suppresses and offers
// the inverse action.
export const setChatThreadMutedWithFeedback$ = command(
  async (
    { get, set },
    { threadId, muted }: { readonly threadId: string; readonly muted: boolean },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    if (get(chatThreadMetaMap$).get(threadId)?.muted === muted) {
      return;
    }
    // Replies that arrived while muted were never shown as unread, so
    // unmuting starts the chat read instead of surfacing them all at once.
    await Promise.all([
      muted ? undefined : set(markChatThreadRead$, { threadId }, signal),
      set(setChatThreadMuted$, { threadId, muted }, signal),
    ]);
    signal.throwIfAborted();

    toast.success(muteToastMessage(muted), {
      ...TEXT_TOAST_ACTION,
      action: {
        label: i18n.t(($) => {
          return $.chat.toasts.undo;
        }),
        // Undo restores the previous state as it was, unread included.
        onClick: onDomEventFn(async () => {
          await set(
            setChatThreadMuted$,
            { threadId, muted: !muted },
            get(rootSignal$),
          );
        }),
      },
    });
  },
);
