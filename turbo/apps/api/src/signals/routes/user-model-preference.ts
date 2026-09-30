import { command, computed } from "ccstate";
import { isMemberModelPolicyConfigurable } from "@okouai/api-contracts/contracts/member-model-policy";
import {
  getRunModelAccess,
  RETIRED_RUN_MODEL_MESSAGE,
  type OrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  isModelReasoningEffortSupported,
  type ModelSettingsPatch,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
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
import { isCodexFastServiceTierSupported } from "../services/model-selection.service";
import {
  updateUserModelPreference$,
  userModelPreference,
} from "../services/user-data.service";

const updateBody$ = bodyResultOf(userModelPreferenceContract.update);

function validateModelSettingsPatch(args: {
  readonly patch: ModelSettingsPatch | undefined;
  readonly selectedModel: string | null;
}): ReturnType<typeof badRequestMessage> | undefined {
  if (args.patch === undefined) {
    return undefined;
  }
  if (args.patch.model !== args.selectedModel) {
    return badRequestMessage("Reasoning effort must target the selected model");
  }
  if (!isModelReasoningEffortSupported(args.patch.model, args.patch.effort)) {
    return badRequestMessage(
      "Reasoning effort is not supported by the selected model",
    );
  }
  return undefined;
}

function validateUltrafastServiceTier(args: {
  readonly requested: boolean;
}): ReturnType<typeof badRequestMessage> | undefined {
  return args.requested
    ? badRequestMessage("Astra Ultrafast is temporarily disabled")
    : undefined;
}

function validatePriorityServiceTier(args: {
  readonly requested: boolean;
  readonly configuredPolicy: OrgModelPolicy | undefined;
}): ReturnType<typeof badRequestMessage> | undefined {
  if (!args.requested) {
    return undefined;
  }
  if (
    !args.configuredPolicy ||
    !isMemberModelPolicyConfigurable(args.configuredPolicy)
  ) {
    return badRequestMessage("Invalid request");
  }
  if (
    (args.configuredPolicy.subscriptionOptions &&
      args.configuredPolicy.subscriptionOptions.serviceTier !== "priority") ||
    !isCodexFastServiceTierSupported({
      selectedModel: args.configuredPolicy.model,
    })
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

    if (getRunModelAccess(body.data.selectedModel) === "retired") {
      return badRequestMessage(RETIRED_RUN_MODEL_MESSAGE);
    }

    const policies =
      body.data.selectedModel !== null
        ? await set(
            listOrgModelPolicies$,
            { orgId: auth.orgId, userId: auth.userId },
            signal,
          )
        : undefined;
    const configuredPolicy = policies?.policies.find((policy) => {
      return policy.model === body.data.selectedModel;
    });
    if (body.data.selectedModel !== null && !configuredPolicy) {
      return badRequestMessage("Invalid request");
    }

    const modelSettingsPatch = body.data.modelSettingsPatch;
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
      patch: modelSettingsPatch,
      selectedModel: body.data.selectedModel,
    });
    if (modelSettingsError) {
      return modelSettingsError;
    }

    const serviceTierError =
      validateUltrafastServiceTier({
        requested: body.data.serviceTier === "ultrafast",
      }) ??
      validatePriorityServiceTier({
        requested: body.data.serviceTier === "priority",
        configuredPolicy,
      });
    if (serviceTierError) {
      return serviceTierError;
    }

    return await set(persistUserModelPreference$, body.data, signal);
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
