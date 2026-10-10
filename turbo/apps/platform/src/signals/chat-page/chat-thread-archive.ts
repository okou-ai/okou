import { command } from "ccstate";
import { TEXT_TOAST_ACTION, toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { navigateToChat$ } from "../okou-page/nav.ts";
import { rootSignal$ } from "../root-signal.ts";
import { navigateTo$ } from "../route.ts";
import { onDomEventFn } from "../utils.ts";
import { setChatThreadArchived$ } from "./chat-event.ts";
import { chatThreadMetaMap$ } from "./chat-thread-event-sourcing.ts";

// One line says what happened and when the chat comes back. The API brings an
// archived chat back on a new reply unless it is muted.
function archiveToastMessage(archived: boolean, muted: boolean) {
  if (!archived) {
    return i18n.t(($) => {
      return $.chat.toasts.unarchived;
    });
  }
  return muted
    ? i18n.t(($) => {
        return $.chat.toasts.archivedMuted;
      })
    : i18n.t(($) => {
        return $.chat.toasts.archived;
      });
}

// Every archive entry point shares this feedback: the row leaves the list, so
// the toast says where it went and offers the inverse action.
export const setChatThreadArchivedWithFeedback$ = command(
  async (
    { get, set },
    {
      threadId,
      archived,
      leaveToAgentId,
    }: {
      readonly threadId: string;
      readonly archived: boolean;
      // The mobile header fills the screen with the thread, so archiving
      // returns to the agent's list instead of staying on a hidden chat.
      readonly leaveToAgentId?: string;
    },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const meta = get(chatThreadMetaMap$).get(threadId);
    if (meta?.archived === archived) {
      return;
    }
    const leaving = archived && leaveToAgentId !== undefined;
    // The archive is optimistic, so leave the thread without waiting for the
    // request. The caller passes a root-scoped signal because this navigation
    // aborts the current page signal.
    await Promise.all([
      set(setChatThreadArchived$, { threadId, archived }, signal),
      leaving
        ? set(
            navigateTo$,
            "/agents/:agentId/chat",
            { pathParams: { agentId: leaveToAgentId } },
            signal,
          )
        : undefined,
    ]);
    signal.throwIfAborted();

    toast.success(archiveToastMessage(archived, meta?.muted === true), {
      ...TEXT_TOAST_ACTION,
      action: {
        label: i18n.t(($) => {
          return $.chat.toasts.undo;
        }),
        onClick: onDomEventFn(async () => {
          await set(
            setChatThreadArchived$,
            { threadId, archived: !archived },
            get(rootSignal$),
          );
          if (leaving) {
            set(navigateToChat$, threadId);
          }
        }),
      },
    });
  },
);
