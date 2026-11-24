import "./initialize-fetch.node.ts";
import { Agent } from "undici";

const IDLE_MS = 30_000;
type FetchDispatcher = NonNullable<RequestInit["dispatcher"]>;

export function createRunnerDispatchPool() {
  const dispatcher = new Agent({
    allowH2: false,
    // Open another socket immediately when all HTTP/1.1 sockets are busy.
    connections: null,
    pipelining: 1,
    keepAliveTimeout: IDLE_MS,
    keepAliveMaxTimeout: IDLE_MS,
  });
  // Native Fetch uses dispatch. Its bundled types also describe a different
  // version of Undici's compose API.
  const fetchDispatcher: Pick<FetchDispatcher, "dispatch"> = dispatcher;

  return {
    request(url: string, options: RequestInit) {
      return fetch(url, {
        ...options,
        dispatcher: fetchDispatcher as FetchDispatcher,
      });
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
