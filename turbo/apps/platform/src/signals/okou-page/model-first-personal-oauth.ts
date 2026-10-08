import { isMemberRunModelAvailable } from "@okouai/api-contracts/contracts/member-run-model";
import {
  isPersonalSubscriptionProviderType,
  type AvailableRunModelsResponse,
  type ModelProviderResponse,
  type PersonalSubscriptionProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { command, computed, state } from "ccstate";
import {
  personalModelProviders$,
  reloadPersonalModelProviders$,
} from "../external/personal-model-providers.ts";
import { availableRunModels$ } from "../external/run-models.ts";
import { memberRunModelAllowedForPlan } from "./model-plan-capabilities.ts";

type PersonalModelProviderStatus =
  | {
      status: "connected";
      providerType: PersonalSubscriptionProviderType;
      modelLabel: string;
    }
  | {
      status: "missing";
      providerType: PersonalSubscriptionProviderType;
      modelLabel: string;
    }
  | {
      status: "needs_reconnect";
      providerType: PersonalSubscriptionProviderType;
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

function personalStatusForRunModel(
  runModel: AvailableRunModelsResponse["models"][number],
  personalProviders: readonly ModelProviderResponse[],
): PersonalModelProviderStatus | null {
  const route = runModel.memberEffective;
  if (
    route.availability === "plan_restricted" ||
    !isPersonalSubscriptionProviderType(route.providerType)
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
      if (status && runModel.model !== null) {
        statuses[runModel.model] = status;
      }
    }
    return statuses;
  },
);

export const selectedModelAvailable$ = command(
  async (
    { get },
    selectedModel: string | null,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const models = await get(availableRunModels$);
    signal.throwIfAborted();
    const runModel = models.models.find((candidate) => {
      return candidate.model === selectedModel;
    });
    return (
      runModel !== undefined &&
      isMemberRunModelAvailable(runModel) &&
      memberRunModelAllowedForPlan(runModel)
    );
  },
);
