import "./instrument";
import { env, optionalEnv } from "./lib/env";
import { normalizeBuildCommitSha } from "./lib/build-info";
import { singleton } from "./lib/singleton";
import { createRunnerDispatchExperiment } from "./runner-dispatch-experiment.node";
import { withRunnerDispatchExperiment } from "./signals/external/runner-dispatch-experiment";
import { recordSandboxOperation } from "./signals/external/sandbox-op-log";
import { safeSync } from "./signals/utils";
import { createProductionApp } from "./production-bootstrap";

// Vercel function entry point built by `@hono/vite-build/vercel` (see
// `vite.config.ts`). Distinct from `./server.ts`, which is the long-lived
// Node entry used by `pnpm dev` / `pnpm start`. Vercel can't host the
// realtime relay WebSocket — Epic #12128 pivoted to Plan D (browser-direct
// to OpenAI), and the WS scaffolding has since been retired.
//
// (no-op API release marker refreshed for production delivery at 2026-11-06T21:06:45+08:00)

const app = (() => {
  const instanceAbortController = new AbortController();

  process.once("SIGTERM", () => {
    const error = new Error("Aborted due to terminated function instance");
    error.name = "AbortError";
    instanceAbortController.abort(error);
  });

  return createProductionApp(instanceAbortController.signal);
})();

const runnerDispatchExperiment = singleton(() => {
  const environment = env("ENV");
  const samplePercent =
    environment === "production"
      ? 100
      : environment === "preview" &&
          /^pr-\d+$/.test(optionalEnv("OKOU_PREVIEW_JOB_REF") ?? "")
        ? 50
        : 0;
  if (
    samplePercent === 0 ||
    optionalEnv("RUNNER_DISPATCH_PRECONNECT_DISABLED") === "1"
  ) {
    return undefined;
  }
  return {
    samplePercent,
    ...createRunnerDispatchExperiment({
      observe(runId, outcome, durationMs) {
        safeSync(() => {
          recordSandboxOperation({
            sandboxType: "runner",
            actionType: "api_dispatch_runner_preconnect",
            runId,
            durationMs,
            success: outcome === "ready" || outcome === "pending",
            dimensions: {
              preconnect_outcome: outcome,
              api_commit_sha:
                normalizeBuildCommitSha(env("GIT_COMMIT_SHA")) ?? undefined,
            },
          });
        });
      },
    }),
  };
});

const fetch: typeof app.fetch = (...args) => {
  const experiment = runnerDispatchExperiment();
  return experiment
    ? withRunnerDispatchExperiment(experiment, () => {
        return app.fetch(...args);
      })
    : app.fetch(...args);
};

export default { fetch };
