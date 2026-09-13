/** Bounded, content-free preparation observations; never provider ownership. */
export type PiPreparationPhase =
  | "launch"
  | "launch_resume"
  | "launch_memory"
  | "launch_manifest_sign"
  | "launch_session_sign"
  | "launch_identity"
  | "resource_snapshot"
  | "credentials_route"
  | "h0_load"
  | "h0_validate_materialize"
  | "runtime_initialize"
  | "history"
  | "resources_prompt"
  | "model_runtime"
  | "session_services"
  | "resource_loader"
  | "session_create"
  | "session_finalize"
  | "compaction_preflight"
  | "model_context"
  | "provider_boundary";

export interface PiPreparationObservation {
  readonly phase: PiPreparationPhase;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly outcome: "success" | "error" | "cancelled";
}

export type PiPreparationObserver = (
  observation: PiPreparationObservation,
) => void;

/** Observation cannot reject work, extend its lifetime, or change its error. */
export function startPiPreparationObservation(
  observer: PiPreparationObserver | undefined,
  phase: PiPreparationPhase,
  signal?: AbortSignal,
): (outcome: PiPreparationObservation["outcome"]) => void {
  const startedAt = Date.now();
  const started = performance.now();
  return (outcome) => {
    const durationMs = performance.now() - started;
    const finishedAt = Date.now();
    try {
      observer?.({
        phase,
        startedAt,
        finishedAt,
        durationMs,
        outcome: signal?.aborted ? "cancelled" : outcome,
      });
    } catch {
      // The caller owns best-effort telemetry; it cannot own model execution.
    }
  };
}

export async function measurePiPreparation<T>(
  observer: PiPreparationObserver | undefined,
  phase: PiPreparationPhase,
  operation: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const finish = startPiPreparationObservation(observer, phase, signal);
  let outcome: "success" | "error" = "error";
  try {
    const result = await operation();
    outcome = "success";
    return result;
  } finally {
    finish(outcome);
  }
}

export function measurePiPreparationSync<T>(
  observer: PiPreparationObserver | undefined,
  phase: PiPreparationPhase,
  operation: () => T,
  signal?: AbortSignal,
): T {
  const finish = startPiPreparationObservation(observer, phase, signal);
  let outcome: "success" | "error" = "error";
  try {
    const result = operation();
    outcome = "success";
    return result;
  } finally {
    finish(outcome);
  }
}
