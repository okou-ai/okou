import { command, state } from "ccstate";
import { marketingOnboardingContract } from "@okouai/api-contracts/contracts/marketing-onboarding";
import {
  initClient,
  trpcRestFetchApi,
} from "@okouai/api-contracts/contracts/trpc-contract";
import {
  type MarketingOnboardingTelemetry,
  recordClientTelemetry,
  startClientTelemetryMeasurement,
} from "../../lib/client-telemetry.ts";
import { resolveApiBaseForTarget } from "../api-base.ts";
import { apiClientRuntime$ } from "../api-client-runtime.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import {
  bestEffort,
  createDeferredPromise,
  onRejection,
  setDaemon,
  type DeferredPromise,
} from "../utils.ts";

interface OnboardingIdentity {
  readonly userId: string;
  readonly orgId: string;
}

const entry$ = state<DeferredPromise<OnboardingIdentity> | null>(null);
const attempts = localStorageSignals("marketing_onboarding_attempts");
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const enterFinishOnboarding$ = command(
  ({ get }, identity: OnboardingIdentity) => {
    const entry = get(entry$);
    if (entry && !entry.settled()) {
      entry.resolve(identity);
    }
  },
);

const sendFinishOnboarding$ = command(
  async ({ get, set }, identity: OnboardingIdentity, signal: AbortSignal) => {
    const measurement = startClientTelemetryMeasurement();
    let phase: "attempt" | "token" | "request" = "attempt";
    const record = (
      details: Pick<
        MarketingOnboardingTelemetry,
        "phase" | "result" | "response_status_code" | "marketing_request_id"
      >,
      outcome: "success" | "error" | "aborted" = "success",
    ) => {
      // This finite sink has no cancellation signal. Isolate all SDK errors,
      // including its own AbortError, without cancelling the only handoff.
      // The request's owner and deadline are still checked outside the sink.
      return Promise.allSettled([
        (async () => {
          recordClientTelemetry(
            measurement,
            {
              event_name: "marketing.onboarding",
              user_id: identity.userId,
              org_id: identity.orgId,
              ...details,
            },
            outcome,
          );
        })(),
      ]);
    };

    await onRejection(
      async () => {
        signal.throwIfAborted();
        const key = `${identity.userId}:${identity.orgId}`;
        const previous = (get(attempts.get$) ?? "").split("\n").filter(Boolean);
        if (previous.includes(key)) {
          await record({ phase: "complete", result: "duplicate_attempt" });
          return;
        }
        // Record the attempt before sending. Navigation, reloads and failures do
        // not retry this optional onboarding attribution request.
        set(attempts.set$, [...previous, key].join("\n"));
        await record({ phase: "attempt", result: "started" });
        signal.throwIfAborted();
        // Use the same session-token provider as the canonical App API client.
        // Marketing cookies carry attribution, not the authenticated identity.
        phase = "token";
        const token = await get(apiClientRuntime$).getToken(signal);
        signal.throwIfAborted();
        if (!token) {
          await record({ phase: "complete", result: "token_missing" }, "error");
          return;
        }
        await record({ phase: "token", result: "received" });
        const client = initClient(marketingOnboardingContract, {
          baseUrl: resolveApiBaseForTarget("www"),
          api: (args) => {
            // This optional handoff only consumes the acknowledgement. Do not
            // lose HTTP status when an edge error has an invalid JSON body.
            return trpcRestFetchApi(args, { parseResponseBody: false });
          },
        });
        phase = "request";
        await record({ phase: "request", result: "started" });
        signal.throwIfAborted();
        const response = await client.record({
          headers: { authorization: `Bearer ${token}` },
          fetchOptions: {
            credentials: "include",
            keepalive: true,
            signal,
          },
        });
        const requestId = response.headers.get("X-Marketing-Request-Id");
        // A 204 only acknowledges handling; Marketing owns consent and whether
        // any attribution was eligible to be persisted.
        await record(
          {
            phase: "complete",
            result: response.status === 204 ? "acknowledged" : "http_error",
            response_status_code: response.status,
            ...(requestId && REQUEST_ID_PATTERN.test(requestId)
              ? { marketing_request_id: requestId }
              : {}),
          },
          response.status === 204 ? "success" : "error",
        );
      },
      async (error) => {
        const failure = signal.aborted ? signal.reason : error;
        const errorName =
          typeof failure === "object" && failure !== null && "name" in failure
            ? failure.name
            : undefined;
        const result =
          errorName === "TimeoutError"
            ? "timeout"
            : errorName === "AbortError"
              ? "aborted"
              : phase === "token"
                ? "token_error"
                : phase === "request"
                  ? "request_error"
                  : "attempt_error";
        await record(
          { phase: "complete", result },
          result === "aborted" ? "aborted" : "error",
        );
      },
    );
  },
);

/** The root owns the request so onboarding navigation never waits for it. */
export const setupFinishOnboarding$ = command(
  ({ set }, signal: AbortSignal): void => {
    const entry = createDeferredPromise<OnboardingIdentity>(signal);
    set(entry$, entry);
    setDaemon(async (ownerSignal) => {
      const identity = await entry.promise;
      ownerSignal.throwIfAborted();
      const requestSignal = AbortSignal.any([
        ownerSignal,
        AbortSignal.timeout(10_000),
      ]);
      await bestEffort(
        set(sendFinishOnboarding$, identity, requestSignal),
        ownerSignal,
      );
    }, signal);
  },
);
