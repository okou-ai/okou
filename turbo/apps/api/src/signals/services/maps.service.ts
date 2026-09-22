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
  recordManagedUsage$,
  type ManagedUsageErrorResponse,
} from "./managed-usage.service";

const USAGE_KIND = "maps";
const BILLING_CATEGORY = "provider_cost_usd_micros";
const MICRO_USD_PER_USD = 1_000_000;
// Bill published list cost because Vertex does not identify whether this
// request consumed the shared daily no-charge allowance.
const MAPS_GROUNDED_PROMPT_COST_MICROS = 25_000;
const TOKEN_PRICE_DENOMINATOR = 10n;
const INPUT_TOKEN_PRICE_TENTHS_OF_MICRO_USD = 3n;
const OUTPUT_TOKEN_PRICE_TENTHS_OF_MICRO_USD = 25n;
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
    if (error.reason === "blocked") {
      return badGateway(
        "Google Maps grounding could not answer this request",
        "MAPS_GROUNDING_BLOCKED",
      );
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

function providerCostMicros(result: VertexMapsResult): number {
  const tokenCostTenths =
    BigInt(result.usage.inputTokens) * INPUT_TOKEN_PRICE_TENTHS_OF_MICRO_USD +
    BigInt(result.usage.outputTokens) * OUTPUT_TOKEN_PRICE_TENTHS_OF_MICRO_USD;
  const tokenCostMicros =
    (tokenCostTenths + TOKEN_PRICE_DENOMINATOR - 1n) / TOKEN_PRICE_DENOMINATOR;
  const groundingCostMicros = result.grounded
    ? MAPS_GROUNDED_PROMPT_COST_MICROS
    : 0;
  const total = tokenCostMicros + BigInt(groundingCostMicros);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Google Maps grounding provider cost is too large");
  }
  return Number(total);
}

function successBody(
  request: MapsSearchRequest,
  result: VertexMapsResult,
  billingQuantity: number,
  creditsCharged: number,
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
    requestSignal.throwIfAborted();
    if (!generated.ok) {
      return providerError(generated.error);
    }
    if (generated.value === null) {
      return serviceUnavailable(
        "Okou Google Maps grounding is not configured",
        "NOT_CONFIGURED",
      );
    }

    const billingQuantity = providerCostMicros(generated.value);
    const creditsCharged =
      billingQuantity === 0
        ? 0
        : await set(
            recordManagedUsage$,
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
