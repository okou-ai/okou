// Long-lived Node server entry point. Used by `pnpm dev` (tsx watch) and
// `pnpm start`. Distinct from `./index.ts`, which is the Vercel-function
// entry built by `@hono/vite-build/vercel`.

import "./instrument";

import { logger } from "./lib/log";
import { serveWithShutdown } from "./node-server";
import { createProductionApp } from "./production-bootstrap";

function main(): void {
  const L = logger("Server");
  const instanceAbortController = new AbortController();

  const app = createProductionApp(instanceAbortController.signal);

  serveWithShutdown(
    {
      fetch: app.fetch,
      port: 3001,
    },
    instanceAbortController,
    (info) => {
      L.debug(`Server is running on http://localhost:${info.port}`);
    },
  );
}

main();
