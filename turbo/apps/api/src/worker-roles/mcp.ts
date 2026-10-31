import { createAppWithRoutes } from "../app-factory-runtime";
import { createWorkerHandler } from "../worker-runtime";
import type { RouteEntry } from "../signals/route-entry";
import { mcpServerRoutes } from "../signals/routes/mcp-server";
import { configureChatRunFinishedEventDispatcher$ } from "../signals/services/chat-run-finished-event-registration.service";

const roleRoutes: readonly RouteEntry[] = [...mcpServerRoutes];

export default createWorkerHandler((signal) => {
  return createAppWithRoutes({
    signal,
    routes: roleRoutes,
    initializeServices$: configureChatRunFinishedEventDispatcher$,
  });
});
