import { createAppWithRoutes } from "../app-factory-base";
import { createApiWorker } from "../worker-runtime";
import { configureChatRunFinishedEventDispatcher$ } from "../signals/services/chat-run-finished-event-registration.service";
import { EXECUTION_ROUTES } from "./routes-execution";

export default createApiWorker((signal) => {
  return createAppWithRoutes({
    signal,
    routes: EXECUTION_ROUTES,
    initializeServices$: configureChatRunFinishedEventDispatcher$,
  });
});
