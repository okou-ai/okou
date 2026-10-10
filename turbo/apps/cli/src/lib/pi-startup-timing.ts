import fs from "node:fs";
import { performance } from "node:perf_hooks";
import type {
  PiPreparationObservation,
  PiPreparationPhase,
} from "@okouai/pi-agent-runtime/node";

export const PI_PREPARATION_TIMING_ENV = "OKOU_PI_PREPARATION_TIMING";

let instrumentFinishedAt: number | undefined;

const ENTRY_PHASES: readonly PiPreparationPhase[] = [
  "cli_node_bootstrap",
  "cli_initial_imports",
  "cli_instrument",
  "cli_entry_imports",
  "cli_proxy",
  "cli_command_import",
];

function enabled(phase: PiPreparationPhase): boolean {
  return (
    process.env[PI_PREPARATION_TIMING_ENV] === "1" &&
    Boolean(process.env.OKOU_RUN_ID) &&
    (!ENTRY_PHASES.includes(phase) ||
      process.argv.includes("__main_loop__") ||
      process.argv.includes("__agent-loop"))
  );
}

/** A bounded diagnostic write must never trigger the CLI's stderr error handler. */
export function writePiPreparationTiming(
  runId: string,
  observation: PiPreparationObservation,
): void {
  try {
    fs.writeSync(
      2,
      `${JSON.stringify({
        type: "pi_preparation_timing",
        runId,
        ...observation,
      })}\n`,
    );
  } catch {
    // EPIPE/closed diagnostic sinks cannot change startup or its original error.
  }
}

function record(
  phase: PiPreparationPhase,
  started: number,
  finished: number,
  outcome: PiPreparationObservation["outcome"],
): void {
  if (!enabled(phase) || !Number.isFinite(started) || finished < started)
    return;
  writePiPreparationTiming(process.env.OKOU_RUN_ID ?? "", {
    phase,
    startedAt: performance.timeOrigin + started,
    finishedAt: performance.timeOrigin + finished,
    durationMs: finished - started,
    outcome,
  });
}

/** Observe the original ESM graph without replacing it with a bootstrap loader. */
export function observePiCliBootstrap(): void {
  const entered = performance.now();
  const bootstrapped = performance.nodeTiming.bootstrapComplete;
  if (bootstrapped < 0 || bootstrapped > entered) return;
  record("cli_node_bootstrap", 0, bootstrapped, "success");
  record("cli_initial_imports", bootstrapped, entered, "success");
}

export function startPiCliObservation(
  phase: PiPreparationPhase,
): (outcome: PiPreparationObservation["outcome"]) => void {
  const started = performance.now();
  return (outcome) => {
    const finished = performance.now();
    if (phase === "cli_instrument") instrumentFinishedAt = finished;
    record(phase, started, finished, outcome);
  };
}

export function observePiCliEntryImports(): void {
  if (instrumentFinishedAt !== undefined) {
    record(
      "cli_entry_imports",
      instrumentFinishedAt,
      performance.now(),
      "success",
    );
  }
}
