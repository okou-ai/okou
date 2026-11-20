import app from "./index";
import { env, optionalEnv } from "./lib/env";
import { singleton } from "./lib/singleton";
import { createRunnerDispatchPreview } from "./runner-dispatch-preview.node";
import { withRunnerDispatchPreview } from "./signals/external/runner-dispatch-preview";
import { recordSandboxOperation } from "./signals/external/sandbox-op-log";
import { safeSync } from "./signals/utils";

const runnerDispatchPreview = singleton(() => {
  if (
    env("ENV") !== "preview" ||
    !/^pr-\d+$/.test(optionalEnv("OKOU_PREVIEW_JOB_REF") ?? "")
  ) {
    return undefined;
  }
  return createRunnerDispatchPreview({
    observe(runId, outcome, durationMs) {
      safeSync(() => {
        recordSandboxOperation({
          sandboxType: "runner",
          actionType: "api_dispatch_runner_preconnect",
          runId,
          durationMs,
          success: outcome === "ready" || outcome === "pending",
          dimensions: { preconnect_outcome: outcome },
        });
      });
    },
  });
});

const fetch: typeof app.fetch = (...args) => {
  const preview = runnerDispatchPreview();
  return preview
    ? withRunnerDispatchPreview(preview, () => {
        return app.fetch(...args);
      })
    : app.fetch(...args);
};

export default { fetch };
