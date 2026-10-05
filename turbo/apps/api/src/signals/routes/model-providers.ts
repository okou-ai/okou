import { modelProviderCooldownDiagnosticsContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isStaffOrg } from "@okouai/core/staff-org";
import { builtInModelCandidateCooldown } from "@okouai/db/schema/built-in-model-cooldown";
import { command } from "ccstate";
import { and,asc,eq,gt } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$,writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
const cooldownDiagnosticsDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Built-in model cooldown diagnostics are not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const staffRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only staff can cancel built-in model cooldowns",
      code: "FORBIDDEN",
    }),
  }),
});

const getBuiltInModelCooldownDiagnosticsInner$ = command(
  async ({ get }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    const featureStates = getAllFeatureStates({
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    });
    if (!featureStates[FeatureSwitchKey.OkouDebug]) {
      return cooldownDiagnosticsDisabled;
    }

    const db = get(db$);
    const timestamp = nowDate();
    const activeCooldowns = await db
      .select({
        selectedModel: builtInModelCandidateCooldown.selectedModel,
        providerType: builtInModelCandidateCooldown.modelRuntimeProvider,
        upstreamModel: builtInModelCandidateCooldown.modelRuntimeModel,
        unavailableUntil: builtInModelCandidateCooldown.unavailableUntil,
      })
      .from(builtInModelCandidateCooldown)
      .where(gt(builtInModelCandidateCooldown.unavailableUntil, timestamp))
      .orderBy(
        asc(builtInModelCandidateCooldown.selectedModel),
        asc(builtInModelCandidateCooldown.modelRuntimeProvider),
        asc(builtInModelCandidateCooldown.modelRuntimeModel),
      );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        canCancelCooldowns: isStaffOrg(auth.orgId),
        activeCooldowns: activeCooldowns.map((cooldown) => {
          return {
            ...cooldown,
            unavailableUntil: cooldown.unavailableUntil.toISOString(),
          };
        }),
      },
    };
  },
);

const cancelBuiltInModelCooldownInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (!isStaffOrg(auth.orgId)) {
      return staffRequired;
    }

    const bodyResult = await get(
      bodyResultOf(modelProviderCooldownDiagnosticsContract.cancel),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    await db
      .delete(builtInModelCandidateCooldown)
      .where(
        and(
          eq(
            builtInModelCandidateCooldown.selectedModel,
            bodyResult.data.selectedModel,
          ),
          eq(
            builtInModelCandidateCooldown.modelRuntimeProvider,
            bodyResult.data.providerType,
          ),
          eq(
            builtInModelCandidateCooldown.modelRuntimeModel,
            bodyResult.data.upstreamModel,
          ),
        ),
      );
    signal.throwIfAborted();

    return { status: 204 as const, body: undefined };
  },
);

export const modelProvidersRoutes: readonly RouteEntry[] = [
  {
    route: modelProviderCooldownDiagnosticsContract.get,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        accept: ["session"],
      },
      getBuiltInModelCooldownDiagnosticsInner$,
    ),
  },
  {
    route: modelProviderCooldownDiagnosticsContract.cancel,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        accept: ["session"],
      },
      cancelBuiltInModelCooldownInner$,
    ),
  },
];
