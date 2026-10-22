import {
  dataSearchContract,
  type DataSearchRequest,
  type DataSearchCreateRequest,
  type DataSearchListQuery,
} from "@okouai/api-contracts/contracts/data-search";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import {
  ApiRequestError,
  getClientConfig,
  handleError,
} from "../core/client-factory";

const REQUEST_TIMEOUT_MS = 60_000;

export class DataSearchRecoveryError extends ApiRequestError {
  constructor(
    readonly requestId: string,
    cause: unknown,
  ) {
    super(
      `Submission response unknown. Run okou data jobs list --json, or repeat the identical command with --request-id ${requestId}. Do not use a new request ID.`,
      "DATA_JOB_RESPONSE_UNKNOWN",
      503,
    );
    this.cause = cause;
  }
}

async function client() {
  return initClient(dataSearchContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
}

export async function listDataSearchCapabilities(query?: string) {
  const result = await (
    await client()
  ).capabilities({
    headers: {},
    query: { query },
    fetchOptions: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Could not discover Data Search capabilities");
}

export async function quoteDataSearch(body: DataSearchRequest) {
  const result = await (
    await client()
  ).quote({
    headers: {},
    body,
    fetchOptions: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Could not quote Data Search");
}

export async function createDataSearchJob(body: DataSearchCreateRequest) {
  const api = await client();
  let result;
  try {
    result = await api.create({
      headers: {},
      body,
      fetchOptions: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    });
  } catch (error) {
    throw new DataSearchRecoveryError(body.requestId, error);
  }
  if (result.status === 202) return result.body;
  if (result.status >= 500) {
    throw new DataSearchRecoveryError(body.requestId, undefined);
  }
  handleError(
    result,
    `Could not create Data Search job (request ID ${body.requestId}; reuse this ID to recover)`,
  );
}

export async function getDataSearchJob(jobId: string, signal: AbortSignal) {
  const result = await (
    await client()
  ).get({
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
  handleError(
    result,
    `Could not read saved Data Search job ${jobId}; recover with okou data jobs get ${jobId} --json`,
  );
}

export async function listDataSearchJobs(query: DataSearchListQuery) {
  const result = await (
    await client()
  ).list({
    headers: {},
    query,
    fetchOptions: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Could not list saved Data Search jobs");
}

export async function cancelDataSearchJob(jobId: string) {
  const result = await (
    await client()
  ).cancel({
    headers: {},
    params: { jobId },
    body: {},
    fetchOptions: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  });
  if (result.status === 200) return result.body;
  handleError(
    result,
    `Could not cancel Data Search job ${jobId}; inspect its saved status before retrying`,
  );
}
