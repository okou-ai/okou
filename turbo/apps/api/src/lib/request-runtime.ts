import { AsyncLocalStorage } from "node:async_hooks";

import type { ApiDb } from "./db-types";
import { singleton } from "./singleton";

/** Shared attributes supported by both native Workers and Node query spans. */
export interface RequestQuerySpan {
  readonly setAttributes: (
    attributes: Readonly<Record<string, string | number>>,
  ) => void;
}

/** Only Workers supply this context; Node/Vercel retain their existing owners. */
export interface RequestRuntime {
  readonly nativeTelemetry: boolean;
  /** The host owns the client-certificate private key and TLS handshake. */
  readonly gcpMtls?: {
    readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  };
  readonly database: () => ApiDb;
  readonly waitUntil: (work: Promise<unknown>) => void;
  readonly traceQuery: (
    name: string,
    sql: string | undefined,
    execute: (span: RequestQuerySpan) => Promise<unknown>,
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
