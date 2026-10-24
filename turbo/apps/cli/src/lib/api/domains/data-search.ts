import { callDataRouterTool } from "../data-router-client";
import {
  dataSearchCapabilitiesResponseSchema,
  dataSearchQuoteResponseSchema,
  dataSearchJobResponseSchema,
  dataSearchListResponseSchema,
  type DataSearchRequest,
  type DataSearchCreateRequest,
  type DataSearchListQuery,
} from "@okouai/api-contracts/contracts/data-search";

import { ApiRequestError, handleError } from "../core/client-factory";

const REQUEST_TIMEOUT_MS = 60_000;

export class DataSearchRecoveryError extends ApiRequestError {
  constructor(
    readonly requestId: string,
    cause: unknown,
  ) {
    super(
      `Submission response unknown (client request ID ${requestId}). Inspect okou data jobs list --json. Do not resubmit: a repeated command can start another paid job.`,
      "DATA_JOB_RESPONSE_UNKNOWN",
      503,
    );
    this.cause = cause;
  }
}

export async function listDataSearchCapabilities(query?: string) {
  const result = await callDataRouterTool(
    "data_capabilities",
    { query },
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  );
  if (result.status === 200)
    return dataSearchCapabilitiesResponseSchema.parse(result.body);
  handleError(result, "Could not discover Data Search capabilities");
}

export async function quoteDataSearch(body: DataSearchRequest) {
  const result = await callDataRouterTool(
    "data_quote",
    body,
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  );
  if (result.status === 200)
    return dataSearchQuoteResponseSchema.parse(result.body);
  handleError(result, "Could not quote Data Search");
}

export async function createDataSearchJob(body: DataSearchCreateRequest) {
  const { requestId: _requestId, maxCredits, ...request } = body;
  const quote = await quoteDataSearch(request);
  if (quote.maxCredits > maxCredits) {
    throw new ApiRequestError(
      `Quoted cost ${quote.maxCredits} credits exceeds --max-credits ${maxCredits}; no job was submitted.`,
      "DATA_QUOTE_EXCEEDS_BUDGET",
      400,
    );
  }
  let result;
  try {
    result = await callDataRouterTool(
      "data_create",
      body,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );
  } catch (error) {
    throw new DataSearchRecoveryError(body.requestId, error);
  }
  if (result.status === 202)
    return dataSearchJobResponseSchema.parse(result.body);
  if (result.status >= 500) {
    throw new DataSearchRecoveryError(body.requestId, undefined);
  }
  handleError(
    result,
    `Could not create Data Search job (request ID ${body.requestId}; inspect saved jobs before another submission)`,
  );
}

export async function getDataSearchJob(jobId: string, signal: AbortSignal) {
  const result = await callDataRouterTool(
    "data_get",
    { jobId },
    AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  );
  if (result.status === 200)
    return dataSearchJobResponseSchema.parse(result.body);
  handleError(
    result,
    `Could not read saved Data Search job ${jobId}; recover with okou data jobs get ${jobId} --json`,
  );
}

export async function listDataSearchJobs(query: DataSearchListQuery) {
  const result = await callDataRouterTool(
    "data_list",
    query,
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  );
  if (result.status === 200)
    return dataSearchListResponseSchema.parse(result.body);
  handleError(result, "Could not list saved Data Search jobs");
}

export async function cancelDataSearchJob(jobId: string) {
  const result = await callDataRouterTool(
    "data_cancel",
    { jobId },
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  );
  if (result.status === 200)
    return dataSearchJobResponseSchema.parse(result.body);
  handleError(
    result,
    `Could not cancel Data Search job ${jobId}; inspect its saved status before retrying`,
  );
}
