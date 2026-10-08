import type {
  AvailableRunModel,
  AvailableRunModelsResponse,
  ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { reasoningEffortSchema } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { mockApi } from "../msw-contract.ts";
import { getMockModelCatalog } from "./api-model-catalog.ts";
import { getMockPersonalModelProviders } from "./api-personal-model-providers.ts";

let mockAvailableRunModels: AvailableRunModel[] | undefined;

export function resetMockAvailableRunModels(): void {
  mockAvailableRunModels = undefined;
}

export function setMockAvailableRunModels(models: AvailableRunModel[]): void {
  mockAvailableRunModels = models;
}

type MockRunModelAvailability =
  AvailableRunModel["memberEffective"]["availability"];

/** Auto, exactly as the API lists it. */
export function mockAutoRunModel(): AvailableRunModel {
  return {
    model: null,
    modelLabel: "Auto",
    modelProviderId: null,
    memberEffective: {
      providerType: "built-in",
      runtimeProviderType: "openrouter-codex",
      credentialScope: "org",
      availability: "available",
      accountSelection: "not_applicable",
    },
  };
}

/**
 * A personal subscription row as the API projects it, with options taken from
 * the mock catalog's subscription route.
 */
export function mockSubscriptionRunModel(
  model: string,
  options: {
    readonly modelLabel?: string;
    readonly providerType?: ModelProviderType;
    readonly modelProviderId?: string | null;
    readonly availability?: MockRunModelAvailability;
  } = {},
): AvailableRunModel {
  const catalog = getMockModelCatalog();
  const providerType =
    options.providerType ??
    (model.startsWith("claude-")
      ? "claude-code-oauth-token"
      : "codex-oauth-token");
  const route = catalog.routes.find((candidate) => {
    return candidate.model === model && candidate.providerType === providerType;
  });
  return {
    model,
    modelLabel:
      options.modelLabel ??
      catalog.models.find((entry) => {
        return entry.model === model;
      })?.displayName ??
      model,
    modelProviderId: options.modelProviderId ?? null,
    subscriptionOptions: {
      efforts: (route?.efforts ?? []).flatMap((effort) => {
        const parsed = reasoningEffortSchema.safeParse(effort);
        return parsed.success ? [parsed.data] : [];
      }),
      serviceTier: route?.serviceTiers.includes("priority") ? "priority" : null,
    },
    memberEffective: {
      providerType,
      runtimeProviderType: providerType,
      credentialScope: "member",
      availability: options.availability ?? "available",
      accountSelection: "capture_required",
    },
  };
}

function response(): AvailableRunModelsResponse {
  const catalog = getMockModelCatalog();
  const personal = getMockPersonalModelProviders();
  const models: AvailableRunModel[] = catalog.models.flatMap((entry) => {
    if (entry.replacedBy !== null) {
      return [];
    }
    const account = personal.find((provider) => {
      return (
        provider.isActive !== false &&
        catalog.routes.some((route) => {
          return (
            route.model === entry.model && route.providerType === provider.type
          );
        })
      );
    });
    if (!account) {
      return [];
    }
    return [
      mockSubscriptionRunModel(entry.model, {
        modelLabel: entry.displayName,
        providerType: account.type,
        modelProviderId: account.id,
        availability: account.needsReconnect
          ? "reconnect_required"
          : "available",
      }),
    ];
  });
  return {
    models: [
      mockAutoRunModel(),
      ...(mockAvailableRunModels ?? models).filter(
        (entry) => entry.model !== null,
      ),
    ],
  };
}

export const apiAvailableRunModelsHandlers = [
  mockApi(runModelsMainContract.list, ({ respond }) =>
    respond(200, response()),
  ),
];
