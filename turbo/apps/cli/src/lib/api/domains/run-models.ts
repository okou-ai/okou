import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { AvailableRunModelsResponse } from "@okouai/api-contracts/contracts/model-providers";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * List Auto and the current user's connected subscription models.
 */
export async function listRunModels(): Promise<AvailableRunModelsResponse> {
  const config = await getClientConfig();
  const client = initClient(runModelsMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list available models");
}

export async function getUserModelPreference() {
  const client = initClient(
    userModelPreferenceContract,
    await getClientConfig(),
  );
  const result = await client.get({ headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to load default model");
}

/**
 * The API requires `serviceTier` on every write and treats null as "clear",
 * so callers pass the tier to store explicitly. A null model selects Auto.
 */
export async function selectRunModel(
  model: string | null,
  serviceTier: ChatThreadServiceTier | null,
) {
  const client = initClient(
    userModelPreferenceContract,
    await getClientConfig(),
  );
  const result = await client.update({
    headers: {},
    body: { selectedModel: model, serviceTier },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to select default model");
}
