import {
  ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS,
  onboardingSourcesContract,
} from "@okouai/api-contracts/contracts/onboarding";
import { command } from "ccstate";

import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import {
  connectorCatalogAuth,
  listConnectorCatalogConnectItems$,
} from "./connector-catalog";

const listOnboardingSourcesInner$ = command(
  async ({ set }, signal: AbortSignal) => {
    return await set(
      listConnectorCatalogConnectItems$,
      {
        kind: "slugs",
        connectorSlugs: ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS,
      },
      signal,
    );
  },
);

export const onboardingSourcesRoutes: readonly RouteEntry[] = [
  {
    route: onboardingSourcesContract.list,
    handler: authRoute(connectorCatalogAuth, listOnboardingSourcesInner$),
  },
];
