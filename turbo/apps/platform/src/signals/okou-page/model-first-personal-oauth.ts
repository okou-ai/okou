import {
  getMemberRunModelRoute,
  isMemberRunModelAvailable,
} from "@okouai/api-contracts/contracts/member-run-model";
import type {
  AvailableRunModelsResponse,
  ModelProviderResponse,
  ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { command, computed, state } from "ccstate";
import {
  personalModelProviders$,
  reloadPersonalModelProviders$,
} from "../external/personal-model-providers.ts";
import { availableRunModels$ } from "../external/run-models.ts";
import {
  memberRunModelAllowedForPlan,
  modelPlanCapabilities$,
} from "./model-plan-capabilities.ts";

type PersonalOauthProviderType =
  | "claude-code-oauth-token"
  | "codex-oauth-token";

type PersonalModelProviderStatus =
  | {
      status: "connected";
      providerType: PersonalOauthProviderType;
      modelLabel: string;
    }
  | {
      status: "missing";
      providerType: PersonalOauthProviderType;
      modelLabel: string;
    }
  | {
      status: "needs_reconnect";
      providerType: PersonalOauthProviderType;
      modelLabel: string;
      credentialId: string;
    };

type PersonalModelProviderStatusByModel = Readonly<
  Record<string, PersonalModelProviderStatus>
>;

const internalReloadPersonalModelProvider$ = state(0);

export const reloadPersonalModelProvider$ = command(({ set }) => {
  set(reloadPersonalModelProviders$);
  set(internalReloadPersonalModelProvider$, (value) => {
    return value + 1;
  });
});

function isPersonalOauthProviderType(
  type: ModelProviderType,
): type is PersonalOauthProviderType {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

function personalStatusForRunModel(
  runModel: AvailableRunModelsResponse["models"][number],
  personalProviders: readonly ModelProviderResponse[],
): PersonalModelProviderStatus | null {
  const route = getMemberRunModelRoute(runModel);
  if (
    route.availability === "plan_restricted" ||
    !isPersonalOauthProviderType(route.providerType)
  ) {
    return null;
  }

  const provider = personalProviders.find((candidate) => {
    return (
      candidate.type === route.providerType && candidate.isActive !== false
    );
  });
  const providerDetails = {
    providerType: route.providerType,
    modelLabel: runModel.modelLabel,
  };
  if (!provider) {
    return { ...providerDetails, status: "missing" };
  }
  if (provider.needsReconnect || route.availability === "reconnect_required") {
    return {
      ...providerDetails,
      status: "needs_reconnect",
      credentialId: provider.id,
    };
  }
  return { ...providerDetails, status: "connected" };
}

export const personalModelProvider$ = computed(
  async (get): Promise<PersonalModelProviderStatusByModel> => {
    get(internalReloadPersonalModelProvider$);
    const [models, personal] = await Promise.all([
      get(availableRunModels$),
      get(personalModelProviders$),
    ]);

    const statuses: Record<string, PersonalModelProviderStatus> = {};
    for (const runModel of models.models) {
      const status = personalStatusForRunModel(
        runModel,
        personal.modelProviders,
      );
      if (status) {
        statuses[runModel.model] = status;
      }
    }
    return statuses;
  },
);

export const selectedModelAvailable$ = command(
  async (
    { get },
    selectedModel: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const [models, modelCapabilities] = await Promise.all([
      get(availableRunModels$),
      get(modelPlanCapabilities$),
    ]);
    signal.throwIfAborted();
    const runModel = models.models.find((candidate) => {
      return candidate.model === selectedModel;
    });
    if (runModel === undefined || !isMemberRunModelAvailable(runModel)) {
      return false;
    }
    if (!memberRunModelAllowedForPlan(runModel, modelCapabilities)) {
      return false;
    }
    if (runModel.memberEffective) {
      return true;
    }
    if (!isPersonalOauthProviderType(runModel.defaultProviderType)) {
      return true;
    }
    const status = (await get(personalModelProvider$))[selectedModel];
    signal.throwIfAborted();
    return status?.status === "connected";
  },
);
