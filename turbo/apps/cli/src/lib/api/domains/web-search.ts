import { getDataClientConfig as getClientConfig } from "../data-router-client";
import {
  webSearchContract,
  type WebSearchRequest,
  type WebSearchResponse,
} from "@okouai/api-contracts/contracts/web-search";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { handleError } from "../core/client-factory";

export async function callWebSearch(
  body: WebSearchRequest,
): Promise<WebSearchResponse> {
  const config = await getClientConfig();
  const client = initClient(webSearchContract, config);

  const result = await client.search({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to search the web");
}
