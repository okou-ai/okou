import {
  commerceContract,
  type CommerceInspectRequest,
  type CommerceSearchRequest,
  type CommerceResponse,
} from "@okouai/api-contracts/contracts/commerce";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

// Merchant Live permits a full minute upstream; leave room for API admission and settlement.
const REQUEST_TIMEOUT_MS = 90_000;

export async function searchCommerce(
  body: CommerceSearchRequest,
): Promise<CommerceResponse> {
  const client = initClient(commerceContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.search({
    headers: {},
    body,
    fetchOptions: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Okou Commerce could not search these products");
}

export async function inspectCommerce(
  body: CommerceInspectRequest,
): Promise<CommerceResponse> {
  const client = initClient(commerceContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.inspect({
    headers: {},
    body,
    fetchOptions: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Okou Commerce could not inspect this product");
}
