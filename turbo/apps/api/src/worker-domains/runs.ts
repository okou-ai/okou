import { createAppWithRoutes } from "../app-factory-runtime";
import { createWorkerHandler } from "../worker-runtime";
import type { RouteEntry } from "../signals/route-entry";
import { runDetailRoutes } from "../signals/routes/run-detail";
import { runsRoutes } from "../signals/routes/runs";
import { runsCancelRoutes } from "../signals/routes/runs-cancel";
import { configureChatRunFinishedEventDispatcher$ } from "../signals/services/chat-run-finished-event-registration.service";

const roleRoutes: readonly RouteEntry[] = [
  ...runDetailRoutes,
  ...runsRoutes,
  ...runsCancelRoutes,
];

export default createWorkerHandler((signal) => {
  return createAppWithRoutes({
    signal,
    routes: roleRoutes,
    initializeServices$: configureChatRunFinishedEventDispatcher$,
  });
});
