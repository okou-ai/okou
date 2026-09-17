import type {
  FinanceChartRequest,
  FinanceOperation,
  FinanceProfileRequest,
  FinanceQuoteRequest,
  FinanceResponse,
  FinanceSearchRequest,
} from "@okouai/api-contracts/contracts/finance";
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

const PROVIDER = "apidojo";
const USAGE_KIND = "finance";
const BILLING_CATEGORY = "request";
const APIDOJO_HOST = "apidojo-yahoo-finance-v1.p.rapidapi.com";
const APIDOJO_BASE_URL = `https://${APIDOJO_HOST}`;
const APIDOJO_TIMEOUT_MS = 20_000;
const MAX_APIDOJO_RESPONSE_BYTES = 8 * 1024 * 1024;

type FinanceRequest =
  | {
      readonly operation: "search";
      readonly body: FinanceSearchRequest;
    }
  | {
      readonly operation: "profile";
      readonly body: FinanceProfileRequest;
    }
  | {
      readonly operation: "quote";
      readonly body: FinanceQuoteRequest;
    }
  | {
      readonly operation: "chart";
      readonly body: FinanceChartRequest;
    };

interface AuthedFinanceArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly request: FinanceRequest;
}

type ErrorStatus = 502 | 503;

interface FinanceErrorResponse {
  readonly status: ErrorStatus;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

interface FinanceErrorResult {
  readonly kind: "error";
  readonly error: FinanceErrorResponse;
}

type FinanceProviderResult =
  | FinanceErrorResult
  | { readonly kind: "body"; readonly body: unknown };

type FinanceCommandResponse =
  | { readonly status: 200; readonly body: FinanceResponse }
  | FinanceErrorResponse
  | ManagedUsageErrorResponse;

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function badGateway(
  message: string,
  code = "APIDOJO_ERROR",
): FinanceErrorResponse {
  return { status: 502, body: errorBody(message, code) };
}

function serviceUnavailable(
  message: string,
  code: string,
): FinanceErrorResponse {
  return { status: 503, body: errorBody(message, code) };
}

function errorResult(error: FinanceErrorResponse): FinanceErrorResult {
  return { kind: "error", error };
}

function financeUrl(request: FinanceRequest): URL {
  let url: URL;
  switch (request.operation) {
    case "search": {
      url = new URL("/auto-complete", APIDOJO_BASE_URL);
      url.searchParams.set("q", request.body.query);
      url.searchParams.set("region", "US");
      return url;
    }
    case "profile": {
      url = new URL("/stock/v3/get-profile", APIDOJO_BASE_URL);
      url.searchParams.set("symbol", request.body.symbol);
      url.searchParams.set("region", "US");
      return url;
    }
    case "quote": {
      url = new URL("/market/v2/get-quotes", APIDOJO_BASE_URL);
      url.searchParams.set("symbols", request.body.symbol);
      url.searchParams.set("region", "US");
      return url;
    }
    case "chart": {
      url = new URL("/stock/v3/get-chart", APIDOJO_BASE_URL);
      url.searchParams.set("symbol", request.body.symbol);
      url.searchParams.set("range", request.body.range);
      url.searchParams.set("interval", request.body.interval);
      return url;
    }
  }
}

async function fetchApidojo(
  apiKey: string,
  request: FinanceRequest,
  signal: AbortSignal,
): Promise<FinanceProviderResult> {
  const result = await settle(
    (async () => {
      const response = await fetch(financeUrl(request), {
        headers: {
          "X-RapidAPI-Key": apiKey,
          "X-RapidAPI-Host": APIDOJO_HOST,
        },
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(APIDOJO_TIMEOUT_MS),
        ]),
      });
      const textResult = await readBoundedResponseText(
        response,
        MAX_APIDOJO_RESPONSE_BYTES,
      );
      if (textResult.kind === "too_large") {
        return errorResult(
          badGateway(
            "APIDojo finance response is too large",
            "FINANCE_OUTPUT_TOO_LARGE",
          ),
        );
      }

      if (response.status === 429) {
        return errorResult(
          badGateway(
            "APIDojo finance is temporarily rate limited",
            "APIDOJO_RATE_LIMITED",
          ),
        );
      }
      if (response.status !== 200) {
        return errorResult(badGateway("APIDojo finance request failed"));
      }
      const body = textResult.text ? safeJsonParse(textResult.text) : null;
      if (body === undefined) {
        return errorResult(
          badGateway(
            "APIDojo finance returned an invalid JSON response",
            "APIDOJO_INVALID_RESPONSE",
          ),
        );
      }
      return { kind: "body" as const, body };
    })(),
  );

  if (!result.ok) {
    if (result.error instanceof Error && result.error.name === "TimeoutError") {
      return errorResult(
        badGateway("APIDojo finance request timed out", "FINANCE_TIMEOUT"),
      );
    }
    return errorResult(badGateway("APIDojo finance request failed"));
  }
  return result.value;
}

function runIdForUsage(auth: AuthContext): string | undefined {
  return auth.tokenType === "agent" || auth.tokenType === "sandbox"
    ? auth.runId
    : undefined;
}

function successBody(
  operation: FinanceOperation,
  result: unknown,
  creditsCharged: number,
): FinanceResponse {
  return {
    operation,
    provider: PROVIDER,
    billingCategory: BILLING_CATEGORY,
    billingQuantity: 1,
    creditsCharged,
    result,
  };
}

export const finance$ = command(
  async (
    { get, set },
    args: AuthedFinanceArgs,
    signal: AbortSignal,
  ): Promise<FinanceCommandResponse> => {
    const apiKey = env("OKOU_FINANCE_APIDOJO_TOKEN");
    if (!apiKey) {
      return serviceUnavailable(
        "Okou Finance APIDojo provider is not configured",
        "NOT_CONFIGURED",
      );
    }

    const providerSignal = AbortSignal.any([signal, get(requestSignal$)]);
    providerSignal.throwIfAborted();
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
        label: "Okou Finance",
      },
      providerSignal,
    );
    signal.throwIfAborted();
    providerSignal.throwIfAborted();
    if (creditError) {
      return creditError;
    }

    const providerResult = await fetchApidojo(
      apiKey,
      args.request,
      providerSignal,
    );
    signal.throwIfAborted();
    if (providerResult.kind === "error") {
      return providerResult.error;
    }

    const runId = runIdForUsage(args.auth);
    const creditsCharged = await set(
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
        label: "finance",
      },
      signal,
    );
    return {
      status: 200,
      body: successBody(
        args.request.operation,
        providerResult.body,
        creditsCharged,
      ),
    };
  },
);
