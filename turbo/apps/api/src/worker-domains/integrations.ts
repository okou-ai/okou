import { createAppWithRoutes } from "../app-factory-base";
import { createApiWorker } from "../worker-runtime";
import { configureChatRunFinishedEventDispatcher$ } from "../signals/services/chat-run-finished-event-registration.service";
import { INTEGRATIONS_ROUTES } from "../signals/route-groups/integrations";

export default createApiWorker((signal) => {
  return createAppWithRoutes({
    signal,
    routes: INTEGRATIONS_ROUTES,
    initializeServices$: configureChatRunFinishedEventDispatcher$,
  });
});
