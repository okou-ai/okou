import { callDataRouterTool } from "../data-router-client";
import {
  socialDataQuoteResponseSchema,
  socialDataJobResponseSchema,
  socialDataListResponseSchema,
  type SocialDataCreateRequest,
  type SocialDataContinueRequest,
  type SocialDataJobResponse,
  type SocialDataListQuery,
  type SocialDataListResponse,
  type SocialDataQuoteResponse,
  type SocialDataRequest,
} from "@okouai/api-contracts/contracts/social-data";

import { ApiRequestError, handleError } from "../core/client-factory";

const REQUEST_TIMEOUT_MS = 60_000;

export class SocialDataRecoveryError extends ApiRequestError {
  constructor(
    message: string,
    readonly recovery:
      | { readonly requestId: string; readonly command: string }
      | { readonly jobId: string; readonly command: string },
    options?: ErrorOptions,
  ) {
    super(message, "SOCIAL_JOB_RESPONSE_UNKNOWN", 503);
    this.cause = options?.cause;
  }
}

export async function quoteSocialData(
  body: SocialDataRequest,
): Promise<SocialDataQuoteResponse> {
  const result = await callDataRouterTool(
    "social_data_quote",
    body,
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  );
  if (result.status === 200)
    return socialDataQuoteResponseSchema.parse(result.body);
  handleError(result, "Okou Social could not quote this operation");
}

export async function createSocialDataJob(
  body: SocialDataCreateRequest,
): Promise<SocialDataJobResponse> {
  const { requestId: _requestId, maxCredits, ...request } = body;
  if (maxCredits !== undefined) {
    const quote = await quoteSocialData(request);
    if (quote.maxCredits > maxCredits) {
      throw new ApiRequestError(
        `Quoted cost ${quote.maxCredits} credits exceeds --max-credits ${maxCredits}; no job was submitted.`,
        "SOCIAL_QUOTE_EXCEEDS_BUDGET",
        400,
      );
    }
  }
  let result;
  try {
    result = await callDataRouterTool(
      "social_data_create",
      body,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );
  } catch (error) {
    throw new SocialDataRecoveryError(
      `The job submission response was not received (client request ID ${body.requestId}). Inspect okou data social jobs list --json. Do not resubmit: a repeated command can start another paid job.`,
      {
        requestId: body.requestId,
        command: "okou data social jobs list --json",
      },
      { cause: error },
    );
  }
  if (result.status === 202)
    return socialDataJobResponseSchema.parse(result.body);
  handleError(result, "Okou Social could not create this job");
}

export async function quoteSocialDataContinuation(
  jobId: string,
): Promise<SocialDataQuoteResponse> {
  const result = await callDataRouterTool(
    "social_data_quote_continuation",
    { jobId },
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  );
  if (result.status === 200)
    return socialDataQuoteResponseSchema.parse(result.body);
  handleError(result, "Okou Social could not quote this next page");
}

export async function continueSocialDataJob(
  jobId: string,
  body: SocialDataContinueRequest,
): Promise<SocialDataJobResponse> {
  if (body.maxCredits !== undefined) {
    const quote = await quoteSocialDataContinuation(jobId);
    if (quote.maxCredits > body.maxCredits) {
      throw new ApiRequestError(
        `Quoted cost ${quote.maxCredits} credits exceeds --max-credits ${body.maxCredits}; no continuation was submitted.`,
        "SOCIAL_QUOTE_EXCEEDS_BUDGET",
        400,
      );
    }
  }
  let result;
  try {
    result = await callDataRouterTool(
      "social_data_continue",
      { ...body, jobId },
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );
  } catch (error) {
    throw new SocialDataRecoveryError(
      `The next-page submission response was not received (client request ID ${body.requestId}). Inspect okou data social jobs list --json. Do not repeat the continuation: it can start another paid job.`,
      {
        requestId: body.requestId,
        command: "okou data social jobs list --json",
      },
      { cause: error },
    );
  }
  if (result.status === 202)
    return socialDataJobResponseSchema.parse(result.body);
  handleError(result, "Okou Social could not continue this collection");
}

export async function listSocialDataJobs(
  query: SocialDataListQuery,
): Promise<SocialDataListResponse> {
  const result = await callDataRouterTool(
    "social_data_list",
    query,
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  );
  if (result.status === 200)
    return socialDataListResponseSchema.parse(result.body);
  handleError(result, "Okou Social could not list saved jobs");
}

export async function getSocialDataJob(
  jobId: string,
  signal: AbortSignal,
): Promise<SocialDataJobResponse> {
  const result = await callDataRouterTool(
    "social_data_get",
    { jobId },
    AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  );
  if (result.status === 200)
    return socialDataJobResponseSchema.parse(result.body);
  handleError(result, "Okou Social could not read this saved job");
}

export async function cancelSocialDataJob(
  jobId: string,
): Promise<SocialDataJobResponse> {
  const result = await callDataRouterTool(
    "social_data_cancel",
    { jobId },
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  );
  if (result.status === 200)
    return socialDataJobResponseSchema.parse(result.body);
  handleError(result, "Okou Social could not cancel this job");
}
