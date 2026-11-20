import { AsyncLocalStorage } from "node:async_hooks";
import { singleton } from "../../lib/singleton";

export type RunnerDispatchCohort = "control" | "preconnect";
export type PreconnectedSocketUse = "pending" | "ready";

export interface RunnerDispatchRequest {
  readonly method: "POST";
  readonly cache: "no-store";
  readonly redirect: "error";
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export interface RunnerDispatchResponse {
  readonly status: number;
  readonly headers: Pick<Headers, "get">;
  readonly body: Pick<ReadableStream, "cancel"> | null;
  json(): Promise<unknown>;
}

export interface RunnerDispatchExperiment {
  readonly reserve: (
    runId: string,
    origin: string,
    signal: AbortSignal,
  ) => void;
  readonly fetch: (
    cohort: RunnerDispatchCohort,
    url: string,
    options: RunnerDispatchRequest,
  ) => Promise<RunnerDispatchResponse>;
  readonly takeSocketUse: (socket: object) => PreconnectedSocketUse | undefined;
}

type ExperimentContext = RunnerDispatchExperiment & {
  readonly samplePercent: number;
};

// Only Vercel installs this context.
const experimentContext = singleton(() => {
  return new AsyncLocalStorage<ExperimentContext>();
});

export function withRunnerDispatchExperiment<T>(
  experiment: ExperimentContext,
  work: () => T,
): T {
  return experimentContext().run(experiment, work);
}

export function currentRunnerDispatchExperiment():
  ExperimentContext | undefined {
  return experimentContext.peek()?.getStore();
}

export function runnerDispatchCohort(
  runId: string,
  samplePercent: number,
): RunnerDispatchCohort | undefined {
  // Run IDs are random UUIDs. All attempts for one Run share the same arm.
  const bucket = Number.parseInt(runId.slice(0, 8), 16) % 100;
  if (bucket < samplePercent) {
    return "preconnect";
  }
  if (bucket < samplePercent * 2) {
    return "control";
  }
  return undefined;
}
