import { callDataRouterTool } from "../data-router-client";
import {
  webSearchResponseSchema,
  type WebSearchRequest,
  type WebSearchResponse,
} from "@okouai/api-contracts/contracts/web-search";

import { handleError } from "../core/client-factory";

export async function callWebSearch(
  body: WebSearchRequest,
): Promise<WebSearchResponse> {
  const result = await callDataRouterTool("web_search", body);
  if (result.status === 200) {
    return webSearchResponseSchema.parse(result.body);
  }
  handleError(result, "Failed to search the web");
}
