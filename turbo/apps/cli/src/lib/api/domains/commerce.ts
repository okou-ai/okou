import { callDataRouterTool } from "../data-router-client";
import { randomUUID } from "node:crypto";

import {
  commerceJobSchema,
  type CommerceInspectRequest,
  type CommerceJob,
  type CommerceSearchRequest,
} from "@okouai/api-contracts/contracts/commerce";
import { apiErrorSchema } from "@okouai/api-contracts/contracts/errors";

import { ApiRequestError, handleError } from "../core/client-factory";

// Bound each HTTP request; the durable job owns provider execution.
const REQUEST_TIMEOUT_MS = 90_000;

function uncertainSubmission(id: string, cause: unknown): ApiRequestError {
  const error = new ApiRequestError(
    `The Commerce submission response was not received (client request ID ${id}); its saved job ID is unknown. Do not submit another paid operation. If a job ID was received separately, inspect it with okou data commerce job <job-id> --wait --json.`,
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
  const requestId = body.requestId ?? randomUUID();
  let result;
  try {
    result = await callDataRouterTool(
      "commerce_search",
      { ...body, requestId },
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );
  } catch (error) {
    throw uncertainSubmission(requestId, error);
  }
  if (result.status === 202) return commerceJobSchema.parse(result.body);
  if (result.status === 400)
    rejectedSubmission(apiErrorSchema.parse(result.body).error);
  handleError(result, "Okou Commerce could not search these products");
}

export async function inspectCommerce(
  body: CommerceInspectRequest,
): Promise<CommerceJob> {
  const requestId = body.requestId ?? randomUUID();
  let result;
  try {
    result = await callDataRouterTool(
      "commerce_inspect",
      { ...body, requestId },
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );
  } catch (error) {
    throw uncertainSubmission(requestId, error);
  }
  if (result.status === 202) return commerceJobSchema.parse(result.body);
  if (result.status === 400)
    rejectedSubmission(apiErrorSchema.parse(result.body).error);
  handleError(result, "Okou Commerce could not inspect this product");
}

export async function getCommerceJob(
  id: string,
  signal: AbortSignal,
): Promise<CommerceJob> {
  const result = await callDataRouterTool(
    "commerce_get",
    { id },
    AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  );
  if (result.status === 200) return commerceJobSchema.parse(result.body);
  handleError(result, "Okou Commerce could not read this saved job");
}
