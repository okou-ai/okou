import { command } from "ccstate";
import { setChatThreadOnlyArchived$ } from "../chat-page/chat-thread-only-archived.ts";
import {
  chatThreadOnlyUnread$,
  setChatThreadOnlyUnread$,
} from "../chat-page/chat-thread-only-unread.ts";
import { setSessionListCollapsed$ } from "./sidebar-state.ts";

export const setChatThreadUnreadFilter$ = command(
  ({ set }, unreadOnly: boolean) => {
    set(setChatThreadOnlyArchived$, false);
    set(setChatThreadOnlyUnread$, unreadOnly);
    if (unreadOnly) {
      set(setSessionListCollapsed$, false);
    }
  },
);

export const setChatThreadArchivedFilter$ = command(({ set }) => {
  set(setChatThreadOnlyUnread$, false);
  set(setChatThreadOnlyArchived$, true);
  set(setSessionListCollapsed$, false);
});

export const toggleChatThreadUnreadFilter$ = command(({ get, set }) => {
  set(setChatThreadUnreadFilter$, !get(chatThreadOnlyUnread$));
});
