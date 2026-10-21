import type {
  AvailableRunModel,
  ModelProviderResponse,
  ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  mockAutoRunModel,
  mockSubscriptionRunModel,
} from "../../../mocks/handlers/api-run-models.ts";

export function buildProvider(
  overrides: Partial<ModelProviderResponse> & {
    id: string;
    type: ModelProviderResponse["type"];
  },
): ModelProviderResponse {
  return {
    framework: "claude-code",
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

export function buildRunModel(options: {
  readonly model: string | null;
  readonly modelLabel?: string;
  readonly providerType?: ModelProviderType;
  readonly modelProviderId?: string | null;
}): AvailableRunModel {
  return options.model === null
    ? mockAutoRunModel()
    : mockSubscriptionRunModel(options.model, options);
}
