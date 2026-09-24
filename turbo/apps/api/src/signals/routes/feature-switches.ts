import { command, computed } from "ccstate";
import {
  featureSwitchesContract,
  type FeatureSwitchesResponse,
} from "@okouai/api-contracts/contracts/feature-switches";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  deleteUserFeatureSwitches$,
  updateUserFeatureSwitches$,
  userFeatureSwitchOverrides,
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

const featureSwitchesResponse$ = computed(
  async (
    get,
  ): Promise<{
    readonly status: 200;
    readonly body: FeatureSwitchesResponse;
  }> => {
    const auth = get(organizationAuthContext$);
    const switches = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
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

const updateFeatureSwitchesBody$ = bodyResultOf(featureSwitchesContract.update);

const updateFeatureSwitchesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(updateFeatureSwitchesBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    // The retired implementation must not be reselected through a stored
    // per-user override while the native-to-Official rollback is draining.
    if (
      bodyResult.data.switches[FeatureSwitchKey.NativeMorningBrief] === true
    ) {
      return {
        status: 400 as const,
        body: {
          error: {
            code: "BAD_REQUEST",
            message: "Native Morning Brief is retiring and cannot be enabled",
          },
        },
      };
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
    handler: authRoute(featureSwitchesAuthOptions, featureSwitchesResponse$),
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
