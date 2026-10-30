import { createAppWithRoutes } from "../app-factory-runtime";
import { createWorkerHandler } from "../worker-runtime";
import type { RouteEntry } from "../signals/route-entry";
import { workflowsRoutes } from "../signals/routes/workflows";
import { workflowAutomationsRoutes } from "../signals/routes/workflow-automations";
import { configureChatRunFinishedEventDispatcher$ } from "../signals/services/chat-run-finished-event-registration.service";

const roleRoutes: readonly RouteEntry[] = [
  ...workflowsRoutes,
  ...workflowAutomationsRoutes,
];

export default createWorkerHandler((signal) => {
  return createAppWithRoutes({
    signal,
    routes: roleRoutes,
    initializeServices$: configureChatRunFinishedEventDispatcher$,
  });
});
