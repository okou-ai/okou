import { callDataRouterTool } from "../data-router-client";
import {
  seoResponseSchema,
  type SeoBacklinksSummaryRequest,
  type SeoKeywordIdeasRequest,
  type SeoRankedKeywordsRequest,
  type SeoResponse,
  type SeoSerpRequest,
} from "@okouai/api-contracts/contracts/seo";

import { handleError } from "../core/client-factory";

export async function callSeoSerp(body: SeoSerpRequest): Promise<SeoResponse> {
  const result = await callDataRouterTool("seo_serp", body);
  if (result.status === 200) {
    return seoResponseSchema.parse(result.body);
  }
  handleError(result, "Failed to fetch SEO search results");
}

export async function callSeoKeywordIdeas(
  body: SeoKeywordIdeasRequest,
): Promise<SeoResponse> {
  const result = await callDataRouterTool("seo_keyword_ideas", body);
  if (result.status === 200) {
    return seoResponseSchema.parse(result.body);
  }
  handleError(result, "Failed to fetch SEO keyword ideas");
}

export async function callSeoRankedKeywords(
  body: SeoRankedKeywordsRequest,
): Promise<SeoResponse> {
  const result = await callDataRouterTool("seo_ranked_keywords", body);
  if (result.status === 200) {
    return seoResponseSchema.parse(result.body);
  }
  handleError(result, "Failed to fetch ranked keywords");
}

export async function callSeoBacklinksSummary(
  body: SeoBacklinksSummaryRequest,
): Promise<SeoResponse> {
  const result = await callDataRouterTool("seo_backlinks_summary", body);
  if (result.status === 200) {
    return seoResponseSchema.parse(result.body);
  }
  handleError(result, "Failed to fetch the backlinks summary");
}
