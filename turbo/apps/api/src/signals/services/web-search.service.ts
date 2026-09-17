import {
  WEB_SEARCH_MAX_DATE_CHARS,
  WEB_SEARCH_MAX_SNIPPET_CHARS,
  WEB_SEARCH_MAX_TITLE_CHARS,
  WEB_SEARCH_MAX_URL_CHARS,
  type WebSearchRequest,
  type WebSearchResponse,
  type WebSearchResult,
} from "@okouai/api-contracts/contracts/web-search";
import { command } from "ccstate";
import { z } from "zod";

import { env } from "../../lib/env";
import type { AuthContext } from "../../types/auth";
import { requestSignal$ } from "../context/hono";
import {
  readBoundedResponseText,
  safeJsonParse,
  safeUrlParse,
  settle,
} from "../utils";
import {
  checkManagedCredits$,
  recordManagedUsage$,
  type ManagedUsageErrorResponse,
} from "./managed-usage.service";

const PROVIDER = "perplexity";
const USAGE_KIND = "web-search";
const BILLING_CATEGORY = "request";
const PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";
const PERPLEXITY_TIMEOUT_MS = 20_000;
const MAX_PERPLEXITY_RESPONSE_BYTES = 512 * 1024;
const MAX_PERPLEXITY_ERROR_MESSAGE_CHARS = 4096;
const MAX_TOTAL_SNIPPET_CHARS = 32_000;
const PERPLEXITY_MAX_TOKENS = 6000;
const PERPLEXITY_MAX_TOKENS_PER_PAGE = 1200;

const perplexityResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  date: z.string().nullable().optional(),
  last_updated: z.string().nullable().optional(),
});

const perplexityResponseSchema = z.object({
  results: z.array(perplexityResultSchema),
});

type ErrorStatus = 502 | 503;

interface WebSearchErrorResponse {
  readonly status: ErrorStatus;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

interface WebSearchErrorResult {
  readonly kind: "error";
  readonly error: WebSearchErrorResponse;
}

type PerplexityBodyResult =
  | WebSearchErrorResult
  | { readonly kind: "body"; readonly body: unknown };

type PerplexityResponseResult =
  | WebSearchErrorResult
  | {
      readonly kind: "response";
      readonly response: Response;
      readonly body: unknown;
    };

interface AuthedWebSearchArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: WebSearchRequest;
}

interface CompleteWebSearchArgs {
  readonly apiKey: string;
  readonly request: WebSearchRequest;
  readonly recordUsage: () => Promise<number>;
}

type WebSearchCommandResponse =
  | { readonly status: 200; readonly body: WebSearchResponse }
  | WebSearchErrorResponse
  | ManagedUsageErrorResponse;

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function badGateway(
  message: string,
  code = "PERPLEXITY_ERROR",
): WebSearchErrorResponse {
  return { status: 502, body: errorBody(message, code) };
}

function serviceUnavailable(
  message: string,
  code: string,
): WebSearchErrorResponse {
  return { status: 503, body: errorBody(message, code) };
}

function errorResult(error: WebSearchErrorResponse): WebSearchErrorResult {
  return { kind: "error", error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isControlCharacter(character: string): boolean {
  const codeUnit = character.charCodeAt(0);
  return codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f);
}

function sanitizeProviderText(value: string): string {
  return Array.from(value, (character) => {
    return isControlCharacter(character) ? " " : character;
  }).join("");
}

function boundedErrorMessage(message: string): string {
  const sanitized = sanitizeProviderText(message);
  return sanitized.length <= MAX_PERPLEXITY_ERROR_MESSAGE_CHARS
    ? sanitized
    : `${sanitized.slice(0, MAX_PERPLEXITY_ERROR_MESSAGE_CHARS - 3)}...`;
}

function perplexityErrorMessage(body: unknown): string {
  if (isRecord(body)) {
    if (typeof body.error === "string") {
      return boundedErrorMessage(body.error);
    }
    if (typeof body.message === "string") {
      return boundedErrorMessage(body.message);
    }
    if (typeof body.detail === "string") {
      return boundedErrorMessage(body.detail);
    }
  }
  if (typeof body === "string" && body.trim()) {
    return boundedErrorMessage(body);
  }
  return "Perplexity web search request failed";
}

function runIdForUsage(auth: AuthContext): string | undefined {
  return auth.tokenType === "agent" || auth.tokenType === "sandbox"
    ? auth.runId
    : undefined;
}

function parseResponseText(text: string): unknown {
  if (!text) {
    return null;
  }
  const parsed = safeJsonParse(text);
  return parsed === undefined ? text : parsed;
}

function providerRequestBody(request: WebSearchRequest) {
  return {
    query: request.query,
    max_results: request.limit,
    max_tokens: PERPLEXITY_MAX_TOKENS,
    max_tokens_per_page: PERPLEXITY_MAX_TOKENS_PER_PAGE,
    ...(request.recency ? { search_recency_filter: request.recency } : {}),
    ...(request.domains?.length
      ? { search_domain_filter: request.domains }
      : {}),
  };
}

async function fetchPerplexitySearch(
  apiKey: string,
  request: WebSearchRequest,
  signal: AbortSignal,
): Promise<PerplexityBodyResult> {
  const result = await settle(
    (async (): Promise<PerplexityResponseResult> => {
      const response = await fetch(PERPLEXITY_SEARCH_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(providerRequestBody(request)),
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(PERPLEXITY_TIMEOUT_MS),
        ]),
      });

      const textResult = await readBoundedResponseText(
        response,
        MAX_PERPLEXITY_RESPONSE_BYTES,
      );
      if (textResult.kind === "too_large") {
        return errorResult(
          badGateway(
            "Perplexity web search response is too large",
            "WEB_SEARCH_OUTPUT_TOO_LARGE",
          ),
        );
      }
      return {
        kind: "response",
        response,
        body: parseResponseText(textResult.text),
      };
    })(),
  );

  if (!result.ok) {
    const { error } = result;
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      return errorResult(
        badGateway(
          "Perplexity web search request timed out",
          "WEB_SEARCH_TIMEOUT",
        ),
      );
    }
    return errorResult(badGateway("Perplexity web search request failed"));
  }

  if (result.value.kind === "error") {
    return result.value;
  }

  const { response, body } = result.value;
  if (!response.ok) {
    if (response.status === 429) {
      return errorResult(
        badGateway(
          "Perplexity web search is temporarily rate limited",
          "PERPLEXITY_RATE_LIMITED",
        ),
      );
    }
    return errorResult(badGateway(perplexityErrorMessage(body)));
  }
  return { kind: "body", body };
}

function truncateAtCharacterBoundary(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const finalCodeUnit = value.charCodeAt(maxChars - 1);
  const endsWithHighSurrogate =
    finalCodeUnit >= 0xd8_00 && finalCodeUnit <= 0xdb_ff;
  return value.slice(0, endsWithHighSurrogate ? maxChars - 1 : maxChars);
}

function normalizedHttpUrl(value: string): string | undefined {
  if (value.length > WEB_SEARCH_MAX_URL_CHARS) {
    return undefined;
  }
  for (const character of value) {
    if (isControlCharacter(character)) {
      return undefined;
    }
  }
  const url = safeUrlParse(value);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return undefined;
  }
  const normalized = url.toString();
  return normalized.length <= WEB_SEARCH_MAX_URL_CHARS ? normalized : undefined;
}

function optionalDate(value: string | null | undefined): string | undefined {
  return typeof value === "string"
    ? truncateAtCharacterBoundary(
        sanitizeProviderText(value),
        WEB_SEARCH_MAX_DATE_CHARS,
      )
    : undefined;
}

function normalizePerplexityResponse(
  request: WebSearchRequest,
  body: unknown,
): readonly WebSearchResult[] | WebSearchErrorResponse {
  const parsed = perplexityResponseSchema.safeParse(body);
  if (!parsed.success) {
    return badGateway(
      "Perplexity web search returned an invalid response",
      "PERPLEXITY_INVALID_RESPONSE",
    );
  }

  let remainingSnippetChars = MAX_TOTAL_SNIPPET_CHARS;
  const results: WebSearchResult[] = [];
  for (const [index, result] of parsed.data.results
    .slice(0, request.limit)
    .entries()) {
    const url = normalizedHttpUrl(result.url);
    if (!url) {
      return badGateway(
        "Perplexity web search returned an invalid result URL",
        "PERPLEXITY_INVALID_RESPONSE",
      );
    }

    const snippetLimit = Math.min(
      WEB_SEARCH_MAX_SNIPPET_CHARS,
      remainingSnippetChars,
    );
    const snippet = truncateAtCharacterBoundary(
      sanitizeProviderText(result.snippet),
      snippetLimit,
    );
    remainingSnippetChars -= snippet.length;
    const publishedDate = optionalDate(result.date);
    const lastUpdatedDate = optionalDate(result.last_updated);
    results.push({
      rank: index + 1,
      title: truncateAtCharacterBoundary(
        sanitizeProviderText(result.title),
        WEB_SEARCH_MAX_TITLE_CHARS,
      ),
      url,
      snippet,
      ...(publishedDate ? { publishedDate } : {}),
      ...(lastUpdatedDate ? { lastUpdatedDate } : {}),
    });
  }
  return results;
}

function isWebSearchErrorResponse(
  value: unknown,
): value is WebSearchErrorResponse {
  return (
    isRecord(value) &&
    typeof value.status === "number" &&
    isRecord(value.body) &&
    isRecord(value.body.error)
  );
}

function successBody(
  request: WebSearchRequest,
  results: readonly WebSearchResult[],
  creditsCharged: number,
): WebSearchResponse {
  return {
    query: request.query,
    limit: request.limit,
    ...(request.recency ? { recency: request.recency } : {}),
    ...(request.domains ? { domains: request.domains } : {}),
    provider: PROVIDER,
    billingCategory: BILLING_CATEGORY,
    billingQuantity: 1,
    creditsCharged,
    results: [...results],
  };
}

async function completeWebSearch(
  args: CompleteWebSearchArgs,
  providerSignal: AbortSignal,
): Promise<WebSearchCommandResponse> {
  const providerResult = await fetchPerplexitySearch(
    args.apiKey,
    args.request,
    providerSignal,
  );
  if (providerResult.kind === "error") {
    return providerResult.error;
  }

  const normalized = normalizePerplexityResponse(
    args.request,
    providerResult.body,
  );
  if (isWebSearchErrorResponse(normalized)) {
    return normalized;
  }

  const creditsCharged = await args.recordUsage();
  return {
    status: 200,
    body: successBody(args.request, normalized, creditsCharged),
  };
}

export const webSearch$ = command(
  async (
    { get, set },
    args: AuthedWebSearchArgs,
    signal: AbortSignal,
  ): Promise<WebSearchCommandResponse> => {
    const apiKey = env("OKOU_WEB_SEARCH_PERPLEXITY_TOKEN");
    if (!apiKey) {
      return serviceUnavailable(
        "Okou Web Search Perplexity provider is not configured",
        "NOT_CONFIGURED",
      );
    }

    const requestSignal = AbortSignal.any([signal, get(requestSignal$)]);
    requestSignal.throwIfAborted();
    const creditError = await set(
      checkManagedCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: runIdForUsage(args.auth),
        resource: {
          kind: USAGE_KIND,
          provider: PROVIDER,
          category: BILLING_CATEGORY,
        },
        label: "Okou Web Search",
      },
      requestSignal,
    );
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
    if (creditError) {
      return creditError;
    }

    const runId = runIdForUsage(args.auth);
    return completeWebSearch(
      {
        apiKey,
        request: args.body,
        recordUsage: () => {
          // Provider work has completed, so client disconnect must not skip billing.
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
                category: BILLING_CATEGORY,
              },
              label: "web search",
            },
            signal,
          );
        },
      },
      requestSignal,
    );
  },
);
