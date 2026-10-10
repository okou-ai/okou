import {
  initClient,
  type ApiFetcher,
  type ApiFetcherArgs,
  type AppRouter,
  type InitClientArgs,
  type InitClientReturn,
} from "@okouai/api-contracts/contracts/trpc-contract";

import { createAppWithRoutes } from "../app-factory-core";
import type { RouteEntry } from "../signals/route-entry";
import type { TestContext } from "./test-context";

interface TestAppWithRoutesOptions {
  readonly context: TestContext;
  readonly routes: readonly RouteEntry[];
  readonly signal?: AbortSignal;
}

interface SetupAppWithRoutesOptions extends TestAppWithRoutesOptions {
  readonly baseUrl?: string;
  readonly rethrowErrors?: boolean;
}

function parseResponseBody(response: Response): Promise<unknown> | undefined {
  if (response.status === 204 || response.status === 205) {
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  if (contentType.startsWith("text/")) {
    return response.text();
  }

  return response.blob();
}

async function requestApp(
  app: ReturnType<typeof createAppWithRoutes>,
  args: ApiFetcherArgs,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await app.request(args.path, {
    ...args.fetchOptions,
    method: args.method,
    headers: args.headers,
    body: args.body,
  });

  return {
    status: response.status,
    body: await parseResponseBody(response),
    headers: response.headers,
  };
}

function createAppFetcher({
  context,
  routes,
  signal,
  rethrowErrors,
}: SetupAppWithRoutesOptions): ApiFetcher {
  return (args) => {
    const app = createAppWithRoutes({
      signal: signal ?? context.signal,
      routes,
    });
    if (rethrowErrors) {
      app.onError((error) => {
        throw error;
      });
    }
    return requestApp(app, args);
  };
}

/**
 * Sends a request the ts-rest client cannot express, so a route test can cover
 * what a non-TypeScript caller sends: a body that the contract schema rejects.
 * Everything the typed client can express belongs on `setupAppWithRoutes`.
 */
export function setupRawAppRequestWithRoutes({
  context,
  routes,
  signal,
}: TestAppWithRoutesOptions) {
  return async (
    path: string,
    init: RequestInit,
  ): Promise<{ readonly status: number; readonly body: unknown }> => {
    const app = createAppWithRoutes({
      signal: signal ?? context.signal,
      routes,
    });
    const response = await app.request(path, init);
    return { status: response.status, body: await parseResponseBody(response) };
  };
}

export function setupAppWithRoutes({
  baseUrl = "http://api.test",
  context,
  routes,
  signal,
  rethrowErrors,
}: SetupAppWithRoutesOptions) {
  const app = createAppFetcher({
    context,
    routes,
    signal,
    rethrowErrors,
  });

  return <TContract extends AppRouter>(
    contract: TContract,
  ): InitClientReturn<TContract, InitClientArgs> => {
    return initClient(contract, {
      baseUrl,
      jsonQuery: false,
      throwOnUnknownStatus: true,
      validateResponse: true,
      api: app,
    });
  };
}
