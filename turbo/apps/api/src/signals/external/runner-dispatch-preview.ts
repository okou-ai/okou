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

export interface RunnerDispatchPreview {
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

// Only the Vercel entry installs this context. Shared dispatch can keep using
// the host's default fetch on Workers and outside PR Preview.
const previewContext = singleton(() => {
  return new AsyncLocalStorage<RunnerDispatchPreview>();
});

export function withRunnerDispatchPreview<T>(
  preview: RunnerDispatchPreview,
  work: () => T,
): T {
  return previewContext().run(preview, work);
}

export function currentRunnerDispatchPreview():
  RunnerDispatchPreview | undefined {
  return previewContext.peek()?.getStore();
}

export function runnerDispatchCohort(runId: string): RunnerDispatchCohort {
  // Run IDs are random UUIDs. All attempts for one Run share the same arm.
  return Number.parseInt(runId.slice(-1), 16) % 2 === 0
    ? "preconnect"
    : "control";
}
