import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import {
  homeTaskRecommendationsContract,
  type HomeTaskRecommendation,
  type HomeTaskRecommendationConnector,
} from "@okouai/api-contracts/contracts/home-task-recommendations";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  getAllFeatureStates,
  isFeatureEnabled,
} from "@okouai/core/feature-switch";
import { command } from "ccstate";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { queryOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { agentExists } from "../services/agent-data.service";
import {
  isConnectorCatalogUnavailableError,
  connectorBriefsFromRows,
} from "../services/connector-catalog-reader.service";
import { connectorCatalogDisplayColumns } from "../services/connector-catalog-columns";
import {
  connectorCatalogCurrentWhere,
  connectorCatalogSlugJoin,
} from "../services/connector-catalog-slug-source.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { loadCurrentMembershipId } from "../services/morning-brief-membership.service";
import {
  homeTaskRecommendationsUnavailable,
  readHomeTaskRecommendations$,
  touchHomeTaskRecommendations$,
} from "../services/home-task-recommendations.service";
import { settle } from "../utils";

/**
 * Preserve card order while deduplicating syntactically valid connector names.
 */
function recommendationConnectorSlugs(
  recommendations: readonly HomeTaskRecommendation[],
) {
  return [
    ...new Set(
      recommendations.flatMap((recommendation) => {
        return recommendation.connectors;
      }),
    ),
  ].filter((slug) => {
    return connectorSlugSchema.safeParse(slug).success;
  });
}

const list$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const { agentId } = get(queryOf(homeTaskRecommendationsContract.list));
  // The cards are per member and Agent. Shared HTTP caching would cross those
  // ownership boundaries and could also hide a cron result delivered via Ably.
  set(setResHeader$, "Cache-Control", "no-store");
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isFeatureEnabled(FeatureSwitchKey.HomeTaskRecommendations, {
      userId: auth.userId,
      orgId: auth.orgId,
      overrides,
    })
  ) {
    // Not an error: a member without the feature has no cards, which is the
    // same shape as a member whose evidence supported none.
    return {
      status: 200 as const,
      body: homeTaskRecommendationsUnavailable(),
    };
  }
  const membershipId = await loadCurrentMembershipId(
    get(clerk$),
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  if (membershipId === null) {
    return {
      status: 200 as const,
      body: homeTaskRecommendationsUnavailable(),
    };
  }
  if (
    !(await get(
      agentExists({
        orgId: auth.orgId,
        userId: auth.userId,
        agentId,
      }),
    ))
  ) {
    return {
      status: 200 as const,
      body: homeTaskRecommendationsUnavailable(),
    };
  }
  signal.throwIfAborted();
  const body = await set(
    readHomeTaskRecommendations$,
    { userId: auth.userId, orgId: auth.orgId, agentId },
    signal,
  );
  signal.throwIfAborted();
  const connectorSlugs = recommendationConnectorSlugs(body.recommendations);
  if (connectorSlugs.length === 0) {
    return { status: 200 as const, body: { ...body, connectors: [] } };
  }
  const featureStates = getAllFeatureStates({
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
  const briefs = await settle(
    (async () => {
      const rows = await get(db$)
        .select({
          current: {
            schemaVersion: connectorCatalog.schemaVersion,
            hash: connectorCatalog.hash,
          },
          entry: connectorCatalogDisplayColumns,
        })
        .from(connectorCatalog)
        .leftJoin(
          connectorCatalogEntries,
          connectorCatalogSlugJoin(connectorSlugs),
        )
        .where(connectorCatalogCurrentWhere());
      return connectorBriefsFromRows({
        rows,
        featureStates,
        connectorSlugs,
      });
    })(),
    signal,
  );
  if (!briefs.ok) {
    if (isConnectorCatalogUnavailableError(briefs.error)) {
      // The cards remain useful when their optional connector chips are unavailable.
      return { status: 200 as const, body };
    }
    throw briefs.error;
  }
  const connectors: HomeTaskRecommendationConnector[] = briefs.value.map(
    ({ slug, label, icon }) => {
      return { slug, label, icon };
    },
  );
  return {
    status: 200 as const,
    body: { ...body, connectors },
  };
});

const touch$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const { agentId } = get(queryOf(homeTaskRecommendationsContract.touch));
  set(setResHeader$, "Cache-Control", "no-store");
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isFeatureEnabled(FeatureSwitchKey.HomeTaskRecommendations, {
      userId: auth.userId,
      orgId: auth.orgId,
      overrides,
    })
  ) {
    return { status: 204 as const, body: undefined };
  }
  const membershipId = await loadCurrentMembershipId(
    get(clerk$),
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  if (membershipId === null) {
    return { status: 204 as const, body: undefined };
  }
  if (
    !(await get(
      agentExists({
        orgId: auth.orgId,
        userId: auth.userId,
        agentId,
      }),
    ))
  ) {
    return { status: 204 as const, body: undefined };
  }
  signal.throwIfAborted();
  await set(
    touchHomeTaskRecommendations$,
    { userId: auth.userId, orgId: auth.orgId, agentId },
    signal,
  );
  return { status: 204 as const, body: undefined };
});

export const homeTaskRecommendationRoutes: readonly RouteEntry[] = [
  {
    route: homeTaskRecommendationsContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      list$,
    ),
  },
  {
    route: homeTaskRecommendationsContract.touch,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      touch$,
    ),
  },
];
