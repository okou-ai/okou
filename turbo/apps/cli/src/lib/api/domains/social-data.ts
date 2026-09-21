import {
  socialDataContract,
  type SocialDataCreateRequest,
  type SocialDataJobResponse,
  type SocialDataListQuery,
  type SocialDataListResponse,
  type SocialDataQuoteResponse,
  type SocialDataRequest,
} from "@okouai/api-contracts/contracts/social-data";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import {
  ApiRequestError,
  getClientConfig,
  handleError,
} from "../core/client-factory";

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
  const client = initClient(socialDataContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.quote({
    headers: {},
    body,
    fetchOptions: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Okou Social could not quote this operation");
}

export async function createSocialDataJob(
  body: SocialDataCreateRequest,
): Promise<SocialDataJobResponse> {
  const client = initClient(socialDataContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  let result;
  try {
    result = await client.create({
      headers: {},
      body,
      fetchOptions: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    });
  } catch (error) {
    throw new SocialDataRecoveryError(
      `The job submission response was not received. Check saved jobs, or repeat the original command with --request-id ${body.requestId} to recover the same submission. Do not use a new request ID.`,
      { requestId: body.requestId, command: "okou social jobs list --json" },
      { cause: error },
    );
  }
  if (result.status === 202) return result.body;
  handleError(result, "Okou Social could not create this job");
}

export async function listSocialDataJobs(
  query: SocialDataListQuery,
): Promise<SocialDataListResponse> {
  const client = initClient(socialDataContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.list({
    headers: {},
    query,
    fetchOptions: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Okou Social could not list saved jobs");
}

export async function getSocialDataJob(
  jobId: string,
  signal: AbortSignal,
): Promise<SocialDataJobResponse> {
  const client = initClient(socialDataContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.get({
    headers: {},
    params: { jobId },
    fetchOptions: {
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Okou Social could not read this saved job");
}

export async function cancelSocialDataJob(
  jobId: string,
): Promise<SocialDataJobResponse> {
  const client = initClient(socialDataContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.cancel({
    headers: {},
    params: { jobId },
    body: {},
    fetchOptions: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Okou Social could not cancel this job");
}
