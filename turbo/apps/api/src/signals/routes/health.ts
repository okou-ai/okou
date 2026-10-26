import { computed } from "ccstate";
import {
  healthContract,
  type HealthRouteResponse,
} from "@okouai/api-contracts/contracts/health";

import type { RouteEntry } from "../route-entry";

const apiHealth$ = computed<Promise<HealthRouteResponse>>(async () => {
  await Promise.resolve();
  return { status: 200, body: { status: "ok" } };
});

export const healthRoutes: readonly RouteEntry[] = [
  { route: healthContract.check, handler: apiHealth$ },
];
