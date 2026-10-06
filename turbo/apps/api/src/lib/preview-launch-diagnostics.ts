import { performance } from "node:perf_hooks";
import { trace } from "@opentelemetry/api";
import { env } from "./env";
import { safeSync } from "../signals/utils";

type Phase = "plan" | "execute" | "validate";

export function previewLaunchDiagnostics() {
  if (env("ENV") !== "preview") {
    return undefined;
  }
  const startedAt = performance.now();
  let previous = startedAt;
  let completed = false;
  const span = trace
    .getTracer("vm0-api/launch-diagnostic")
    .startSpan("diag.launch.persistence");
  return {
    mark(phase: Phase): void {
      safeSync(() => {
        const current = performance.now();
        span.setAttribute(`diag.launch.${phase}_ms`, current - previous);
        span.setAttribute("diag.launch.last_completed_phase", phase);
        previous = current;
        completed = phase === "validate";
      });
    },
    end(): void {
      safeSync(() => {
        span.setAttribute("diag.launch.completed", completed);
        span.setAttribute(
          "diag.launch.total_ms",
          performance.now() - startedAt,
        );
        span.end();
      });
    },
  };
}
