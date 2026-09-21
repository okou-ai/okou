import { command } from "ccstate";
import {
  chatThreadOnlyUnread$,
  setChatThreadOnlyUnread$,
} from "../chat-page/chat-thread-only-unread.ts";
import { setSessionListCollapsed$ } from "./sidebar-state.ts";

export const setChatThreadUnreadFilter$ = command(
  ({ set }, unreadOnly: boolean) => {
    set(setChatThreadOnlyUnread$, unreadOnly);
    if (unreadOnly) {
      set(setSessionListCollapsed$, false);
    }
  },
);

export const toggleChatThreadUnreadFilter$ = command(({ get, set }) => {
  set(setChatThreadUnreadFilter$, !get(chatThreadOnlyUnread$));
});
