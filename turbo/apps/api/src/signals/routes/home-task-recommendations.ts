import { homeTaskRecommendationsContract } from "@okouai/api-contracts/contracts/home-task-recommendations";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { queryOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { agentExists } from "../services/agent-data.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { loadCurrentMembershipId } from "../services/morning-brief-membership.service";
import {
  homeTaskRecommendationsUnavailable,
  readHomeTaskRecommendations,
  touchHomeTaskRecommendations,
} from "../services/home-task-recommendations.service";

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
  const body = await readHomeTaskRecommendations(
    set(writeDb$),
    { userId: auth.userId, orgId: auth.orgId, agentId },
    signal,
  );
  return { status: 200 as const, body };
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
  await touchHomeTaskRecommendations(
    set(writeDb$),
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
