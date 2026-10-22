import { AsyncLocalStorage } from "node:async_hooks";

import type { ApiDb } from "./db-types";
import { singleton } from "./singleton";

/** Only Workers supply this context; Node/Vercel retain their existing owners. */
export interface RequestRuntime {
  readonly database: () => ApiDb;
  readonly waitUntil: (work: Promise<unknown>) => void;
  readonly traceQuery: (
    name: string,
    sql: string | undefined,
    execute: () => Promise<unknown>,
  ) => Promise<unknown>;
  readonly observeHttp: (method: string, route: string, status: number) => void;
}

const requestRuntime = singleton(() => {
  return new AsyncLocalStorage<RequestRuntime>();
});

export function currentRequestRuntime(): RequestRuntime | undefined {
  return requestRuntime().getStore();
}

export function withRequestRuntime<T>(
  runtime: RequestRuntime,
  work: () => T,
): T {
  return requestRuntime().run(runtime, work);
}
