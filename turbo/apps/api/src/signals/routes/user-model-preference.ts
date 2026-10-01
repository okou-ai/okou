import { command, computed } from "ccstate";
import {
  getMemberModelPolicyRoute,
  isMemberModelPolicyConfigurable,
} from "@okouai/api-contracts/contracts/member-model-policy";
import type { OrgModelPolicy } from "@okouai/api-contracts/contracts/model-providers";
import type { ModelSettingsPatch } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { UserPreferenceChangedPayload } from "@okouai/api-contracts/contracts/realtime";
import {
  type UpdateUserModelPreferenceRequest,
  userModelPreferenceContract,
} from "@okouai/api-contracts/contracts/user-model-preference";

import { badRequestMessage } from "../../lib/error";
import { publishUserPreferenceChangedForUserSafely } from "../external/realtime";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { listOrgModelPolicies$ } from "../services/model-policy.service";
import {
  memberModelPolicyCatalog,
  type ModelCatalog,
  resolveCatalogRunModel,
  modelCatalog$,
} from "../services/model-catalog.service";

import {
  isCatalogFastServiceTierSupported,
  isCatalogRouteEffortSupported,
  isCatalogUltrafastServiceTierSupported,
} from "../services/model-route-capabilities.service";
import {
  updateUserModelPreference$,
  userModelPreference,
} from "../services/user-data.service";

const updateBody$ = bodyResultOf(userModelPreferenceContract.update);

function configuredPolicyProviderType(
  catalog: ModelCatalog,
  policy: OrgModelPolicy | undefined,
): string | null {
  return policy &&
    isMemberModelPolicyConfigurable(policy, memberModelPolicyCatalog(catalog))
    ? getMemberModelPolicyRoute(policy).providerType
    : null;
}

function validateModelSettingsPatch(args: {
  readonly catalog: ModelCatalog;
  readonly patch: ModelSettingsPatch | undefined;
  readonly selectedModel: string | null;
  readonly configuredPolicy: OrgModelPolicy | undefined;
}): ReturnType<typeof badRequestMessage> | undefined {
  if (args.patch === undefined) {
    return undefined;
  }
  if (args.patch.model !== args.selectedModel) {
    return badRequestMessage("Reasoning effort must target the selected model");
  }
  if (
    !isCatalogRouteEffortSupported(
      args.catalog,
      args.patch.model,
      args.patch.effort,
      configuredPolicyProviderType(args.catalog, args.configuredPolicy),
    )
  ) {
    return badRequestMessage(
      "Reasoning effort is not supported by the selected model",
    );
  }
  return undefined;
}

function validateUltrafastServiceTier(args: {
  readonly catalog: ModelCatalog;
  readonly requested: boolean;
  readonly configuredPolicy: OrgModelPolicy | undefined;
}): ReturnType<typeof badRequestMessage> | undefined {
  if (!args.requested) {
    return undefined;
  }
  if (
    !args.configuredPolicy ||
    !isCatalogUltrafastServiceTierSupported(
      args.catalog,
      args.configuredPolicy.model,
      configuredPolicyProviderType(args.catalog, args.configuredPolicy),
    )
  ) {
    return badRequestMessage("Ultrafast is unavailable for this model route");
  }
  return undefined;
}

function validatePriorityServiceTier(args: {
  readonly catalog: ModelCatalog;
  readonly requested: boolean;
  readonly configuredPolicy: OrgModelPolicy | undefined;
}): ReturnType<typeof badRequestMessage> | undefined {
  if (!args.requested) {
    return undefined;
  }
  if (
    !args.configuredPolicy ||
    !isMemberModelPolicyConfigurable(
      args.configuredPolicy,
      memberModelPolicyCatalog(args.catalog),
    )
  ) {
    return badRequestMessage("Invalid request");
  }
  if (
    (args.configuredPolicy.subscriptionOptions &&
      args.configuredPolicy.subscriptionOptions.serviceTier !== "priority") ||
    !isCatalogFastServiceTierSupported(
      args.catalog,
      args.configuredPolicy.model,
      configuredPolicyProviderType(args.catalog, args.configuredPolicy),
    )
  ) {
    return badRequestMessage(
      "Codex fast mode is only available for GPT 5.6 runs",
    );
  }
  return undefined;
}

const getUserModelPreferenceInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const body = await get(
    userModelPreference({ orgId: auth.orgId, userId: auth.userId }),
  );
  return { status: 200 as const, body };
});

const persistUserModelPreference$ = command(
  async (
    { get, set },
    preference: UpdateUserModelPreferenceRequest,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const result = await set(
      updateUserModelPreference$,
      { orgId: auth.orgId, userId: auth.userId, preference },
      signal,
    );
    signal.throwIfAborted();
    const kinds: UserPreferenceChangedPayload["kinds"] = [
      "defaultModel",
      ...("selectedImageModel" in preference
        ? (["defaultImageModel"] as const)
        : []),
    ];
    await publishUserPreferenceChangedForUserSafely(auth.userId, kinds);
    signal.throwIfAborted();
    return { status: 200 as const, body: result };
  },
);

/**
 * A legacy client may send a replaced model ID: store the final model of its
 * replacement chain. Unknown IDs are rejected explicitly.
 */
function resolveRequestedPreferenceModels(
  catalog: ModelCatalog,
  request: UpdateUserModelPreferenceRequest,
): UpdateUserModelPreferenceRequest | ReturnType<typeof badRequestMessage> {
  const selectedModel =
    request.selectedModel === null
      ? null
      : resolveCatalogRunModel(catalog, request.selectedModel);
  if (request.selectedModel !== null && selectedModel === null) {
    return badRequestMessage(`Unknown model "${request.selectedModel}"`);
  }
  const patch = request.modelSettingsPatch;
  if (!patch) {
    return { ...request, selectedModel };
  }
  const patchModel = resolveCatalogRunModel(catalog, patch.model);
  if (patchModel === null) {
    return badRequestMessage(`Unknown model "${patch.model}"`);
  }
  return {
    ...request,
    selectedModel,
    modelSettingsPatch: { ...patch, model: patchModel },
  };
}

const updateUserModelPreferenceInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const body = await get(updateBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    // Every write carries the run preference, including one that only changes
    // a media model. Echoing the stored run preference unchanged is not a new
    // selection, so it skips admission; otherwise a model the org policy has
    // since dropped would block the member from changing their image model.
    const stored = await get(
      userModelPreference({ orgId: auth.orgId, userId: auth.userId }),
    );
    signal.throwIfAborted();
    const runPreferenceUnchanged =
      body.data.selectedModel === stored.selectedModel &&
      body.data.serviceTier === stored.serviceTier &&
      body.data.modelSettingsPatch === undefined;
    if (runPreferenceUnchanged) {
      return await set(persistUserModelPreference$, body.data, signal);
    }

    const catalog = await get(modelCatalog$);
    signal.throwIfAborted();
    const data = resolveRequestedPreferenceModels(catalog, body.data);
    if ("status" in data) {
      return data;
    }

    const policies =
      data.selectedModel !== null
        ? await set(
            listOrgModelPolicies$,
            { orgId: auth.orgId, userId: auth.userId },
            signal,
          )
        : undefined;
    const configuredPolicy = policies?.policies.find((policy) => {
      return policy.model === data.selectedModel;
    });
    if (data.selectedModel !== null && !configuredPolicy) {
      return badRequestMessage("Invalid request");
    }

    const modelSettingsPatch = data.modelSettingsPatch;
    signal.throwIfAborted();
    if (
      modelSettingsPatch &&
      configuredPolicy?.subscriptionOptions &&
      !configuredPolicy.subscriptionOptions.efforts.includes(
        modelSettingsPatch.effort,
      )
    ) {
      return badRequestMessage(
        "Reasoning effort is not available for this subscription",
      );
    }

    const modelSettingsError = validateModelSettingsPatch({
      catalog,
      patch: modelSettingsPatch,
      selectedModel: data.selectedModel,
      configuredPolicy,
    });
    if (modelSettingsError) {
      return modelSettingsError;
    }

    const serviceTierError =
      validateUltrafastServiceTier({
        catalog,
        requested: data.serviceTier === "ultrafast",
        configuredPolicy,
      }) ??
      validatePriorityServiceTier({
        catalog,
        requested: data.serviceTier === "priority",
        configuredPolicy,
      });
    if (serviceTierError) {
      return serviceTierError;
    }

    return await set(persistUserModelPreference$, data, signal);
  },
);

export const userModelPreferenceRoutes: readonly RouteEntry[] = [
  {
    route: userModelPreferenceContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getUserModelPreferenceInner$,
    ),
  },
  {
    route: userModelPreferenceContract.update,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateUserModelPreferenceInner$,
    ),
  },
];
