import { createAppWithRoutes } from "../app-factory-runtime";
import { createWorkerHandler } from "../worker-runtime";
import type { RouteEntry } from "../signals/route-entry";
import { agentDraftRoutes } from "../signals/routes/agent-draft";
import { agentInstructionsRoutes } from "../signals/routes/agent-instructions";
import { agentsRoutes } from "../signals/routes/agents";
import { agentConnectorAccessRoutes } from "../signals/routes/agent-connector-access";
import { agentSetupPromptRoutes } from "../signals/routes/agent-setup-prompts";
import { initializeNoServices$ } from "../worker-roles/initialize-no-services";

const roleRoutes: readonly RouteEntry[] = [
  ...agentDraftRoutes,
  ...agentInstructionsRoutes,
  ...agentsRoutes,
  ...agentConnectorAccessRoutes,
  ...agentSetupPromptRoutes,
];

export default createWorkerHandler((signal) => {
  return createAppWithRoutes({
    signal,
    routes: roleRoutes,
    initializeServices$: initializeNoServices$,
  });
});
