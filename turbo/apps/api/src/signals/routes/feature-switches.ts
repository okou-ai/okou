import { command } from "ccstate";
import {
  featureSwitchesContract,
  type FeatureSwitchesResponse,
} from "@okouai/api-contracts/contracts/feature-switches";
import { getAllFeatureStates } from "@okouai/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  deleteUserFeatureSwitches$,
  updateUserFeatureSwitches$,
  loadUserFeatureSwitchContext$,
} from "../services/feature-switches.service";

const featureSwitchesAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

function featureSwitchResponseBody(params: {
  readonly orgId: string;
  readonly userId: string;
  readonly switches: Record<string, boolean>;
}) {
  const registeredEffectiveSwitches = getAllFeatureStates({
    orgId: params.orgId,
    userId: params.userId,
    overrides: params.switches,
  });
  return {
    switches: params.switches,
    effectiveSwitches: registeredEffectiveSwitches,
  };
}

const featureSwitchesResponse$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<{
    readonly status: 200;
    readonly body: FeatureSwitchesResponse;
  }> => {
    set(setResHeader$, "Cache-Control", "private, no-store");
    const auth = get(organizationAuthContext$);
    const { overrides: switches } = await set(
      loadUserFeatureSwitchContext$,
      auth.orgId,
      auth.userId,
      signal,
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: featureSwitchResponseBody({
        orgId: auth.orgId,
        userId: auth.userId,
        switches,
      }),
    };
  },
);

const updateFeatureSwitchesBody$ = bodyResultOf(featureSwitchesContract.update);

const updateFeatureSwitchesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(updateFeatureSwitchesBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const switches = await set(
      updateUserFeatureSwitches$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        switches: bodyResult.data.switches,
      },
      signal,
    );

    return {
      status: 200 as const,
      body: featureSwitchResponseBody({
        orgId: auth.orgId,
        userId: auth.userId,
        switches,
      }),
    };
  },
);

const deleteFeatureSwitchesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    await set(
      deleteUserFeatureSwitches$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    return { status: 200 as const, body: { deleted: true as const } };
  },
);

export const featureSwitchesRoutes: readonly RouteEntry[] = [
  {
    route: featureSwitchesContract.get,
    handler: authRoute(
      { ...featureSwitchesAuthOptions, acceptAnySandboxCapability: true },
      featureSwitchesResponse$,
    ),
  },
  {
    route: featureSwitchesContract.update,
    handler: authRoute(featureSwitchesAuthOptions, updateFeatureSwitchesInner$),
  },
  {
    route: featureSwitchesContract.delete,
    handler: authRoute(featureSwitchesAuthOptions, deleteFeatureSwitchesInner$),
  },
];
