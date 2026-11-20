import { monotonicNow } from "./lib/time";
import type {
  RunnerDispatchTransport,
  TakenRunnerDispatch,
} from "./signals/external/runner-dispatch-transport";
import { detach, Mechanism, settleIncludingAbort } from "./signals/utils";

const MAX_PRECONNECTIONS = 4;
const PRECONNECTION_LIFETIME_MS = 1000;

type PreconnectionOutcome =
  "used" | "failed" | "expired" | "cancelled" | "instance_cap";

interface TransportOptions {
  readonly observe: (
    runId: string,
    outcome: PreconnectionOutcome,
    durationMs: number,
  ) => void;
}

type TakeReservation = (
  body: string,
  startedAt: number,
  signal: AbortSignal,
) => TakenRunnerDispatch | undefined;

export function createRunnerDispatchTransport({
  observe,
}: TransportOptions): RunnerDispatchTransport {
  const reservations = new Map<string, TakeReservation>();
  const reservedOrigins = new Set<string>();

  return {
    reserve(runId, url, start, signal) {
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
      const take: TakeReservation = (body, dispatchStartedAt, deadline) => {
        if (cancelled) {
          finish("failed");
          return undefined;
        }
        attempt.timing.startedAt = dispatchStartedAt;
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
          controller.enqueue(new TextEncoder().encode(body));
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
    take(url, body, startedAt, signal) {
      return reservations.get(url)?.(body, startedAt, signal);
    },
  };
}
