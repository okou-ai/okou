import { command } from "ccstate";

import {
  configureChatRunFinishedEventCommand$,
  configureProjectRecallCommand$,
} from "./chat-run-finished-event-dispatch.service";
import { recallProjectForUnread$ } from "./project.service";
import { dispatchChatRunFinishedAutomationEvents$ } from "./chat-run-finished-automation-event.service";

/** Wire the chat-run-finished implementation into the request's command graph. */
export const configureChatRunFinishedEventDispatcher$ = command(
  ({ set }): void => {
    set(configureProjectRecallCommand$, recallProjectForUnread$);
    set(
      configureChatRunFinishedEventCommand$,
      dispatchChatRunFinishedAutomationEvents$,
    );
  },
);
