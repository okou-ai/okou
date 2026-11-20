import { AsyncLocalStorage } from "node:async_hooks";
import { singleton } from "../../lib/singleton";

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

export interface RunnerDispatchTransport {
  readonly reserve: (
    runId: string,
    origin: string,
    signal: AbortSignal,
  ) => void;
  readonly fetch: (
    url: string,
    options: RunnerDispatchRequest,
  ) => Promise<RunnerDispatchResponse>;
  readonly takeSocketUse: (socket: object) => PreconnectedSocketUse | undefined;
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
