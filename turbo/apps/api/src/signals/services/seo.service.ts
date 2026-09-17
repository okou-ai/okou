import type {
  SeoBacklinksSummaryRequest,
  SeoEngine,
  SeoKeywordIdeasRequest,
  SeoRankedKeywordsRequest,
  SeoResponse,
  SeoSerpRequest,
} from "@okouai/api-contracts/contracts/seo";
import { command } from "ccstate";
import { z } from "zod";

import { dataForSeoLabsLocationCode } from "../../lib/dataforseo-labs-locations";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import type { AuthContext } from "../../types/auth";
import { requestSignal$ } from "../context/hono";
import { readBoundedResponseText, safeJsonParse, settle } from "../utils";
import {
  checkManagedCredits$,
  recordManagedUsage$,
  type ManagedUsageErrorResponse,
} from "./managed-usage.service";

const USAGE_KIND = "seo";
const DATAFORSEO_PROVIDER = "dataforseo";
const DATAFORSEO_BILLING_CATEGORY = "provider_cost_usd_micros";
const DATAFORSEO_BASE_URL = "https://api.dataforseo.com";
const PROVIDER_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDER_ERROR_MESSAGE_CHARS = 4096;
const MICRO_USD_PER_USD = 1_000_000;
const L = logger("Seo");

type SeoRequest =
  | { readonly operation: "serp"; readonly body: SeoSerpRequest }
  | {
      readonly operation: "keyword-ideas";
      readonly body: SeoKeywordIdeasRequest;
    }
  | {
      readonly operation: "ranked-keywords";
      readonly body: SeoRankedKeywordsRequest;
    }
  | {
      readonly operation: "backlinks-summary";
      readonly body: SeoBacklinksSummaryRequest;
    };

const DATAFORSEO_SERP_PATHS: Readonly<Record<SeoEngine, string>> = {
  google: "/v3/serp/google/organic/live/advanced",
  bing: "/v3/serp/bing/organic/live/advanced",
  google_maps: "/v3/serp/google/maps/live/advanced",
  google_news: "/v3/serp/google/news/live/advanced",
};

type DataForSeoRequest =
  | Extract<SeoRequest, { operation: "serp" | "backlinks-summary" }>
  | (Extract<SeoRequest, { operation: "keyword-ideas" | "ranked-keywords" }> & {
      readonly locationCode: number;
    });

interface AuthedSeoArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly request: SeoRequest;
}

type ErrorStatus = 400 | 502 | 503;

interface SeoErrorResponse {
  readonly status: ErrorStatus;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

interface SeoErrorResult {
  readonly kind: "error";
  readonly error: SeoErrorResponse;
}

interface SeoRetryableErrorResult {
  readonly kind: "retryable-error";
  readonly error: SeoErrorResponse;
}

type DataForSeoFetchResult =
  | SeoErrorResult
  | SeoRetryableErrorResult
  | { readonly kind: "body"; readonly body: unknown };

type DataForSeoBodyResult =
  | SeoErrorResult
  | {
      readonly kind: "body";
      readonly body: unknown;
      readonly providerCostUsd: number;
      readonly billingQuantity: number;
    };

type DataForSeoAttemptResult =
  | DataForSeoBodyResult
  | SeoRetryableErrorResult
  | { readonly kind: "empty" };

type SeoCommandResponse =
  | { readonly status: 200; readonly body: SeoResponse }
  | SeoErrorResponse
  | ManagedUsageErrorResponse;

const dataForSeoTaskSchema = z.object({
  status_code: z.number().int(),
  status_message: z.string(),
  cost: z.number().finite().nonnegative(),
});

const dataForSeoResponseSchema = z.object({
  status_code: z.number().int(),
  status_message: z.string(),
  cost: z.number().finite().nonnegative(),
  tasks_count: z.number().int().nonnegative(),
  tasks_error: z.number().int().nonnegative(),
  tasks: z.array(dataForSeoTaskSchema).max(1),
});

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function badGateway(
  message: string,
  code = "SEO_PROVIDER_ERROR",
): SeoErrorResponse {
  return { status: 502, body: errorBody(message, code) };
}

function invalidDataForSeoRequest(message: string): SeoErrorResponse {
  return {
    status: 400,
    body: errorBody(message, "DATAFORSEO_INVALID_REQUEST"),
  };
}

function serviceUnavailable(message: string): SeoErrorResponse {
  return { status: 503, body: errorBody(message, "NOT_CONFIGURED") };
}

function errorResult(error: SeoErrorResponse): SeoErrorResult {
  return { kind: "error", error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizedErrorMessage(message: string): string {
  const sanitized = Array.from(message, (character) => {
    const codeUnit = character.charCodeAt(0);
    return codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)
      ? " "
      : character;
  }).join("");
  return sanitized.length <= MAX_PROVIDER_ERROR_MESSAGE_CHARS
    ? sanitized
    : `${sanitized.slice(0, MAX_PROVIDER_ERROR_MESSAGE_CHARS - 3)}...`;
}

function parseResponseText(text: string): unknown {
  if (!text) {
    return null;
  }
  const parsed = safeJsonParse(text);
  return parsed === undefined ? text : parsed;
}

function dataForSeoDiagnostics(body: unknown): {
  readonly providerStatusCode?: number;
  readonly providerStatusMessage?: string;
  readonly providerCostUsd?: number;
  readonly tasksCount?: number;
  readonly tasksError?: number;
  readonly taskId?: string;
  readonly taskStatusCode?: number;
  readonly taskStatusMessage?: string;
  readonly taskCostUsd?: number;
} {
  if (!isRecord(body)) {
    return {};
  }
  const task =
    Array.isArray(body.tasks) && isRecord(body.tasks[0])
      ? body.tasks[0]
      : undefined;
  return {
    ...(typeof body.status_code === "number"
      ? { providerStatusCode: body.status_code }
      : {}),
    ...(typeof body.status_message === "string"
      ? { providerStatusMessage: sanitizedErrorMessage(body.status_message) }
      : {}),
    ...(typeof body.cost === "number" && Number.isFinite(body.cost)
      ? { providerCostUsd: body.cost }
      : {}),
    ...(typeof body.tasks_count === "number"
      ? { tasksCount: body.tasks_count }
      : {}),
    ...(typeof body.tasks_error === "number"
      ? { tasksError: body.tasks_error }
      : {}),
    ...(typeof task?.id === "string"
      ? { taskId: sanitizedErrorMessage(task.id) }
      : {}),
    ...(typeof task?.status_code === "number"
      ? { taskStatusCode: task.status_code }
      : {}),
    ...(typeof task?.status_message === "string"
      ? { taskStatusMessage: sanitizedErrorMessage(task.status_message) }
      : {}),
    ...(typeof task?.cost === "number" && Number.isFinite(task.cost)
      ? { taskCostUsd: task.cost }
      : {}),
  };
}

function canRetryDataForSeoStatus(statusCode: number | undefined): boolean {
  // Only absent, successful, or documented transient Live API statuses qualify.
  // Explicit account, parameter, and other task failures must not be retried.
  return (
    statusCode === undefined ||
    statusCode === 20_000 ||
    statusCode === 50_000 ||
    statusCode === 50_401
  );
}

function dataForSeoFailure(
  statusCode: number | undefined,
  statusMessage: string | undefined,
  httpStatus?: number,
): SeoErrorResponse {
  if (statusCode === 40_104) {
    return badGateway(
      "DataForSEO account requires verification",
      "DATAFORSEO_ACCOUNT_UNVERIFIED",
    );
  }
  if (statusCode === 40_100) {
    return badGateway(
      "DataForSEO authentication failed",
      "DATAFORSEO_AUTH_ERROR",
    );
  }
  if (statusCode === 40_202 || httpStatus === 429) {
    return badGateway(
      "DataForSEO is temporarily rate limited",
      "SEO_PROVIDER_RATE_LIMITED",
    );
  }
  if (
    statusCode !== undefined &&
    statusCode >= 40_501 &&
    statusCode <= 40_506
  ) {
    return invalidDataForSeoRequest(
      statusMessage ?? "DataForSEO rejected the request parameters",
    );
  }
  if (
    (statusCode !== undefined && statusCode >= 40_200 && statusCode < 40_300) ||
    httpStatus === 402
  ) {
    return badGateway(
      "DataForSEO account cannot process requests",
      "DATAFORSEO_ACCOUNT_ERROR",
    );
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return badGateway(
      "DataForSEO authentication failed",
      "DATAFORSEO_AUTH_ERROR",
    );
  }
  return badGateway(
    "DataForSEO upstream request failed",
    "DATAFORSEO_UPSTREAM_ERROR",
  );
}

async function fetchDataForSeoJson(
  url: URL,
  init: RequestInit,
  operation: SeoRequest["operation"],
  attempt: number,
  signal: AbortSignal,
): Promise<DataForSeoFetchResult> {
  const result = await settle(
    (async () => {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        ]),
      });
      const textResult = await readBoundedResponseText(
        response,
        MAX_PROVIDER_RESPONSE_BYTES,
      );
      if (textResult.kind === "too_large") {
        L.warn("DataForSEO API response exceeded the size limit", {
          operation,
          endpoint: url.pathname,
          attempt,
          httpStatus: response.status,
          maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES,
        });
        return errorResult(
          badGateway(
            "DataForSEO response is too large",
            "SEO_OUTPUT_TOO_LARGE",
          ),
        );
      }

      const body = parseResponseText(textResult.text);
      const diagnostics = dataForSeoDiagnostics(body);
      const requestDiagnostics = {
        operation,
        endpoint: url.pathname,
        attempt,
        httpStatus: response.status,
        httpStatusText: response.statusText,
        ...diagnostics,
      };
      if (!response.ok) {
        L.warn("DataForSEO API request failed", requestDiagnostics);
      } else if (operation === "backlinks-summary") {
        L.debug("DataForSEO API request completed", requestDiagnostics);
      }
      if (response.status === 429) {
        return errorResult(dataForSeoFailure(undefined, undefined, 429));
      }
      if (!response.ok) {
        const error = dataForSeoFailure(
          diagnostics.providerStatusCode,
          diagnostics.providerStatusMessage,
          response.status,
        );
        if (
          operation === "backlinks-summary" &&
          (response.status === 500 || response.status === 504) &&
          canRetryDataForSeoStatus(diagnostics.providerStatusCode) &&
          canRetryDataForSeoStatus(diagnostics.taskStatusCode)
        ) {
          return { kind: "retryable-error" as const, error };
        }
        return errorResult(error);
      }
      return { kind: "body" as const, body };
    })(),
  );

  if (!result.ok) {
    const timedOut =
      result.error instanceof Error &&
      (result.error.name === "AbortError" ||
        result.error.name === "TimeoutError");
    L.warn("DataForSEO API request failed", {
      operation,
      endpoint: url.pathname,
      attempt,
      failureKind: timedOut ? "timeout" : "network",
      ...(result.error instanceof Error
        ? {
            errorName: result.error.name,
            errorMessage: sanitizedErrorMessage(result.error.message),
          }
        : {}),
    });
    if (timedOut) {
      return errorResult(
        badGateway("DataForSEO request timed out", "SEO_TIMEOUT"),
      );
    }
    return errorResult(
      badGateway(
        "DataForSEO upstream request failed",
        "DATAFORSEO_UPSTREAM_ERROR",
      ),
    );
  }
  return result.value;
}

function prepareDataForSeoRequest(
  request: SeoRequest,
): DataForSeoRequest | SeoErrorResponse {
  if (
    request.operation !== "keyword-ideas" &&
    request.operation !== "ranked-keywords"
  ) {
    return request;
  }

  const locationCode = dataForSeoLabsLocationCode(request.body.location);
  if (locationCode === undefined) {
    return invalidDataForSeoRequest(
      `DataForSEO ${request.operation} requires a supported country or region, such as "United States" or "US". City and state locations are not supported. See https://docs.dataforseo.com/v3/dataforseo_labs_locations_and_languages/`,
    );
  }
  return { ...request, locationCode };
}

function dataForSeoPath(request: DataForSeoRequest): string {
  switch (request.operation) {
    case "serp": {
      return DATAFORSEO_SERP_PATHS[request.body.engine];
    }
    case "keyword-ideas": {
      return "/v3/dataforseo_labs/keyword_ideas/live";
    }
    case "ranked-keywords": {
      return "/v3/dataforseo_labs/ranked_keywords/live";
    }
    case "backlinks-summary": {
      return "/v3/backlinks/summary/live";
    }
  }
}

function dataForSeoTask(request: DataForSeoRequest): Record<string, unknown> {
  switch (request.operation) {
    case "serp": {
      return {
        keyword: request.body.query,
        location_name: normalizeDataForSeoLocation(request.body.location),
        language_code: request.body.languageCode,
        ...(request.body.engine === "google_news"
          ? {}
          : { device: request.body.device }),
        depth: request.body.limit,
      };
    }
    case "keyword-ideas": {
      return {
        keywords: [request.body.keyword],
        location_code: request.locationCode,
        language_code: request.body.languageCode,
        limit: request.body.limit,
      };
    }
    case "ranked-keywords": {
      return {
        target: request.body.target,
        location_code: request.locationCode,
        language_code: request.body.languageCode,
        limit: request.body.limit,
      };
    }
    case "backlinks-summary": {
      return {
        target: request.body.target,
        include_subdomains: request.body.includeSubdomains,
      };
    }
  }
}

function normalizeDataForSeoLocation(location: string): string {
  return location.replace(/\s*,\s*/g, ",");
}

function dataForSeoPreflightQuantity(request: DataForSeoRequest): number {
  switch (request.operation) {
    case "serp": {
      const resultsPerPage = request.body.engine === "google_maps" ? 100 : 10;
      return 2000 * Math.ceil(request.body.limit / resultsPerPage);
    }
    case "keyword-ideas":
    case "ranked-keywords": {
      return 12_000 + 120 * request.body.limit;
    }
    case "backlinks-summary": {
      return 24_000;
    }
  }
}

function providerCostMicros(costUsd: number): number | undefined {
  const quantity = Math.ceil(costUsd * MICRO_USD_PER_USD);
  return Number.isSafeInteger(quantity) ? quantity : undefined;
}

async function fetchDataForSeoOnce(
  login: string,
  password: string,
  request: DataForSeoRequest,
  attempt: number,
  signal: AbortSignal,
): Promise<DataForSeoAttemptResult> {
  const endpoint = dataForSeoPath(request);
  const logContext = { operation: request.operation, endpoint, attempt };
  const result = await fetchDataForSeoJson(
    new URL(endpoint, DATAFORSEO_BASE_URL),
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([dataForSeoTask(request)]),
    },
    request.operation,
    attempt,
    signal,
  );
  if (result.kind !== "body") {
    return result;
  }

  const providerStatus = dataForSeoDiagnostics(result.body);
  if (
    providerStatus.providerStatusCode !== undefined &&
    providerStatus.providerStatusCode !== 20_000
  ) {
    L.warn("DataForSEO request failed", {
      ...logContext,
      ...providerStatus,
    });
    return errorResult(
      dataForSeoFailure(
        providerStatus.providerStatusCode,
        providerStatus.providerStatusMessage,
      ),
    );
  }

  const parsed = dataForSeoResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    L.warn("DataForSEO API returned an invalid response", {
      ...logContext,
      validationIssues: parsed.error.issues.slice(0, 10).map((issue) => {
        return {
          path: issue.path.join("."),
          message: issue.message,
        };
      }),
    });
    return errorResult(
      badGateway(
        "DataForSEO returned an invalid response",
        "DATAFORSEO_INVALID_RESPONSE",
      ),
    );
  }
  if (
    parsed.data.status_code === 20_000 &&
    parsed.data.cost === 0 &&
    parsed.data.tasks_count === 0 &&
    parsed.data.tasks_error === 0 &&
    parsed.data.tasks.length === 0
  ) {
    return { kind: "empty" };
  }
  const task = parsed.data.tasks[0];
  if (!task || (parsed.data.tasks_error !== 0 && task.status_code === 20_000)) {
    L.warn("DataForSEO API returned an invalid task response", {
      ...logContext,
      tasksCount: parsed.data.tasks_count,
      tasksError: parsed.data.tasks_error,
      returnedTasks: parsed.data.tasks.length,
    });
    return errorResult(
      badGateway(
        "DataForSEO returned an invalid response",
        "DATAFORSEO_INVALID_RESPONSE",
      ),
    );
  }
  // SERP 40102 is a completed, potentially billable search with no items.
  // Preserve its status and metadata through the normal response and billing path.
  const hasNoSearchResults =
    request.operation === "serp" && task.status_code === 40_102;
  if (
    parsed.data.tasks_error !== 0 ||
    (task.status_code !== 20_000 && !hasNoSearchResults)
  ) {
    L.warn("DataForSEO task failed", {
      ...logContext,
      ...providerStatus,
    });
    return errorResult(
      dataForSeoFailure(
        task.status_code,
        sanitizedErrorMessage(task.status_message),
      ),
    );
  }
  const billingQuantity = providerCostMicros(parsed.data.cost);
  if (billingQuantity === undefined) {
    L.warn("DataForSEO API returned an invalid cost", {
      ...logContext,
      providerCostUsd: parsed.data.cost,
    });
    return errorResult(
      badGateway(
        "DataForSEO returned an invalid cost",
        "DATAFORSEO_INVALID_RESPONSE",
      ),
    );
  }
  return {
    kind: "body",
    body: result.body,
    providerCostUsd: parsed.data.cost,
    billingQuantity,
  };
}

async function fetchDataForSeo(
  login: string,
  password: string,
  request: DataForSeoRequest,
  signal: AbortSignal,
): Promise<DataForSeoBodyResult> {
  const firstResult = await fetchDataForSeoOnce(
    login,
    password,
    request,
    1,
    signal,
  );
  if (firstResult.kind !== "empty" && firstResult.kind !== "retryable-error") {
    return firstResult;
  }

  if (firstResult.kind === "empty") {
    L.warn("DataForSEO returned an empty task list; retrying", {
      operation: request.operation,
      endpoint: dataForSeoPath(request),
    });
  }
  // Empty-task and transient HTTP failures share one retry, even when mixed.
  signal.throwIfAborted();
  const retryResult = await fetchDataForSeoOnce(
    login,
    password,
    request,
    2,
    signal,
  );
  if (retryResult.kind === "retryable-error") {
    return errorResult(retryResult.error);
  }
  if (retryResult.kind !== "empty") {
    return retryResult;
  }

  L.warn("DataForSEO returned an empty task list after retry", {
    operation: request.operation,
    endpoint: dataForSeoPath(request),
  });
  return errorResult(
    badGateway("DataForSEO returned no task", "DATAFORSEO_EMPTY_TASKS"),
  );
}

function runIdForUsage(auth: AuthContext): string | undefined {
  return auth.tokenType === "agent" || auth.tokenType === "sandbox"
    ? auth.runId
    : undefined;
}

function usageActor(auth: AuthContext & { readonly orgId: string }) {
  const runId = runIdForUsage(auth);
  return {
    orgId: auth.orgId,
    userId: auth.userId,
    ...(runId ? { runId } : {}),
  };
}

const runDataForSeo$ = command(
  async (
    { get, set },
    args: AuthedSeoArgs,
    signal: AbortSignal,
  ): Promise<SeoCommandResponse> => {
    const login = env("OKOU_SEO_DATAFORSEO_LOGIN");
    const password = env("OKOU_SEO_DATAFORSEO_PASSWORD");
    if (!login || !password) {
      return serviceUnavailable(
        "Okou SEO DataForSEO provider is not configured",
      );
    }

    const providerSignal = AbortSignal.any([signal, get(requestSignal$)]);
    providerSignal.throwIfAborted();
    const request = prepareDataForSeoRequest(args.request);
    if ("status" in request) {
      return request;
    }
    const creditError = await set(
      checkManagedCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: runIdForUsage(args.auth),
        resource: {
          kind: USAGE_KIND,
          provider: DATAFORSEO_PROVIDER,
          category: DATAFORSEO_BILLING_CATEGORY,
          quantity: dataForSeoPreflightQuantity(request),
        },
        label: "Okou SEO DataForSEO",
      },
      providerSignal,
    );
    signal.throwIfAborted();
    providerSignal.throwIfAborted();
    if (creditError) {
      return creditError;
    }

    const providerResult = await fetchDataForSeo(
      login,
      password,
      request,
      providerSignal,
    );
    signal.throwIfAborted();
    if (providerResult.kind === "error") {
      return providerResult.error;
    }

    const creditsCharged =
      providerResult.billingQuantity === 0
        ? 0
        : await set(
            recordManagedUsage$,
            {
              actor: usageActor(args.auth),
              resource: {
                kind: USAGE_KIND,
                provider: DATAFORSEO_PROVIDER,
                category: DATAFORSEO_BILLING_CATEGORY,
                quantity: providerResult.billingQuantity,
              },
              label: "SEO DataForSEO",
            },
            signal,
          );
    return {
      status: 200,
      body: {
        operation: args.request.operation,
        provider: DATAFORSEO_PROVIDER,
        billingCategory: DATAFORSEO_BILLING_CATEGORY,
        billingQuantity: providerResult.billingQuantity,
        providerCostUsd: providerResult.providerCostUsd,
        creditsCharged,
        result: providerResult.body,
      },
    };
  },
);

export const seo$ = command(
  async (
    { set },
    args: AuthedSeoArgs,
    signal: AbortSignal,
  ): Promise<SeoCommandResponse> => {
    return await set(runDataForSeo$, args, signal);
  },
);
