import { randomUUID } from "node:crypto";

import {
  commerceContract,
  type CommerceInspectRequest,
  type CommerceJob,
  type CommerceSearchRequest,
} from "@okouai/api-contracts/contracts/commerce";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import {
  ApiRequestError,
  getClientConfig,
  handleError,
} from "../core/client-factory";

// Bound each HTTP request; the durable job owns provider execution.
const REQUEST_TIMEOUT_MS = 90_000;

function uncertainSubmission(id: string, cause: unknown): ApiRequestError {
  const error = new ApiRequestError(
    `The Commerce submission response was not received. Read the saved job with: okou data commerce job ${id} --wait --json. Do not submit another paid operation.`,
    "COMMERCE_SUBMISSION_UNCERTAIN",
    503,
  );
  error.cause = cause;
  return error;
}

function rejectedSubmission(error: { code: string; message: string }): never {
  throw new ApiRequestError(
    `${error.message}. The submission was not retried.`,
    error.code,
    400,
  );
}

export async function searchCommerce(
  body: CommerceSearchRequest,
): Promise<CommerceJob> {
  const client = initClient(commerceContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const requestId = body.requestId ?? randomUUID();
  let result;
  try {
    result = await client.search({
      headers: {},
      // Keep the opt-in until supported API rollback targets default to jobs.
      body: { ...body, async: true, requestId },
      fetchOptions: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    });
  } catch (error) {
    throw uncertainSubmission(requestId, error);
  }
  if (result.status === 202) return result.body;
  if (result.status === 400) rejectedSubmission(result.body.error);
  handleError(result, "Okou Commerce could not search these products");
}

export async function inspectCommerce(
  body: CommerceInspectRequest,
): Promise<CommerceJob> {
  const client = initClient(commerceContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const requestId = body.requestId ?? randomUUID();
  let result;
  try {
    result = await client.inspect({
      headers: {},
      // New CLI sessions can outlive an API rollback to opt-in async handling.
      body: { ...body, async: true, requestId },
      fetchOptions: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    });
  } catch (error) {
    throw uncertainSubmission(requestId, error);
  }
  if (result.status === 202) return result.body;
  if (result.status === 400) rejectedSubmission(result.body.error);
  handleError(result, "Okou Commerce could not inspect this product");
}

export async function getCommerceJob(
  id: string,
  signal: AbortSignal,
): Promise<CommerceJob> {
  const client = initClient(commerceContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.getJob({
    headers: {},
    params: { id },
    fetchOptions: {
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Okou Commerce could not read this saved job");
}
