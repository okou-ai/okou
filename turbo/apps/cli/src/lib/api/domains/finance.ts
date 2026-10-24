import { callDataRouterTool } from "../data-router-client";
import {
  financeResponseSchema,
  type FinanceChartRequest,
  type FinanceProfileRequest,
  type FinanceQuoteRequest,
  type FinanceResponse,
  type FinanceSearchRequest,
} from "@okouai/api-contracts/contracts/finance";

import { handleError } from "../core/client-factory";

export async function callFinanceSearch(
  body: FinanceSearchRequest,
): Promise<FinanceResponse> {
  const result = await callDataRouterTool("finance_search", body);
  if (result.status === 200) {
    return financeResponseSchema.parse(result.body);
  }
  handleError(result, "Failed to search financial instruments");
}

export async function callFinanceProfile(
  body: FinanceProfileRequest,
): Promise<FinanceResponse> {
  const result = await callDataRouterTool("finance_profile", body);
  if (result.status === 200) {
    return financeResponseSchema.parse(result.body);
  }
  handleError(result, "Failed to fetch finance profile");
}

export async function callFinanceQuote(
  body: FinanceQuoteRequest,
): Promise<FinanceResponse> {
  const result = await callDataRouterTool("finance_quote", body);
  if (result.status === 200) {
    return financeResponseSchema.parse(result.body);
  }
  handleError(result, "Failed to fetch finance quote");
}

export async function callFinanceChart(
  body: FinanceChartRequest,
): Promise<FinanceResponse> {
  const result = await callDataRouterTool("finance_chart", body);
  if (result.status === 200) {
    return financeResponseSchema.parse(result.body);
  }
  handleError(result, "Failed to fetch finance chart");
}
