import type { RouteEntry } from "./route-entry";
import { CORE_ROUTES } from "./route-groups/core";
import { EXECUTION_ROUTES } from "./route-groups/execution";
import { INTEGRATIONS_ROUTES } from "./route-groups/integrations";
import { DATA_ROUTES } from "./route-groups/data";

// Full API composition for Node/Vercel and the complete Worker. Domain Workers
// import their own group directly. Keep Core before Integrations so the exact
// Link callback wins over the generic connector callback.
export const ROUTES: readonly RouteEntry[] = [
  ...CORE_ROUTES,
  ...EXECUTION_ROUTES,
  ...INTEGRATIONS_ROUTES,
  ...DATA_ROUTES,
];
