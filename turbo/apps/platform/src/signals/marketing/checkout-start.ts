import { command } from "ccstate";
import {
  marketingCheckoutContract,
  type MarketingCheckoutRequest,
} from "@okouai/api-contracts/contracts/marketing-checkout";
import {
  initClient,
  trpcRestFetchApi,
} from "@okouai/api-contracts/contracts/trpc-contract";
import {
  type MarketingCheckoutTelemetry,
  recordClientTelemetry,
  startClientTelemetryMeasurement,
} from "../../lib/client-telemetry.ts";
import { nowDate } from "../../lib/time.ts";
import { resolveApiBaseForTarget } from "../api-base.ts";
import { apiClientRuntime$ } from "../api-client-runtime.ts";
import { rootSignal$ } from "../root-signal.ts";
import { bestEffort, onRejection, setDaemon } from "../utils.ts";

const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const sendMarketingCheckoutStart$ = command(
  async ({ get }, event: MarketingCheckoutRequest, signal: AbortSignal) => {
    const measurement = startClientTelemetryMeasurement();
    let phase: "token" | "request" = "token";
    const record = (
      details: Pick<
        MarketingCheckoutTelemetry,
        "result_code" | "response_status_code" | "marketing_request_id"
      >,
      outcome: "success" | "error" | "aborted",
    ) => {
      // SDK failures cannot affect navigation or the Marketing request.
      return Promise.allSettled([
        (async () => {
          await Promise.resolve(
            recordClientTelemetry(
              measurement,
              {
                event_name: "marketing.checkout",
                checkout_source: event.checkoutSource,
                ...details,
              },
              outcome,
            ),
          );
        })(),
      ]);
    };

    await onRejection(
      async () => {
        signal.throwIfAborted();
        const token = await get(apiClientRuntime$).getToken(signal);
        signal.throwIfAborted();
        if (!token) {
          await record({ result_code: "token_missing" }, "error");
          return;
        }
        const client = initClient(marketingCheckoutContract, {
          baseUrl: resolveApiBaseForTarget("www"),
          api: (args) => {
            return trpcRestFetchApi(args, { parseResponseBody: false });
          },
        });
        phase = "request";
        const response = await client.record({
          headers: { authorization: `Bearer ${token}` },
          body: event,
          fetchOptions: { credentials: "include", keepalive: true, signal },
        });
        const requestId = response.headers.get("X-Marketing-Request-Id");
        // An acknowledgement does not imply consent or eligible attribution.
        await record(
          {
            result_code:
              response.status === 204 ? "acknowledged" : "http_error",
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
                : "request_error";
        await record(
          { result_code: result },
          result === "aborted" ? "aborted" : "error",
        );
      },
    );
  },
);

/** One event per redirect action, independent of legacy gtag session dedupe. */
export const recordMarketingCheckoutStart$ = command(
  (
    { get, set },
    checkoutSource: MarketingCheckoutRequest["checkoutSource"],
  ) => {
    const event: MarketingCheckoutRequest = {
      eventId: crypto.randomUUID(),
      occurredAt: nowDate().toISOString(),
      checkoutSource,
    };
    // The root owns this bounded request; Stripe navigation never awaits it.
    setDaemon(async (ownerSignal) => {
      const requestSignal = AbortSignal.any([
        ownerSignal,
        AbortSignal.timeout(10_000),
      ]);
      await bestEffort(
        set(sendMarketingCheckoutStart$, event, requestSignal),
        ownerSignal,
      );
    }, get(rootSignal$));
  },
);
