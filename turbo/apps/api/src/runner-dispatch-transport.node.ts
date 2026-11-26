import { monotonicNow } from "./lib/time";
import type {
  RunnerDispatchEncoding,
  RunnerDispatchTransport,
  TakenRunnerDispatch,
} from "./signals/external/runner-dispatch-transport";
import { detach, Mechanism, settleIncludingAbort } from "./signals/utils";

const MAX_PRECONNECTIONS = 4;
const PRECONNECTION_LIFETIME_MS = 1000;

type PreconnectionOutcome =
  "used" | "failed" | "expired" | "cancelled" | "instance_cap";

interface TransportOptions {
  readonly request?: RunnerDispatchTransport["request"];
  readonly poolStats?: RunnerDispatchTransport["poolStats"];
  readonly observe: (
    runId: string,
    outcome: PreconnectionOutcome,
    durationMs: number,
  ) => void;
}

type TakeReservation = (
  body: string | Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
  encoding: RunnerDispatchEncoding,
) => TakenRunnerDispatch | undefined;

export function createRunnerDispatchTransport({
  observe,
  request = fetch,
  poolStats,
}: TransportOptions): RunnerDispatchTransport {
  const reservations = new Map<string, TakeReservation>();
  const reservedOrigins = new Set<string>();

  return {
    request,
    poolStats,
    reserve(runId, url, start, signal, encoding = "identity") {
      const origin = new URL(url).origin;
      if (signal.aborted || reservedOrigins.has(origin)) {
        return;
      }
      if (reservations.size >= MAX_PRECONNECTIONS) {
        observe(runId, "instance_cap", 0);
        return;
      }

      const startedAt = monotonicNow();
      const connection = new AbortController();
      const expiry = AbortSignal.timeout(PRECONNECTION_LIFETIME_MS);
      let streamController:
        ReadableStreamDefaultController<Uint8Array> | undefined;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          cancelled = true;
        },
      });
      if (!streamController) {
        throw new Error("Expected the Runner body stream to start immediately");
      }
      const controller = streamController;
      const attempt = start(stream, connection.signal);

      const finish = (outcome: PreconnectionOutcome) => {
        if (reservations.get(url) !== take) {
          return;
        }
        reservations.delete(url);
        reservedOrigins.delete(origin);
        signal.removeEventListener("abort", onAbort);
        expiry.removeEventListener("abort", onExpiry);
        if (outcome !== "used") {
          connection.abort();
          controller.error(connection.signal.reason);
        }
        observe(runId, outcome, monotonicNow() - startedAt);
      };

      const onAbort = () => {
        finish("cancelled");
      };
      const onExpiry = () => {
        finish("expired");
      };
      const take: TakeReservation = (body, deadline, bodyEncoding) => {
        if (bodyEncoding !== encoding) {
          finish("cancelled");
          return undefined;
        }
        if (cancelled) {
          finish("failed");
          return undefined;
        }
        finish("used");
        // Keep abort ownership until the response body is consumed as well.
        const abortDispatch = () => {
          connection.abort(deadline.reason);
          controller.error(deadline.reason);
        };
        deadline.addEventListener("abort", abortDispatch, { once: true });
        if (deadline.aborted) {
          abortDispatch();
        } else {
          controller.enqueue(
            typeof body === "string" ? new TextEncoder().encode(body) : body,
          );
          controller.close();
        }
        return {
          ...attempt,
          clearDeadline() {
            deadline.removeEventListener("abort", abortDispatch);
          },
        };
      };

      reservations.set(url, take);
      reservedOrigins.add(origin);
      signal.addEventListener("abort", onAbort, { once: true });
      expiry.addEventListener("abort", onExpiry, { once: true });
      // A failed speculative request can fall back before release. After
      // release the normal dispatch path owns its outcome and retries.
      detach(
        (async () => {
          await settleIncludingAbort(attempt.response);
          finish("failed");
        })(),
        Mechanism.BestEffortCleanup,
        "Runner dispatch preconnection cleanup",
      );
    },
    take(url, body, signal, encoding = "identity") {
      return reservations.get(url)?.(body, signal, encoding);
    },
  };
}
