import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  modelCatalogContract,
  type ModelCatalogResponse,
} from "@okouai/api-contracts/contracts/model-catalog";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * Read the global run model catalog: the single product authority for model
 * names, order, the system default, retirement/replacement, price tiers and
 * route capabilities such as reasoning efforts.
 */
export async function getModelCatalog(): Promise<ModelCatalogResponse> {
  const config = await getClientConfig();
  const client = initClient(modelCatalogContract, config);

  const result = await client.get({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to read model catalog");
}
