import { homeTaskRecommendationsContract } from "@okouai/api-contracts/contracts/home-task-recommendations";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { agentExists } from "../services/agent-data.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  homeTaskRecommendationsUnavailable,
  readHomeTaskRecommendations,
} from "../services/home-task-recommendations.service";

const list$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const { agentId } = get(queryOf(homeTaskRecommendationsContract.list));
  // The cards are per member and Agent and change on their own cadence, so a cached copy
  // in front of this route would serve one member's suggestions to the next
  // request and hide the refresh the client is polling for.
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
  const body = await readHomeTaskRecommendations(
    set(writeDb$),
    { userId: auth.userId, orgId: auth.orgId, agentId },
    signal,
  );
  return { status: 200 as const, body };
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
];
