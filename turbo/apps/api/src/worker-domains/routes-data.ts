// Keep each domain statically scoped; never import the complete ROUTES registry.
import type { RouteEntry } from "../signals/route-entry";
import { webhooksAgentDataRequestRoutes } from "../signals/routes/webhooks-agent-data-request";
import { dataRouterHistoryRoutes } from "../signals/routes/data-router-history";
import { dataRouterToolsRoutes } from "../signals/routes/data-router-tools";
import { cronCleanupXResourceReadsRoutes } from "../signals/routes/cron-cleanup-x-resource-reads";

export const DATA_ROUTES: readonly RouteEntry[] = [
  ...webhooksAgentDataRequestRoutes,
  ...dataRouterHistoryRoutes,
  ...dataRouterToolsRoutes,
  ...cronCleanupXResourceReadsRoutes,
];
