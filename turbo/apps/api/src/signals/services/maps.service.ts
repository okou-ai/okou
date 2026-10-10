import type {
  MapsSearchRequest,
  MapsSearchResponse,
} from "@okouai/api-contracts/contracts/maps";
import { command } from "ccstate";

import type { AuthContext } from "../../types/auth";
import { requestSignal$ } from "../context/hono";
import { GcpLlmAuthError, gcpLlmConfiguration } from "../external/gcp-llm-auth";
import {
  generateVertexMapsSearch,
  VERTEX_MAPS_MODEL,
  VERTEX_MAPS_PROVIDER,
  VertexMapsError,
  type VertexMapsResult,
} from "../external/vertex-maps";
import { settle } from "../utils";
import {
  checkManagedCredits$,
  recordSuccessfulManagedUsage$,
  type ManagedUsageErrorResponse,
} from "./managed-usage.service";

const USAGE_KIND = "maps";
const BILLING_CATEGORY = "provider_cost_usd_micros";
const MICRO_USD_PER_USD = 1_000_000;
// Bill published list cost because Vertex does not identify whether this
// request consumed the shared monthly no-charge allowance.
const MAPS_QUERY_COST_MICROS = 14_000n;
const TOKEN_PRICE_DENOMINATOR = 1000n;
const INPUT_TOKEN_PRICE_THOUSANDTHS_OF_MICRO_USD = 1500n;
const CACHED_TOKEN_PRICE_THOUSANDTHS_OF_MICRO_USD = 150n;
const OUTPUT_TOKEN_PRICE_THOUSANDTHS_OF_MICRO_USD = 7500n;
// Admission estimate for three queries plus tokens, not a per-request spend cap.
const PREFLIGHT_PROVIDER_COST_MICROS = 50_000;

interface AuthedMapsSearchArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: MapsSearchRequest;
}

interface MapsErrorResponse {
  readonly status: 502 | 503;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

type MapsSearchCommandResponse =
  | { readonly status: 200; readonly body: MapsSearchResponse }
  | MapsErrorResponse
  | ManagedUsageErrorResponse;

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function badGateway(message: string, code: string): MapsErrorResponse {
  return { status: 502, body: errorBody(message, code) };
}

function serviceUnavailable(message: string, code: string): MapsErrorResponse {
  return { status: 503, body: errorBody(message, code) };
}

function providerError(error: unknown): MapsErrorResponse {
  if (error instanceof VertexMapsError) {
    if (error.status === 429) {
      return serviceUnavailable(
        "Google Maps grounding is temporarily rate limited",
        "MAPS_RATE_LIMITED",
      );
    }
    if (error.temporary) {
      return serviceUnavailable(
        "Google Maps grounding is temporarily unavailable",
        "MAPS_PROVIDER_UNAVAILABLE",
      );
    }
    if (error.reason === "response_too_large") {
      return badGateway(
        "Google Maps grounding response exceeded Okou's response size limit. Narrow the search area, request fewer places, or split the query before trying again.",
        "MAPS_RESPONSE_TOO_LARGE",
      );
    }
    if (error.reason === "invalid_usage") {
      return invalidProviderUsage();
    }
  }
  if (error instanceof GcpLlmAuthError && error.temporary) {
    return serviceUnavailable(
      "Google Maps grounding is temporarily unavailable",
      "MAPS_PROVIDER_UNAVAILABLE",
    );
  }
  return badGateway(
    "Google Maps grounding failed to produce a usable response",
    "MAPS_GROUNDING_ERROR",
  );
}

function runIdForUsage(auth: AuthContext): string | undefined {
  return auth.tokenType === "agent" || auth.tokenType === "sandbox"
    ? auth.runId
    : undefined;
}

function invalidProviderUsage(): MapsErrorResponse {
  return badGateway(
    "Google Maps grounding did not return valid billing usage",
    "MAPS_USAGE_UNAVAILABLE",
  );
}

function providerCostMicros(result: VertexMapsResult): number | null {
  const tokenCostThousandths =
    BigInt(result.usage.inputTokens - result.usage.cachedInputTokens) *
      INPUT_TOKEN_PRICE_THOUSANDTHS_OF_MICRO_USD +
    BigInt(result.usage.cachedInputTokens) *
      CACHED_TOKEN_PRICE_THOUSANDTHS_OF_MICRO_USD +
    BigInt(result.usage.outputTokens) *
      OUTPUT_TOKEN_PRICE_THOUSANDTHS_OF_MICRO_USD;
  const tokenCostMicros =
    (tokenCostThousandths + TOKEN_PRICE_DENOMINATOR - 1n) /
    TOKEN_PRICE_DENOMINATOR;
  const total =
    tokenCostMicros + BigInt(result.usage.mapsQueries) * MAPS_QUERY_COST_MICROS;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(total);
}

function successBody(
  request: MapsSearchRequest,
  result: VertexMapsResult,
  billingQuantity: number,
  creditsCharged: number | null,
): MapsSearchResponse {
  return {
    query: request.query,
    ...(request.location ? { location: request.location } : {}),
    ...(request.languageCode ? { languageCode: request.languageCode } : {}),
    provider: VERTEX_MAPS_PROVIDER,
    model: VERTEX_MAPS_MODEL,
    billingCategory: BILLING_CATEGORY,
    billingQuantity,
    providerCostUsd: billingQuantity / MICRO_USD_PER_USD,
    creditsCharged,
    answer: result.answer,
    sources: [...result.sources],
    citations: [...result.citations],
    ...(result.sources.length > 0
      ? { attribution: "Google Maps" as const }
      : {}),
    usage: result.usage,
  };
}

export const mapsSearch$ = command(
  async (
    { get, set },
    args: AuthedMapsSearchArgs,
    signal: AbortSignal,
  ): Promise<MapsSearchCommandResponse> => {
    if (!gcpLlmConfiguration()) {
      return serviceUnavailable(
        "Okou Google Maps grounding is not configured",
        "NOT_CONFIGURED",
      );
    }

    const requestSignal = AbortSignal.any([signal, get(requestSignal$)]);
    requestSignal.throwIfAborted();
    const runId = runIdForUsage(args.auth);
    const creditError = await set(
      checkManagedCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        ...(runId ? { runId } : {}),
        resource: {
          kind: USAGE_KIND,
          provider: VERTEX_MAPS_PROVIDER,
          category: BILLING_CATEGORY,
          quantity: PREFLIGHT_PROVIDER_COST_MICROS,
        },
        label: "Okou Google Maps grounding",
      },
      requestSignal,
    );
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
    if (creditError) {
      return creditError;
    }

    const generated = await settle(
      generateVertexMapsSearch(args.body, requestSignal),
    );
    signal.throwIfAborted();
    if (!generated.ok) {
      return providerError(generated.error);
    }
    if (generated.value === null) {
      return serviceUnavailable(
        "Okou Google Maps grounding is not configured",
        "NOT_CONFIGURED",
      );
    }

    // A parsed provider result has incurred billable work. From this point,
    // client disconnect no longer owns settlement; the command owner does.
    const billingQuantity = providerCostMicros(generated.value);
    if (billingQuantity === null) {
      return invalidProviderUsage();
    }
    const creditsCharged =
      billingQuantity === 0
        ? 0
        : await set(
            recordSuccessfulManagedUsage$,
            {
              actor: {
                orgId: args.auth.orgId,
                userId: args.auth.userId,
                ...(runId ? { runId } : {}),
              },
              resource: {
                kind: USAGE_KIND,
                provider: VERTEX_MAPS_PROVIDER,
                category: BILLING_CATEGORY,
                quantity: billingQuantity,
              },
              label: "Google Maps grounding",
            },
            // Provider work has completed, so client disconnect must not skip billing.
            signal,
          );
    return {
      status: 200,
      body: successBody(
        args.body,
        generated.value,
        billingQuantity,
        creditsCharged,
      ),
    };
  },
);
