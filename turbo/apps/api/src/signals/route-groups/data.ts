// Keep each domain statically scoped; never import the complete ROUTES registry.
import type { RouteEntry } from "../route-entry";
import { webhooksAgentDataRequestRoutes } from "../routes/webhooks-agent-data-request";
import { dataRouterHistoryRoutes } from "../routes/data-router-history";
import { dataRouterToolsRoutes } from "../routes/data-router-tools";
import { cronCleanupXResourceReadsRoutes } from "../routes/cron-cleanup-x-resource-reads";

export const DATA_ROUTES: readonly RouteEntry[] = [
  ...webhooksAgentDataRequestRoutes,
  ...dataRouterHistoryRoutes,
  ...dataRouterToolsRoutes,
  ...cronCleanupXResourceReadsRoutes,
];
