import {
  ONBOARDING_WORKFLOW_CONNECTOR_SLUGS,
  onboardingWorkflowConnectorsContract,
} from "@okouai/api-contracts/contracts/onboarding";
import { command } from "ccstate";

import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import {
  connectorCatalogAuth,
  listConnectorCatalogBriefs$,
} from "./connector-catalog";

const listOnboardingWorkflowConnectorsInner$ = command(
  async ({ set }, signal: AbortSignal) => {
    const briefs = await set(
      listConnectorCatalogBriefs$,
      ONBOARDING_WORKFLOW_CONNECTOR_SLUGS,
      signal,
    );
    if (briefs.status !== 200) {
      return briefs;
    }
    return {
      status: 200 as const,
      body: {
        connectors: briefs.body.map(({ slug, label, icon }) => {
          return { slug, label, icon };
        }),
      },
    };
  },
);

/**
 * No current App reads this: the onboarding workflow pages it served were
 * removed with the make-something flow. It stays for App bundles loaded before
 * that removal (old web/app -> API gate in `docs/fallback.md`), and goes once
 * the client-version floor excludes them.
 */
export const onboardingWorkflowConnectorsRoutes: readonly RouteEntry[] = [
  {
    route: onboardingWorkflowConnectorsContract.list,
    handler: authRoute(
      connectorCatalogAuth,
      listOnboardingWorkflowConnectorsInner$,
    ),
  },
];
