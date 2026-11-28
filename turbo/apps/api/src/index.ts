import "./instrument";
import { env } from "./lib/env";
import { normalizeBuildCommitSha } from "./lib/build-info";
import { singleton } from "./lib/singleton";
import { createRunnerDispatchPool } from "./runner-dispatch-pool.node";
import { createRunnerDispatchTransport } from "./runner-dispatch-transport.node";
import { withRunnerDispatchTransport } from "./signals/external/runner-dispatch-transport";
import { recordSandboxOperation } from "./signals/external/sandbox-op-log";
import { safeSync } from "./signals/utils";
import { createProductionApp } from "./production-bootstrap";

// Vercel function entry point built by `@hono/vite-build/vercel` (see
// `vite.config.ts`). Distinct from `./server.ts`, which is the long-lived
// Node entry used by `pnpm dev` / `pnpm start`. Vercel can't host the
// realtime relay WebSocket — Epic #12128 pivoted to Plan D (browser-direct
// to OpenAI), and the WS scaffolding has since been retired.
//
// (no-op API release marker refreshed for HAR preview 2026-11-28)

const app = (() => {
  const instanceAbortController = new AbortController();

  process.once("SIGTERM", () => {
    const error = new Error("Aborted due to terminated function instance");
    error.name = "AbortError";
    instanceAbortController.abort(error);
  });

  return createProductionApp(instanceAbortController.signal);
})();

const runnerDispatchTransport = singleton(() => {
  return createRunnerDispatchTransport({
    ...createRunnerDispatchPool(),
    observe(runId, outcome, durationMs) {
      safeSync(() => {
        recordSandboxOperation({
          sandboxType: "runner",
          actionType: "api_dispatch_runner_preconnect",
          runId,
          durationMs,
          success: outcome === "used",
          dimensions: {
            preconnect_outcome: outcome,
            api_commit_sha:
              normalizeBuildCommitSha(env("GIT_COMMIT_SHA")) ?? undefined,
          },
        });
      });
    },
  });
});

const fetch: typeof app.fetch = (...args) => {
  return withRunnerDispatchTransport(runnerDispatchTransport(), () => {
    return app.fetch(...args);
  });
};

export default { fetch };
