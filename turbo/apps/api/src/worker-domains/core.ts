import { createAppWithRoutes } from "../app-factory-base";
import { createApiWorker } from "../worker-runtime";
import { configureChatRunFinishedEventDispatcher$ } from "../signals/services/chat-run-finished-event-registration.service";
import { CORE_ROUTES } from "../signals/route-groups/core";

export default createApiWorker((signal) => {
  return createAppWithRoutes({
    signal,
    routes: CORE_ROUTES,
    initializeServices$: configureChatRunFinishedEventDispatcher$,
  });
});
