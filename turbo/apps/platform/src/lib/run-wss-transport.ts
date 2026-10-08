import { runnerWssTicketsContract } from "@okouai/api-contracts/contracts/runner-wss-tickets";
import {
  RunWssTransport,
  type RunWssTransportOptions,
} from "@okouai/core/run-wss-transport";

import type { ApiClientFactory } from "../signals/api-client.ts";

/** Bind the inert transport to the existing authenticated API client. */
export function createBrowserRunWssTransport(
  runId: string,
  createClient: ApiClientFactory,
  options: RunWssTransportOptions,
): RunWssTransport {
  const client = createClient(runnerWssTicketsContract);
  return new RunWssTransport(
    runId,
    async (id, signal) => {
      const result = await client.bootstrap({
        params: { runId: id },
        fetchOptions: { signal },
      });
      if (result.status !== 200) {
        return {
          kind:
            result.status >= 400 && result.status < 500
              ? ("terminal" as const)
              : ("transient" as const),
        };
      }
      return { kind: "success" as const, body: result.body };
    },
    options,
  );
}
