import { creditPolicyRunId } from "./official-workflow-policy.service";
import type {
  FinanceChartRequest,
  FinanceOperation,
  FinanceProfileRequest,
  FinanceQuoteRequest,
  FinanceResponse,
  FinanceSearchRequest,
} from "@okouai/api-contracts/contracts/finance";
import { command } from "ccstate";
import { delay } from "signal-timers";
import { z } from "zod";

import { env } from "../../lib/env";
import type { AuthContext } from "../../types/auth";
import { requestSignal$ } from "../context/hono";
import {
  readBoundedResponseText,
  safeJsonParse,
  settleIncludingAbort,
} from "../utils";
import {
  checkManagedCredits$,
  recordSuccessfulManagedUsage$,
  type ManagedUsageErrorResponse,
} from "./managed-usage.service";

const PROVIDER = "monid/yahoo-finance";
const USAGE_KIND = "finance";
const BILLING_CATEGORY = "provider_cost_usd_micros";
// Each Yahoo Finance tool costs $0.05 per call in Monid's catalog.
const BILLING_QUANTITY = 50_000;
const MONID_BASE_URL = "https://api.monid.ai/v1";
const MONID_TIMEOUT_MS = 120_000;
const MAX_MONID_RESPONSE_BYTES = 8 * 1024 * 1024;

const monidRunSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  provider: z.literal("yahoo-finance"),
  endpoint: z.string(),
  status: z.enum([
    "READY",
    "RUNNING",
    "STOPPING",
    "COMPLETED",
    "FAILED",
    "BLOCKED",
    "STOPPED",
    "TIMED_OUT",
  ]),
  output: z.unknown().optional(),
  providerResponse: z
    .object({ httpStatus: z.number().int(), error: z.unknown().optional() })
    .optional(),
});

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
  FinanceErrorResult | { readonly kind: "body"; readonly body: unknown };

type FinanceCommandResponse =
  | { readonly status: 200; readonly body: FinanceResponse }
  | FinanceErrorResponse
  | ManagedUsageErrorResponse;

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function badGateway(
  message: string,
  code = "MONID_ERROR",
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

function financePlan(request: FinanceRequest) {
  switch (request.operation) {
    case "search": {
      return {
        endpoint: "/search_tickers",
        input: { queryParams: { query: request.body.query } },
      };
    }
    case "profile": {
      return {
        endpoint: "/get_company_profile",
        input: { queryParams: { symbol: request.body.symbol } },
      };
    }
    case "quote": {
      return {
        endpoint: "/get_quote",
        input: { queryParams: { symbols: request.body.symbol } },
      };
    }
    case "chart": {
      return {
        endpoint: "/get_historical_data",
        input: {
          queryParams: {
            symbol: request.body.symbol,
            range: request.body.range,
            interval: request.body.interval,
          },
        },
      };
    }
  }
}

async function readMonidRun(
  response: Response,
  endpoint: string,
  upstreamRunId?: string,
): Promise<
  | FinanceErrorResult
  | { readonly kind: "run"; readonly run: z.infer<typeof monidRunSchema> }
> {
  const textResult = await readBoundedResponseText(
    response,
    MAX_MONID_RESPONSE_BYTES,
  );
  if (textResult.kind === "too_large") {
    return errorResult(
      badGateway(
        "Monid finance response is too large",
        "FINANCE_OUTPUT_TOO_LARGE",
      ),
    );
  }
  if (response.status === 429) {
    return errorResult(
      badGateway(
        "Monid finance is temporarily rate limited",
        "MONID_RATE_LIMITED",
      ),
    );
  }
  if ([401, 402, 403, 503].includes(response.status)) {
    return errorResult(
      serviceUnavailable(
        "Monid finance provider is unavailable",
        "MONID_UNAVAILABLE",
      ),
    );
  }
  if (response.status !== 200 && response.status !== 202) {
    return errorResult(badGateway("Monid finance request failed"));
  }
  const parsed = monidRunSchema.safeParse(safeJsonParse(textResult.text));
  if (
    !parsed.success ||
    parsed.data.endpoint !== endpoint ||
    (upstreamRunId !== undefined && parsed.data.runId !== upstreamRunId)
  ) {
    return errorResult(
      badGateway(
        "Monid finance returned an invalid run response",
        "MONID_INVALID_RESPONSE",
      ),
    );
  }
  return { kind: "run", run: parsed.data };
}

function completedMonidResult(
  run: z.infer<typeof monidRunSchema>,
  httpStatus: number,
): FinanceProviderResult {
  if (
    httpStatus !== 200 ||
    !run.providerResponse ||
    run.providerResponse.httpStatus < 200 ||
    run.providerResponse.httpStatus >= 300 ||
    (run.providerResponse.error !== undefined &&
      run.providerResponse.error !== null) ||
    run.output === undefined
  ) {
    return errorResult(
      badGateway("Monid finance source did not return a valid result"),
    );
  }
  return { kind: "body", body: run.output };
}

async function fetchMonid(
  apiKey: string,
  request: FinanceRequest,
  signal: AbortSignal,
): Promise<FinanceProviderResult> {
  const plan = financePlan(request);
  const providerSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(MONID_TIMEOUT_MS),
  ]);
  let upstreamRunId: string | undefined;
  // Capture the provider deadline even when a polling timer rejects with
  // AbortError. Caller cancellation is rethrown after joining this paid work.
  const result = await settleIncludingAbort(
    (async (): Promise<FinanceProviderResult> => {
      // Execute once. Async responses are observed through the same run, never
      // retried as a new paid execution when the outcome is uncertain.
      let url = `${MONID_BASE_URL}/run`;
      let init: RequestInit = {
        method: "POST",
        body: JSON.stringify({ provider: "yahoo-finance", ...plan }),
      };
      for (;;) {
        const response = await fetch(url, {
          ...init,
          redirect: "error",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          signal: providerSignal,
        });
        const parsed = await readMonidRun(
          response,
          plan.endpoint,
          upstreamRunId,
        );
        if (parsed.kind === "error") {
          return parsed;
        }
        const run = parsed.run;
        upstreamRunId = run.runId;
        switch (run.status) {
          case "COMPLETED": {
            return completedMonidResult(run, response.status);
          }
          case "FAILED":
          case "BLOCKED":
          case "STOPPED":
          case "TIMED_OUT": {
            return errorResult(
              badGateway(
                "Monid finance execution did not complete successfully",
              ),
            );
          }
          case "READY":
          case "RUNNING":
          case "STOPPING": {
            if (init.method === "GET") {
              await delay(5000, { signal: providerSignal });
            }
            url = `${MONID_BASE_URL}/runs/${encodeURIComponent(upstreamRunId)}`;
            init = { method: "GET" };
            break;
          }
        }
      }
    })(),
  );
  signal.throwIfAborted();

  if (!result.ok) {
    const timedOut =
      providerSignal.aborted &&
      providerSignal.reason instanceof Error &&
      providerSignal.reason.name === "TimeoutError";
    return errorResult(
      badGateway(
        `Monid finance execution outcome is unknown${upstreamRunId ? ` (run ${upstreamRunId})` : ""}. Do not automatically retry.`,
        timedOut ? "FINANCE_TIMEOUT" : "MONID_EXECUTION_UNKNOWN",
      ),
    );
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
  creditsCharged: number | null,
): FinanceResponse {
  return {
    operation,
    provider: PROVIDER,
    billingCategory: BILLING_CATEGORY,
    billingQuantity: BILLING_QUANTITY,
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
    const apiKey = env("OKOU_FINANCE_MONID_API_KEY");
    if (!apiKey) {
      return serviceUnavailable(
        "Okou Finance Monid provider is not configured",
        "NOT_CONFIGURED",
      );
    }

    const providerSignal = AbortSignal.any([signal, get(requestSignal$)]);
    providerSignal.throwIfAborted();
    const creditError = await set(
      checkManagedCredits$,
      {
        runId: creditPolicyRunId(args.auth),
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        resource: {
          kind: USAGE_KIND,
          provider: PROVIDER,
          category: BILLING_CATEGORY,
          quantity: BILLING_QUANTITY,
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

    const providerResult = await fetchMonid(
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
      recordSuccessfulManagedUsage$,
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
          quantity: BILLING_QUANTITY,
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
