import { connect as connectTls, type ConnectionOptions } from "node:tls";
import { Agent, buildConnector, fetch } from "undici";
import { monotonicNow } from "./lib/time";
import type {
  PreconnectedSocketUse,
  RunnerDispatchTransport,
} from "./signals/external/runner-dispatch-transport";

const MAX_PRECONNECTIONS = 4;
const PRECONNECTION_LIFETIME_MS = 1000;

type Connector = ReturnType<typeof buildConnector>;
type Adoption = (
  options: Parameters<Connector>[0],
  callback: Parameters<Connector>[1],
) => boolean;
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

export function createRunnerDispatchTransport({
  ca,
  observe,
}: TransportOptions): RunnerDispatchTransport {
  const reservations = new Map<string, Adoption>();
  const socketUses = new WeakMap<object, PreconnectedSocketUse>();
  const open = buildConnector({ ca });
  const preconnect = new Agent({
    connect(options, callback) {
      const origin = `${options.protocol}//${options.host ?? options.hostname}`;
      if (!reservations.get(origin)?.(options, callback)) {
        open(options, callback);
      }
    },
  });

  function reserve(runId: string, origin: string, signal: AbortSignal): void {
    const stats = preconnect.stats[origin];
    if (
      signal.aborted ||
      reservations.has(origin) ||
      (stats && "free" in stats && stats.free > 0)
    ) {
      return;
    }
    if (reservations.size >= MAX_PRECONNECTIONS) {
      observe(runId, "instance_cap", 0);
      return;
    }
    const { hostname, port } = new URL(origin);
    const startedAt = monotonicNow();
    const socket = connectTls({
      host: hostname,
      servername: hostname,
      port: port ? Number(port) : 443,
      ALPNProtocols: ["http/1.1"],
      ca,
    });
    const lifetime = AbortSignal.any([
      signal,
      AbortSignal.timeout(PRECONNECTION_LIFETIME_MS),
    ]);
    let ready = false;
    let claimant:
      | {
          options: Parameters<Connector>[0];
          callback: Parameters<Connector>[1];
          use: PreconnectedSocketUse;
        }
      | undefined;

    const finish = (outcome: PreconnectionOutcome) => {
      if (reservations.get(origin) !== adopt) {
        return;
      }
      reservations.delete(origin);
      lifetime.removeEventListener("abort", onAbort);
      const used = outcome === "ready" || outcome === "pending";
      if (used && claimant) {
        socket.off("error", onFailure);
        socket.off("close", onFailure);
        socketUses.set(socket, outcome);
        claimant.callback(null, socket);
      } else {
        socket.destroy();
        if (claimant) {
          // No HTTP bytes were sent on the speculative connection.
          open(claimant.options, claimant.callback);
        }
      }
      observe(runId, outcome, monotonicNow() - startedAt);
    };

    const onAbort = () => {
      return finish(signal.aborted ? "cancelled" : "expired");
    };
    const onFailure = () => {
      return finish("failed");
    };
    const adopt: Adoption = (options, callback) => {
      if (claimant || socket.destroyed) {
        return false;
      }
      claimant = { options, callback, use: ready ? "ready" : "pending" };
      if (ready) {
        // Undici calls the connector from its resume loop. Delivering a ready
        // socket inline would re-enter the loop and lose its send wake-up.
        queueMicrotask(() => {
          finish(socket.destroyed ? "failed" : "ready");
        });
      }
      return true;
    };
    reservations.set(origin, adopt);
    socket.once("secureConnect", () => {
      ready = true;
      if (claimant) {
        finish(claimant.use);
      }
    });
    socket.once("error", onFailure);
    socket.once("close", onFailure);
    lifetime.addEventListener("abort", onAbort, { once: true });
  }

  return {
    reserve,
    fetch(url, options) {
      return fetch(url, {
        ...options,
        dispatcher: preconnect,
      });
    },
    takeSocketUse(socket) {
      const use = socketUses.get(socket);
      socketUses.delete(socket);
      return use;
    },
  };
}
