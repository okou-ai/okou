import { once } from "node:events";
import {
  IncomingMessage,
  validateHeaderValue,
  type ClientRequest,
} from "node:http";
import { Agent, request, type RequestOptions } from "node:https";
import { json } from "node:stream/consumers";
import type { ConnectionOptions } from "node:tls";
import { monotonicNow } from "./lib/time";
import type {
  PreconnectedSocketUse,
  RunnerDispatchResponse,
  RunnerDispatchTransport,
} from "./signals/external/runner-dispatch-transport";

const MAX_PRECONNECTIONS = 4;
const PRECONNECTION_LIFETIME_MS = 1000;

type PreconnectionOutcome =
  PreconnectedSocketUse | "failed" | "expired" | "cancelled" | "instance_cap";

interface TransportOptions {
  readonly ca?: ConnectionOptions["ca"];
  readonly observe: (
    runId: string,
    outcome: PreconnectionOutcome,
    durationMs: number,
  ) => void;
}

interface Reservation {
  readonly take: () => PreconnectedSocketUse | undefined;
  readonly request: ClientRequest;
}

function toDispatchResponse(incoming: IncomingMessage): RunnerDispatchResponse {
  return {
    status: incoming.statusCode ?? 0,
    headers: {
      get(name) {
        const value = incoming.headers[name.toLowerCase()];
        return Array.isArray(value) ? value.join(", ") : (value ?? null);
      },
    },
    body: {
      cancel() {
        incoming.destroy();
        return Promise.resolve();
      },
    },
    json() {
      return json(incoming);
    },
  };
}

function guardResponseErrors(incoming: IncomingMessage): void {
  // Abort can destroy the response before the caller starts reading it.
  incoming.on("error", () => {
    incoming.destroy();
  });
}

export function createRunnerDispatchTransport({
  ca,
  observe,
}: TransportOptions): RunnerDispatchTransport {
  const agent = new Agent({ keepAlive: true, ca });
  const reservations = new Map<string, Reservation>();
  const reservedOrigins = new Set<string>();

  function reserve(runId: string, url: string, signal: AbortSignal): void {
    const target = new URL(url);
    const origin = target.origin;
    const socketOptions: RequestOptions = {
      host: target.hostname,
      port: target.port ? Number(target.port) : 443,
      ca,
    };
    const agentKey = agent.getName(socketOptions);
    if (
      signal.aborted ||
      reservedOrigins.has(origin) ||
      agent.freeSockets[agentKey]?.length
    ) {
      return;
    }
    if (reservations.size >= MAX_PRECONNECTIONS) {
      observe(runId, "instance_cap", 0);
      return;
    }

    // Node assigns a socket before end() sends any HTTP bytes.
    const startedAt = monotonicNow();
    const pending = request(target, { agent, method: "POST" });
    const expiry = AbortSignal.timeout(PRECONNECTION_LIFETIME_MS);
    let ready = false;

    const finish = (outcome: PreconnectionOutcome) => {
      if (reservations.get(url) !== reservation) {
        return;
      }
      reservations.delete(url);
      reservedOrigins.delete(origin);
      signal.removeEventListener("abort", onAbort);
      expiry.removeEventListener("abort", onExpiry);
      if (outcome === "ready" || outcome === "pending") {
        pending.off("error", onFailure);
        pending.off("close", onFailure);
      } else {
        pending.destroy();
      }
      observe(runId, outcome, monotonicNow() - startedAt);
    };

    const onAbort = () => {
      finish("cancelled");
    };
    const onExpiry = () => {
      finish("expired");
    };
    const onFailure = () => {
      finish("failed");
    };
    const reservation: Reservation = {
      request: pending,
      take() {
        if (pending.destroyed) {
          finish("failed");
          return undefined;
        }
        const use = ready ? "ready" : "pending";
        finish(use);
        return use;
      },
    };
    reservations.set(url, reservation);
    reservedOrigins.add(origin);
    pending.once("socket", (socket) => {
      if (pending.reusedSocket) {
        ready = true;
        return;
      }
      socket.once("secureConnect", () => {
        ready = true;
      });
    });
    pending.once("error", onFailure);
    pending.once("close", onFailure);
    signal.addEventListener("abort", onAbort, { once: true });
    expiry.addEventListener("abort", onExpiry, { once: true });
  }

  return {
    reserve,
    async fetch(url, options, onSocketUse, signal) {
      signal.throwIfAborted();
      for (const [name, value] of Object.entries(options.headers)) {
        validateHeaderValue(name, value);
      }
      const reservation = reservations.get(url);
      const preconnection = reservation?.take();
      const outbound =
        reservation && preconnection
          ? reservation.request
          : request(url, { agent, method: options.method });

      const response = once(outbound, "response", { signal });
      const onAbort = () => {
        outbound.destroy();
      };
      outbound.on("error", onAbort);
      outbound.once("close", () => {
        signal.removeEventListener("abort", onAbort);
      });
      signal.addEventListener("abort", onAbort, { once: true });
      outbound.once("finish", () => {
        onSocketUse?.(
          outbound.reusedSocket ? "reused" : "first_use",
          preconnection,
        );
      });
      outbound.once("response", guardResponseErrors);
      for (const [name, value] of Object.entries(options.headers)) {
        outbound.setHeader(name, value);
      }
      outbound.setHeader("content-length", Buffer.byteLength(options.body));
      outbound.end(options.body);
      const [incoming]: unknown[] = await response;
      if (!(incoming instanceof IncomingMessage)) {
        throw new Error("Expected a Runner HTTP response");
      }
      return toDispatchResponse(incoming);
    },
  };
}
