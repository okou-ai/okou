import { getDataClientConfig as getClientConfig } from "../data-router-client";
import {
  seoContract,
  type SeoBacklinksSummaryRequest,
  type SeoKeywordIdeasRequest,
  type SeoRankedKeywordsRequest,
  type SeoResponse,
  type SeoSerpRequest,
} from "@okouai/api-contracts/contracts/seo";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { handleError } from "../core/client-factory";

export async function callSeoSerp(body: SeoSerpRequest): Promise<SeoResponse> {
  const config = await getClientConfig();
  const client = initClient(seoContract, config);
  const result = await client.serp({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to fetch SEO search results");
}

export async function callSeoKeywordIdeas(
  body: SeoKeywordIdeasRequest,
): Promise<SeoResponse> {
  const config = await getClientConfig();
  const client = initClient(seoContract, config);
  const result = await client.keywordIdeas({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to fetch SEO keyword ideas");
}

export async function callSeoRankedKeywords(
  body: SeoRankedKeywordsRequest,
): Promise<SeoResponse> {
  const config = await getClientConfig();
  const client = initClient(seoContract, config);
  const result = await client.rankedKeywords({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to fetch ranked keywords");
}

export async function callSeoBacklinksSummary(
  body: SeoBacklinksSummaryRequest,
): Promise<SeoResponse> {
  const config = await getClientConfig();
  const client = initClient(seoContract, config);
  const result = await client.backlinksSummary({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to fetch the backlinks summary");
}
