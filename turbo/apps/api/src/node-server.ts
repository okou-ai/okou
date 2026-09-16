import type { AddressInfo } from "node:net";

import { serve, type ServerType } from "@hono/node-server";

const SHUTDOWN_TIMEOUT_MS = 4000;

// Owns the lifetime of the standalone Node process, not a Vercel invocation.
export function serveWithShutdown(
  options: Pick<Parameters<typeof serve>[0], "fetch" | "port" | "hostname">,
  instanceAbortController: AbortController,
  listeningListener?: (info: AddressInfo) => void,
): ServerType {
  let shuttingDown = false;
  const server = serve(
    {
      ...options,
      fetch: (request, bindings) => {
        if (shuttingDown) {
          return new Response("Service unavailable", {
            status: 503,
            headers: { Connection: "close", "Cache-Control": "no-store" },
          });
        }
        return options.fetch(request, bindings);
      },
    },
    listeningListener,
  );

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    // This unreferenced deadline allows early natural exit, but remains in
    // force after HTTP closes: background work can still hold process handles.
    AbortSignal.timeout(SHUTDOWN_TIMEOUT_MS).addEventListener("abort", () => {
      process.stderr.write("API server shutdown exceeded four seconds\n");
      process.exit(1);
    });

    server.close();
    const error = new Error("Aborted due to terminated function instance");
    error.name = "AbortError";
    instanceAbortController.abort(error);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return server;
}
