import {
  findManagedSocialKitTool,
  MANAGED_SOCIALKIT_BILLING_CATEGORY,
  projectPublicSocialResponse,
  SOCIALKIT_MAX_INPUT_VALUE_CHARS,
  type ManagedSocialKitPagination,
  type ManagedSocialKitReportedTotalField,
  type ManagedSocialKitTool,
  type SocialErrorReason,
  type SocialKitCollectionProviderLimitedReason,
  type SocialKitRequest,
  type SocialKitResponse,
  socialKitResponseSchema,
} from "@okouai/api-contracts/contracts/social";
import { z } from "zod";
import { command } from "ccstate";

import { env } from "../../lib/env";
import type { AuthContext } from "../../types/auth";
import { requestSignal$ } from "../context/hono";
import { readBoundedResponseText, safeJsonParse, settle } from "../utils";
import {
  checkManagedCredits$,
  recordManagedUsage$,
  type ManagedUsageErrorResponse,
} from "./managed-usage.service";
import { normalizeSocialKitError } from "./socialkit-error";

const PROVIDER = "socialkit";
const USAGE_KIND = "social";
const SOCIALKIT_API_BASE = "https://api.socialkit.dev";
const SOCIALKIT_TIMEOUT_MS = 240_000;
const MAX_SOCIALKIT_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Internal acquisition verification is paid by the platform, not the claimant. */
export async function readGetStartedRewardPost(
  url: string,
  signal: AbortSignal,
): Promise<
  | { readonly kind: "post"; readonly id: string; readonly text: string }
  | { readonly kind: "retry"; readonly reason: string }
> {
  const accessKey = env("OKOU_SOCIAL_SOCIALKIT_TOKEN");
  if (!accessKey) {
    return { kind: "retry", reason: "verification_unavailable" };
  }
  const tool = findManagedSocialKitTool("twitter_tweet");
  if (!tool) {
    throw new Error("Twitter post verification tool is missing");
  }
  const request: SocialKitRequest = { tool: "twitter_tweet", input: { url } };
  const fetched = await settle(
    fetchSocialKit(
      accessKey,
      request,
      tool,
      AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    ),
  );
  signal.throwIfAborted();
  if (!fetched.ok) {
    if (
      fetched.error instanceof Error &&
      fetched.error.name === "TimeoutError"
    ) {
      return { kind: "retry", reason: "verification_timeout" };
    }
    throw fetched.error;
  }
  const response = fetched.value;
  if (response.kind === "error") {
    return { kind: "retry", reason: "verification_unavailable" };
  }
  const result = providerResult(response.body, accessKey, request, tool);
  if (!result.ok || !isRecord(result.result)) {
    return { kind: "retry", reason: "incomplete_response" };
  }
  const tweet = z
    .object({ id: z.string().min(1), text: z.string().min(1) })
    .safeParse(result.result.tweet);
  if (!tweet.success || !tweet.data.text.trim()) {
    return { kind: "retry", reason: "incomplete_response" };
  }
  return { kind: "post", id: tweet.data.id, text: tweet.data.text };
}

type ErrorStatus = 400 | 404 | 422 | 429 | 502 | 503;

interface SocialKitErrorResponse {
  readonly status: ErrorStatus;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
      readonly reason?: SocialErrorReason;
      readonly retryable?: boolean;
      readonly retryAfterSeconds?: number;
    };
  };
}

interface SocialKitErrorResult {
  readonly kind: "error";
  readonly error: SocialKitErrorResponse;
}

type SocialKitBodyResult =
  | SocialKitErrorResult
  | { readonly kind: "body"; readonly body: unknown };

type SocialKitFetchResult =
  | SocialKitErrorResult
  | {
      readonly kind: "response";
      readonly response: Response;
      readonly body: unknown;
    };

interface AuthedSocialKitArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: SocialKitRequest;
}

interface CompleteSocialKitArgs {
  readonly accessKey: string;
  readonly request: SocialKitRequest;
  readonly tool: ManagedSocialKitTool;
  readonly recordUsage: (quantity: number) => Promise<number>;
}

type SocialKitCommandResponse =
  | { readonly status: 200; readonly body: SocialKitResponse }
  | SocialKitErrorResponse
  | ManagedUsageErrorResponse;

function errorBody(message: string, code: string, reason?: SocialErrorReason) {
  return {
    error: {
      message,
      code,
      ...(reason ? { reason } : {}),
    },
  };
}

function errorResponse(
  status: ErrorStatus,
  message: string,
  code: string,
  reason?: SocialErrorReason,
): SocialKitErrorResponse {
  return { status, body: errorBody(message, code, reason) };
}

function badGateway(
  message: string,
  code: string,
  reason?: SocialErrorReason,
): SocialKitErrorResponse {
  return errorResponse(502, message, code, reason);
}

function errorResult(error: SocialKitErrorResponse): SocialKitErrorResult {
  return { kind: "error", error };
}

function invalidResponse(): SocialKitErrorResponse {
  return badGateway(
    "SocialKit returned an invalid response",
    "SOCIALKIT_INVALID_RESPONSE",
  );
}

function requestInputValue(request: SocialKitRequest, name: string): unknown {
  return Object.entries(request.input).find(([key]) => {
    return key === name;
  })?.[1];
}

function providerInputValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Validated SocialKit input is not JSON serializable");
  }
  return serialized;
}

function providerUrl(
  request: SocialKitRequest,
  tool: ManagedSocialKitTool,
): URL {
  const url = new URL(tool.path, SOCIALKIT_API_BASE);
  const resultLimit = effectiveRequestLimit(request, tool);
  for (const [name, value] of Object.entries(request.input)) {
    url.searchParams.set(
      name,
      providerInputValue(
        name === "limit" && resultLimit !== undefined ? resultLimit : value,
      ),
    );
  }
  if (
    resultLimit !== undefined &&
    requestInputValue(request, "limit") === undefined
  ) {
    url.searchParams.set("limit", String(resultLimit));
  }
  return url;
}

function providerRequestInit(
  accessKey: string,
  signal: AbortSignal,
): RequestInit {
  return {
    method: "GET",
    headers: { "x-access-key": accessKey },
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(SOCIALKIT_TIMEOUT_MS),
    ]),
  };
}

async function fetchSocialKit(
  accessKey: string,
  request: SocialKitRequest,
  tool: ManagedSocialKitTool,
  signal: AbortSignal,
): Promise<SocialKitBodyResult> {
  const settled = await settle(
    (async (): Promise<SocialKitFetchResult> => {
      const response = await fetch(
        providerUrl(request, tool),
        providerRequestInit(accessKey, signal),
      );
      const textResult = await readBoundedResponseText(
        response,
        MAX_SOCIALKIT_RESPONSE_BYTES,
      );
      if (textResult.kind === "too_large") {
        return errorResult(
          badGateway(
            "SocialKit response is too large",
            "SOCIALKIT_OUTPUT_TOO_LARGE",
          ),
        );
      }
      return {
        kind: "response",
        response,
        body: textResult.text ? safeJsonParse(textResult.text) : undefined,
      };
    })(),
  );

  if (!settled.ok) {
    if (signal.aborted) {
      signal.throwIfAborted();
    }
    const { error } = settled;
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      return errorResult(
        badGateway("SocialKit request timed out", "SOCIALKIT_REQUEST_TIMEOUT"),
      );
    }
    return errorResult(
      badGateway("SocialKit request failed", "SOCIALKIT_UPSTREAM_ERROR"),
    );
  }
  if (settled.value.kind === "error") {
    return settled.value;
  }
  if (!settled.value.response.ok) {
    const normalized = normalizeSocialKitError(
      settled.value.response.status,
      settled.value.body,
      {
        accessKey,
        headers: settled.value.response.headers,
        transcript: tool.availability === "transcript",
        requireInstagramViews:
          request.tool === "instagram_stats" &&
          request.input.requireViews === true,
      },
    );
    return errorResult({
      status: normalized.status,
      body: { error: normalized.error },
    });
  }
  return { kind: "body", body: settled.value.body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerResult(
  body: unknown,
  accessKey: string,
  request: SocialKitRequest,
  tool: ManagedSocialKitTool,
):
  | {
      readonly ok: true;
      readonly result: z.infer<ManagedSocialKitTool["resultSchema"]>;
      readonly collection: SocialKitResponse["collection"];
      readonly billingQuantity: number;
    }
  | { readonly ok: false } {
  if (
    !isRecord(body) ||
    body.success !== true ||
    !("data" in body) ||
    body.data === undefined
  ) {
    return { ok: false };
  }
  const serialized = JSON.stringify(body.data);
  if (serialized === undefined) {
    return { ok: false };
  }
  if (serialized.includes(accessKey)) {
    return { ok: false };
  }
  const result = tool.resultSchema.safeParse(body.data);
  if (!result.success) {
    return { ok: false };
  }
  const collection = validatedCollection(result.data, request, tool);
  if (collection === undefined) {
    return { ok: false };
  }
  const returnedItemsBillingQuantity = tool.collection?.itemsPerBillingUnit
    ? Math.max(
        1,
        Math.ceil(
          collection === null
            ? 0
            : collection.itemsReturned / tool.collection.itemsPerBillingUnit,
        ),
      )
    : 1;
  const billingQuantity =
    tool.collection?.pageSize?.kind === "provider_controlled"
      ? preflightBillingQuantity(request, tool)
      : returnedItemsBillingQuantity;
  return {
    ok: true,
    result: result.data,
    collection,
    billingQuantity,
  };
}

function effectiveRequestLimit(
  request: SocialKitRequest,
  tool: ManagedSocialKitTool,
): number | undefined {
  const collection = tool.collection;
  if (!collection || collection.defaultLimit === undefined) {
    return undefined;
  }
  const defaultLimit = collection.defaultLimit;
  const requestedLimit = requestInputValue(request, "limit");
  const limit =
    typeof requestedLimit === "number" ? requestedLimit : defaultLimit;
  return collection.effectiveLimit === undefined
    ? limit
    : Math.min(limit, collection.effectiveLimit);
}

function acceptedResultLimit(
  request: SocialKitRequest,
  tool: ManagedSocialKitTool,
): number | undefined {
  const requestLimit = effectiveRequestLimit(request, tool);
  return tool.collection?.pageSize?.kind === "provider_controlled" &&
    tool.maxLimit !== undefined
    ? tool.maxLimit
    : requestLimit;
}

function paginationCursorValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= SOCIALKIT_MAX_INPUT_VALUE_CHARS
    ? value
    : undefined;
}

type ValidatedCollection = NonNullable<SocialKitResponse["collection"]>;

type ReportedTotalValidation =
  | { readonly ok: true; readonly reportedTotal?: number }
  | { readonly ok: false };

function validatedReportedTotal(
  result: Record<string, unknown>,
  field: ManagedSocialKitReportedTotalField | undefined,
  itemsReturned: number,
): ReportedTotalValidation {
  if (
    field === undefined ||
    !Object.prototype.hasOwnProperty.call(result, field)
  ) {
    return { ok: true };
  }
  const value = result[field];
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= itemsReturned
    ? { ok: true, reportedTotal: value }
    : { ok: false };
}

function reportedTotalFields(reportedTotal: number | undefined): {
  readonly reportedTotal?: number;
} {
  return reportedTotal === undefined ? {} : { reportedTotal };
}

function providerLimitedCollection(
  itemsReturned: number,
  reason: SocialKitCollectionProviderLimitedReason,
  reportedTotal?: number,
): ValidatedCollection {
  return {
    state: "provider_limited",
    itemsReturned,
    reason,
    ...reportedTotalFields(reportedTotal),
  };
}

function validatedCursorPagination(
  result: Record<string, unknown>,
  itemsReturned: number,
  reportedTotal?: number,
): ValidatedCollection | undefined {
  if (typeof result.hasMore !== "boolean") {
    return undefined;
  }
  if (!result.hasMore) {
    return reportedTotal !== undefined && reportedTotal > itemsReturned
      ? providerLimitedCollection(
          itemsReturned,
          "reported_total_exceeds_page",
          reportedTotal,
        )
      : {
          state: "complete",
          itemsReturned,
          ...reportedTotalFields(reportedTotal),
        };
  }
  if (reportedTotal === itemsReturned) {
    return undefined;
  }
  const cursor = paginationCursorValue(result.cursor);
  return cursor === undefined
    ? undefined
    : {
        state: "more",
        itemsReturned,
        ...reportedTotalFields(reportedTotal),
        nextInput: { cursor },
      };
}

function validatedNextCursorPagination(
  result: Record<string, unknown>,
  itemsReturned: number,
  reportedTotal?: number,
): ValidatedCollection | undefined {
  if (
    result.nextCursor === undefined ||
    result.nextCursor === null ||
    result.nextCursor === ""
  ) {
    return reportedTotal !== undefined && reportedTotal > itemsReturned
      ? providerLimitedCollection(
          itemsReturned,
          "reported_total_exceeds_page",
          reportedTotal,
        )
      : {
          state: "complete",
          itemsReturned,
          ...reportedTotalFields(reportedTotal),
        };
  }
  if (reportedTotal === itemsReturned) {
    return undefined;
  }
  const cursor = paginationCursorValue(result.nextCursor);
  return cursor === undefined
    ? undefined
    : {
        state: "more",
        itemsReturned,
        ...reportedTotalFields(reportedTotal),
        nextInput: { cursor },
      };
}

function validatedPagePagination(
  result: Record<string, unknown>,
  itemsReturned: number,
  currentPage: number,
  maxPage: number,
  reportedTotal?: number,
): ValidatedCollection | undefined {
  if (typeof result.hasMore !== "boolean") {
    return undefined;
  }
  if (!result.hasMore) {
    return reportedTotal !== undefined && reportedTotal > itemsReturned
      ? providerLimitedCollection(
          itemsReturned,
          "reported_total_exceeds_page",
          reportedTotal,
        )
      : {
          state: "complete",
          itemsReturned,
          ...reportedTotalFields(reportedTotal),
        };
  }
  if (reportedTotal === itemsReturned) {
    return undefined;
  }
  return currentPage >= maxPage
    ? providerLimitedCollection(
        itemsReturned,
        "provider_ceiling",
        reportedTotal,
      )
    : {
        state: "more",
        itemsReturned,
        ...reportedTotalFields(reportedTotal),
        nextInput: { page: currentPage + 1 },
      };
}

function validatedPagination(
  result: Record<string, unknown>,
  itemsReturned: number,
  request: SocialKitRequest,
  pagination: ManagedSocialKitPagination,
  reportedTotal?: number,
): ValidatedCollection | undefined {
  switch (pagination.kind) {
    case "cursor": {
      return validatedCursorPagination(result, itemsReturned, reportedTotal);
    }
    case "next_cursor": {
      return validatedNextCursorPagination(
        result,
        itemsReturned,
        reportedTotal,
      );
    }
    case "page": {
      const page = requestInputValue(request, "page");
      return validatedPagePagination(
        result,
        itemsReturned,
        typeof page === "number" ? page : 1,
        pagination.maxPage,
        reportedTotal,
      );
    }
    case "none": {
      return providerLimitedCollection(
        itemsReturned,
        reportedTotal !== undefined && reportedTotal > itemsReturned
          ? "reported_total_exceeds_page"
          : "no_pagination",
        reportedTotal,
      );
    }
  }
}

function validatedCollection(
  result: unknown,
  request: SocialKitRequest,
  tool: ManagedSocialKitTool,
): SocialKitResponse["collection"] | undefined {
  const collection = tool.collection;
  if (!collection) {
    return null;
  }
  if (!isRecord(result)) {
    return undefined;
  }
  const items = result[collection.resultField];
  if (!Array.isArray(items)) {
    return undefined;
  }
  const resultLimit = acceptedResultLimit(request, tool);
  if (resultLimit !== undefined && items.length > resultLimit) {
    return undefined;
  }
  const reportedTotal = validatedReportedTotal(
    result,
    collection.reportedTotalField,
    items.length,
  );
  if (!reportedTotal.ok) {
    return undefined;
  }
  if (collection.sourceLimit) {
    return {
      state: "provider_limited",
      itemsReturned: items.length,
      reason: "provider_ceiling",
      sourceLimit: collection.sourceLimit,
    };
  }
  return validatedPagination(
    result,
    items.length,
    request,
    collection.pagination,
    reportedTotal.reportedTotal,
  );
}

function preflightBillingQuantity(
  request: SocialKitRequest,
  tool: ManagedSocialKitTool,
): number {
  const itemsPerBillingUnit = tool.collection?.itemsPerBillingUnit;
  const resultLimit = effectiveRequestLimit(request, tool);
  return itemsPerBillingUnit === undefined || resultLimit === undefined
    ? 1
    : Math.max(1, Math.ceil(resultLimit / itemsPerBillingUnit));
}

function runIdForUsage(auth: AuthContext): string | undefined {
  return auth.tokenType === "agent" || auth.tokenType === "sandbox"
    ? auth.runId
    : undefined;
}

async function completeSocialKitRequest(
  args: CompleteSocialKitArgs,
  providerSignal: AbortSignal,
): Promise<SocialKitCommandResponse> {
  const providerResponse = await fetchSocialKit(
    args.accessKey,
    args.request,
    args.tool,
    providerSignal,
  );
  if (providerResponse.kind === "error") {
    return providerResponse.error;
  }
  const parsed = providerResult(
    providerResponse.body,
    args.accessKey,
    args.request,
    args.tool,
  );
  if (!parsed.ok) {
    return invalidResponse();
  }
  const projectionCandidate = socialKitResponseSchema.parse({
    provider: PROVIDER,
    tool: args.tool.name,
    billingCategory: MANAGED_SOCIALKIT_BILLING_CATEGORY,
    billingQuantity: parsed.billingQuantity,
    creditsCharged: 0,
    collection: parsed.collection,
    result: parsed.result,
  });
  if (!projectPublicSocialResponse(projectionCandidate).ok) {
    return invalidResponse();
  }
  const creditsCharged = await args.recordUsage(parsed.billingQuantity);
  return {
    status: 200,
    body: socialKitResponseSchema.parse({
      provider: PROVIDER,
      tool: args.tool.name,
      billingCategory: MANAGED_SOCIALKIT_BILLING_CATEGORY,
      billingQuantity: parsed.billingQuantity,
      creditsCharged,
      collection: parsed.collection,
      result: parsed.result,
    }),
  };
}

export const socialKitRequest$ = command(
  async (
    { get, set },
    args: AuthedSocialKitArgs,
    signal: AbortSignal,
  ): Promise<SocialKitCommandResponse> => {
    const accessKey = env("OKOU_SOCIAL_SOCIALKIT_TOKEN");
    if (!accessKey) {
      return errorResponse(
        503,
        "Okou SocialKit provider is not configured",
        "NOT_CONFIGURED",
      );
    }

    const tool = findManagedSocialKitTool(args.body.tool);
    if (!tool) {
      throw new Error("Validated SocialKit request has no reviewed tool");
    }
    const requestSignal = AbortSignal.any([signal, get(requestSignal$)]);
    requestSignal.throwIfAborted();
    const preflightResource = {
      kind: USAGE_KIND,
      provider: PROVIDER,
      category: MANAGED_SOCIALKIT_BILLING_CATEGORY,
      quantity: preflightBillingQuantity(args.body, tool),
    };
    const creditError = await set(
      checkManagedCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: runIdForUsage(args.auth),
        resource: preflightResource,
        label: "Okou SocialKit",
      },
      requestSignal,
    );
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
    if (creditError) {
      return creditError;
    }

    const runId = runIdForUsage(args.auth);
    return completeSocialKitRequest(
      {
        accessKey,
        request: args.body,
        tool,
        recordUsage: (quantity) => {
          return set(
            recordManagedUsage$,
            {
              actor: {
                orgId: args.auth.orgId,
                userId: args.auth.userId,
                ...(runId ? { runId } : {}),
              },
              resource: {
                kind: USAGE_KIND,
                provider: PROVIDER,
                category: MANAGED_SOCIALKIT_BILLING_CATEGORY,
                quantity,
              },
              label: "SocialKit request",
            },
            signal,
          );
        },
      },
      requestSignal,
    );
  },
);
