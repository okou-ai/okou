import { getDataClientConfig as getClientConfig } from "../data-router-client";
import {
  financeContract,
  type FinanceChartRequest,
  type FinanceProfileRequest,
  type FinanceQuoteRequest,
  type FinanceResponse,
  type FinanceSearchRequest,
} from "@okouai/api-contracts/contracts/finance";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { handleError } from "../core/client-factory";

export async function callFinanceSearch(
  body: FinanceSearchRequest,
): Promise<FinanceResponse> {
  const config = await getClientConfig();
  const client = initClient(financeContract, config);
  const result = await client.search({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to search financial instruments");
}

export async function callFinanceProfile(
  body: FinanceProfileRequest,
): Promise<FinanceResponse> {
  const config = await getClientConfig();
  const client = initClient(financeContract, config);
  const result = await client.profile({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to fetch finance profile");
}

export async function callFinanceQuote(
  body: FinanceQuoteRequest,
): Promise<FinanceResponse> {
  const config = await getClientConfig();
  const client = initClient(financeContract, config);
  const result = await client.quote({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to fetch finance quote");
}

export async function callFinanceChart(
  body: FinanceChartRequest,
): Promise<FinanceResponse> {
  const config = await getClientConfig();
  const client = initClient(financeContract, config);
  const result = await client.chart({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to fetch finance chart");
}
