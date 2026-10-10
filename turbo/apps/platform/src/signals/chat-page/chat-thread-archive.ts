import { command } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { navigateToChat$ } from "../okou-page/nav.ts";
import { rootSignal$ } from "../root-signal.ts";
import { navigateTo$ } from "../route.ts";
import { onDomEventFn } from "../utils.ts";
import { setChatThreadArchived$ } from "./chat-event.ts";
import { chatThreadMetaMap$ } from "./chat-thread-event-sourcing.ts";

// Undo is a quiet text action; the primary fill is reserved for commitments.
const UNDO_ACTION_CLASS_NAMES = {
  actionButton: "underline-offset-4 hover:underline active:opacity-80",
} as const;
const UNDO_ACTION_STYLE = {
  background: "transparent",
  color: "hsl(var(--foreground))",
  fontSize: "inherit",
  height: "auto",
  lineHeight: "1.5",
  padding: 0,
} as const;

function archiveToastDescription(archived: boolean, muted: boolean) {
  if (!archived) {
    return undefined;
  }
  // The API brings an archived chat back on a new reply unless it is muted.
  return muted
    ? i18n.t(($) => {
        return $.chat.toasts.archivedMutedDescription;
      })
    : i18n.t(($) => {
        return $.chat.toasts.archivedDescription;
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

    toast.success(
      archived
        ? i18n.t(($) => {
            return $.chat.toasts.archived;
          })
        : i18n.t(($) => {
            return $.chat.toasts.unarchived;
          }),
      {
        description: archiveToastDescription(archived, meta?.muted === true),
        actionButtonStyle: UNDO_ACTION_STYLE,
        classNames: UNDO_ACTION_CLASS_NAMES,
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
      },
    );
  },
);
