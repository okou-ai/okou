import { command } from "ccstate";
import { setChatThreadOnlyArchived$ } from "../chat-page/chat-thread-only-archived.ts";
import {
  chatThreadOnlyUnread$,
  setChatThreadOnlyUnread$,
} from "../chat-page/chat-thread-only-unread.ts";
import { setChatThreadOnlyMuted$ } from "../chat-page/chat-thread-only-muted.ts";

export const setChatThreadUnreadFilter$ = command(
  ({ set }, unreadOnly: boolean) => {
    set(setChatThreadOnlyMuted$, false);
    set(setChatThreadOnlyArchived$, false);
    set(setChatThreadOnlyUnread$, unreadOnly);
  },
);

export const setChatThreadArchivedFilter$ = command(({ set }) => {
  set(setChatThreadOnlyMuted$, false);
  set(setChatThreadOnlyUnread$, false);
  set(setChatThreadOnlyArchived$, true);
});

export const setChatThreadMutedFilter$ = command(({ set }) => {
  set(setChatThreadOnlyUnread$, false);
  set(setChatThreadOnlyArchived$, false);
  set(setChatThreadOnlyMuted$, true);
});

export const toggleChatThreadUnreadFilter$ = command(({ get, set }) => {
  set(setChatThreadUnreadFilter$, !get(chatThreadOnlyUnread$));
});
