import { createAppWithRoutes } from "../app-factory-runtime";
import { createWorkerHandler } from "../worker-runtime";
import type { RouteEntry } from "../signals/route-entry";
import { chatThreadCatchUpRoutes } from "../signals/routes/chat-thread-catch-up";
import { chatSearchRoutes } from "../signals/routes/chat-search";
import { chatInputStatusRoutes } from "../signals/routes/chat-input-status";
import { chatEventsRoutes } from "../signals/routes/chat-events";
import { configureChatRunFinishedEventDispatcher$ } from "../signals/services/chat-run-finished-event-registration.service";

const roleRoutes: readonly RouteEntry[] = [
  ...chatThreadCatchUpRoutes,
  ...chatSearchRoutes,
  ...chatInputStatusRoutes,
  ...chatEventsRoutes,
];

export default createWorkerHandler((signal) => {
  return createAppWithRoutes({
    signal,
    routes: roleRoutes,
    initializeServices$: configureChatRunFinishedEventDispatcher$,
  });
});
