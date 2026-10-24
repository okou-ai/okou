import { callDataRouterTool } from "../data-router-client";
import {
  scrapeResponseSchema,
  type ScrapeRequest,
  type ScrapeResponse,
} from "@okouai/api-contracts/contracts/scrape";

import { handleError } from "../core/client-factory";

export async function callScrape(body: ScrapeRequest): Promise<ScrapeResponse> {
  const result = await callDataRouterTool("web_scrape", body);
  if (result.status === 200) {
    return scrapeResponseSchema.parse(result.body);
  }
  handleError(result, "Failed to scrape page");
}
