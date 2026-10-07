import type {
  AvailableRunModel,
  AvailableRunModelsResponse,
} from "@okouai/api-contracts/contracts/model-providers";
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

function response(): AvailableRunModelsResponse {
  const catalog = getMockModelCatalog();
  const defaultModel = catalog.systemDefaultModel;
  const auto: AvailableRunModel = {
    model: defaultModel,
    modelLabel: "Auto",
    defaultProviderType: "built-in",
    runtimeProviderType: "openrouter-codex",
    credentialScope: "org",
    modelProviderId: null,
    routeStatus: "valid",
    routeStatusReason: null,
  };
  const personal = getMockPersonalModelProviders();
  const models: AvailableRunModel[] = catalog.models.flatMap((entry) => {
    if (entry.replacedBy !== null || entry.model === defaultModel) {
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
      {
        model: entry.model,
        modelLabel: entry.displayName,
        defaultProviderType: account.type,
        runtimeProviderType: account.type,
        credentialScope: "member",
        modelProviderId: account.id,
        routeStatus: "valid",
        routeStatusReason: null,
        memberEffective: {
          providerType: account.type,
          runtimeProviderType: account.type,
          credentialScope: "member",
          availability: account.needsReconnect
            ? "reconnect_required"
            : "available",
          accountSelection: "capture_required",
        },
      },
    ];
  });
  return {
    defaultModel,
    models: [
      auto,
      ...(mockAvailableRunModels ?? models).filter(
        (entry) => entry.model !== defaultModel,
      ),
    ],
  };
}

export const apiAvailableRunModelsHandlers = [
  mockApi(runModelsMainContract.list, ({ respond }) =>
    respond(200, response()),
  ),
];
