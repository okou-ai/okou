import { Agent, fetch } from "undici";
import type { RunnerDispatchRequest } from "./signals/external/runner-dispatch-transport";

const IDLE_MS = 30_000;

export function createRunnerDispatchPool() {
  const dispatcher = new Agent({
    allowH2: false,
    connections: 4,
    pipelining: 1,
    keepAliveTimeout: IDLE_MS,
    keepAliveMaxTimeout: IDLE_MS,
  });

  return {
    request(url: string, options: RunnerDispatchRequest) {
      return fetch(url, { ...options, dispatcher });
    },
    poolStats(origin: string) {
      const stats = dispatcher.stats[origin];
      return {
        connected: Number(stats?.connected ?? 0),
        pending: stats?.pending ?? 0,
      };
    },
    destroy() {
      return dispatcher.destroy();
    },
  };
}
