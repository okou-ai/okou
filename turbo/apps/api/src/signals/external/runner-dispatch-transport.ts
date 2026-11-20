import { AsyncLocalStorage } from "node:async_hooks";
import { singleton } from "../../lib/singleton";

export function runnerDispatchPath(runnerId: string, runId: string): string {
  return `/runners/${runnerId}/control/runs/${runId}/dispatch`;
}

export interface RunnerDispatchTiming {
  startedAt: number;
  sendCount: number;
  connection?: "first_use" | "reused";
  sendHeadersMs?: number;
}

export interface ReservedRunnerDispatch {
  readonly response: Promise<Response>;
  readonly timing: RunnerDispatchTiming;
}

export interface TakenRunnerDispatch extends ReservedRunnerDispatch {
  readonly clearDeadline: () => void;
}

export interface RunnerDispatchTransport {
  readonly reserve: (
    runId: string,
    url: string,
    start: (
      body: ReadableStream<Uint8Array>,
      signal: AbortSignal,
    ) => ReservedRunnerDispatch,
    signal: AbortSignal,
  ) => void;
  readonly take: (
    url: string,
    body: string,
    startedAt: number,
    signal: AbortSignal,
  ) => TakenRunnerDispatch | undefined;
}

// Only Vercel installs this context.
const transportContext = singleton(() => {
  return new AsyncLocalStorage<RunnerDispatchTransport>();
});

export function withRunnerDispatchTransport<T>(
  dispatchTransport: RunnerDispatchTransport,
  work: () => T,
): T {
  return transportContext().run(dispatchTransport, work);
}

export function currentRunnerDispatchTransport():
  RunnerDispatchTransport | undefined {
  return transportContext.peek()?.getStore();
}
