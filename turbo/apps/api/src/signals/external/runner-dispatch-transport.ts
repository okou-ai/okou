import { AsyncLocalStorage } from "node:async_hooks";
import { singleton } from "../../lib/singleton";

export function runnerDispatchPath(runnerId: string, runId: string): string {
  return `/runners/${runnerId}/control/runs/${runId}/dispatch`;
}

export interface RunnerDispatchTiming {
  readonly preconnectStartedAt?: number;
  sendCount: number;
  connection?: "first_use" | "reused";
  sentHeadersAt?: number;
}

export function runnerDispatchHeaderTimings(
  timing: RunnerDispatchTiming,
  dispatchStartedAt: number,
) {
  const { sentHeadersAt, preconnectStartedAt } = timing;
  if (timing.sendCount !== 1 || sentHeadersAt === undefined) {
    return {};
  }
  // A reserved request can emit headers before the body handoff. Keep that
  // observation on the preconnection clock.
  return {
    api_preconnect_send_headers_ms:
      preconnectStartedAt === undefined
        ? undefined
        : sentHeadersAt - preconnectStartedAt,
    api_send_headers_ms:
      sentHeadersAt >= dispatchStartedAt
        ? sentHeadersAt - dispatchStartedAt
        : undefined,
  };
}

export interface ReservedRunnerDispatch {
  readonly response: Promise<Response>;
  readonly timing: RunnerDispatchTiming;
}

export interface TakenRunnerDispatch extends ReservedRunnerDispatch {
  readonly clearDeadline: () => void;
}

export type RunnerDispatchEncoding = "identity" | "gzip";

export interface RunnerDispatchTransport {
  readonly request: (url: string, options: RequestInit) => Promise<Response>;
  readonly poolStats?: (origin: string) => {
    readonly connected: number;
    readonly pending: number;
  };
  readonly reserve: (
    runId: string,
    url: string,
    start: (
      body: ReadableStream<Uint8Array>,
      signal: AbortSignal,
    ) => ReservedRunnerDispatch,
    signal: AbortSignal,
    encoding?: RunnerDispatchEncoding,
  ) => void;
  readonly take: (
    url: string,
    body: string | Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
    encoding?: RunnerDispatchEncoding,
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
