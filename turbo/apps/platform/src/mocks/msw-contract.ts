/**
 * Contract-driven MSW helper.
 *
 * Wraps an MSW handler around a typed contract route so that the path,
 * method, path params, query params, request body, and response shape are
 * all derived from the contract itself. Returning a body that doesn't match
 * the contract's declared response schema for the given status becomes a
 * TypeScript error at the call site.
 * Handlers can add response headers while retaining those contract checks.
 *
 * Scope note: introduced as the foundation helper for #9707. Phase 0 adds
 * typed `params`/`query`/`body` to the handler context on top of the Phase
 * pilot (path + method + response). Ably event orchestration and multipart
 * bodies are still out of scope.
 */
import type {
  AppRoute,
  AppRouteMutation,
  ServerInferRequest,
  ServerInferResponseBody,
  ServerInferResponses,
} from "@okouai/api-contracts/contracts/trpc-contract";
import { http, HttpResponse, type HttpHandler, type PathParams } from "msw";
import { delay } from "signal-timers";
import { createDeferredPromise } from "../signals/utils.ts";

export interface SignalContextLike {
  readonly signal: AbortSignal;
}

type AnyResponse<R extends AppRoute> = ServerInferResponses<R> & {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: HeadersInit;
};

type Respond<R extends AppRoute> = <
  Status extends keyof R["responses"] & number,
>(
  ...args: ServerInferResponseBody<R, Status> extends undefined
    ? [status: Status]
    : [status: Status, body: ServerInferResponseBody<R, Status>]
) => AnyResponse<R>;

type InferredRequest<R extends AppRoute> = ServerInferRequest<R>;

type InferParams<R extends AppRoute> = "params" extends keyof InferredRequest<R>
  ? InferredRequest<R>["params"]
  : PathParams;

type InferQuery<R extends AppRoute> = "query" extends keyof InferredRequest<R>
  ? InferredRequest<R>["query"]
  : Record<string, string>;

type InferBody<R extends AppRoute> = R extends AppRouteMutation
  ? "body" extends keyof InferredRequest<R>
    ? InferredRequest<R>["body"]
    : undefined
  : undefined;

function getAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

async function withSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw getAbortReason(signal);
  }
  const aborted = createDeferredPromise<never>(signal);
  try {
    return await Promise.race([promise, aborted.promise]);
  } finally {
    if (!aborted.settled()) {
      aborted.reject(getAbortReason(signal));
    }
  }
}

function delayWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return delay(ms, { signal });
}

function neverWithSignal(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(getAbortReason(signal));
  }
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        reject(getAbortReason(signal));
      },
      { once: true },
    );
  });
}

export type MockHandler<R extends AppRoute> = (ctx: {
  params: InferParams<R>;
  query: InferQuery<R>;
  body: InferBody<R>;
  request: Request;
  signal: AbortSignal;
  withSignal: <T>(promise: Promise<T>) => Promise<T>;
  delay: (ms: number) => Promise<void>;
  deferred: <T>() => ReturnType<typeof createDeferredPromise<T>>;
  never: () => Promise<never>;
  respond: Respond<R>;
}) => AnyResponse<R> | Promise<AnyResponse<R>>;

const methodMap = {
  GET: http.get,
  POST: http.post,
  PUT: http.put,
  PATCH: http.patch,
  DELETE: http.delete,
} as const;

function routePattern(route: AppRoute): string | RegExp {
  if (route.path === "/api/chat-threads/:id") {
    // Keep thread detail mocks from swallowing static sibling routes while
    // still accepting the descriptive non-UUID thread ids used by UI tests.
    return /\/api\/chat-threads\/(?!snapshot$|events$)([^/]+)$/;
  }
  return `*${route.path}`;
}

function routeParamsForRequest<R extends AppRoute>(
  route: R,
  params: PathParams,
  url: URL,
): InferParams<R> {
  if (route.path === "/api/chat-threads/:id") {
    return {
      ...params,
      id: url.pathname.split("/").pop() ?? "",
    } as InferParams<R>;
  }
  return params as InferParams<R>;
}

function createSignal(
  requestSignal: AbortSignal,
  context?: SignalContextLike,
): AbortSignal {
  return context
    ? AbortSignal.any([requestSignal, context.signal])
    : requestSignal;
}

function createHelpers(signal: AbortSignal) {
  return {
    signal,
    withSignal: <T>(promise: Promise<T>) => {
      return withSignal(promise, signal);
    },
    delay: (ms: number) => {
      return delayWithSignal(ms, signal);
    },
    deferred: <T>() => {
      return createDeferredPromise<T>(signal);
    },
    never: () => {
      return neverWithSignal(signal);
    },
  };
}

function createBoundMockApi(context?: SignalContextLike) {
  return function mockApiForContext<R extends AppRoute>(
    route: R,
    handler: MockHandler<R>,
  ): HttpHandler {
    const register = methodMap[route.method];
    const pattern = routePattern(route);
    const respond: Respond<R> = (...args) => {
      const [status, body] = args;
      return { status, body } as AnyResponse<R>;
    };
    return register(pattern, async ({ params, request }) => {
      const signal = createSignal(request.signal, context);
      const helpers = createHelpers(signal);
      const url = new URL(request.url);
      const routeParams = routeParamsForRequest(route, params, url);
      const rawQuery = Object.fromEntries(url.searchParams.entries());
      const querySchema = route.query as
        | { safeParse: (v: unknown) => { success: boolean; data?: unknown } }
        | undefined;
      const parsed =
        querySchema && typeof querySchema.safeParse === "function"
          ? querySchema.safeParse(rawQuery)
          : undefined;
      const query = (parsed?.success ? parsed.data : rawQuery) as InferQuery<R>;

      let body = undefined as InferBody<R>;
      if (route.method !== "GET") {
        const text = await withSignal(request.clone().text(), signal);
        if (text.length > 0) {
          body = JSON.parse(text) as InferBody<R>;
        }
      }

      const result = await withSignal(
        Promise.resolve(
          handler({
            params: routeParams,
            query,
            body,
            request,
            respond,
            ...helpers,
          }),
        ),
        signal,
      );
      const responseInit = { status: result.status, headers: result.headers };
      if (result.body === null || result.body === undefined) {
        return new HttpResponse(null, responseInit);
      }
      return HttpResponse.json(result.body, responseInit);
    });
  };
}

export function mockApi<R extends AppRoute>(
  route: R,
  handler: MockHandler<R>,
): HttpHandler {
  return createBoundMockApi()(route, handler);
}

export const createMockApi = createBoundMockApi;

type HttpResolverArgs = Parameters<Parameters<typeof http.get>[1]>[0];
type HttpResolverResult = ReturnType<Parameters<typeof http.get>[1]>;
export type HttpResolverWithContext = (
  args: HttpResolverArgs & ReturnType<typeof createHelpers>,
) => HttpResolverResult;

function createBoundMockHttp(context: SignalContextLike) {
  function wrap(
    register: typeof http.get,
    path: Parameters<typeof http.get>[0],
    resolver: HttpResolverWithContext,
  ) {
    return register(path, (args) => {
      return resolver({
        ...args,
        ...createHelpers(createSignal(args.request.signal, context)),
      });
    });
  }

  return {
    get: (
      path: Parameters<typeof http.get>[0],
      resolver: HttpResolverWithContext,
    ) => {
      return wrap(http.get, path, resolver);
    },
    post: (
      path: Parameters<typeof http.post>[0],
      resolver: HttpResolverWithContext,
    ) => {
      return wrap(http.post, path, resolver);
    },
    put: (
      path: Parameters<typeof http.put>[0],
      resolver: HttpResolverWithContext,
    ) => {
      return wrap(http.put, path, resolver);
    },
    patch: (
      path: Parameters<typeof http.patch>[0],
      resolver: HttpResolverWithContext,
    ) => {
      return wrap(http.patch, path, resolver);
    },
    delete: (
      path: Parameters<typeof http.delete>[0],
      resolver: HttpResolverWithContext,
    ) => {
      return wrap(http.delete, path, resolver);
    },
  };
}

export const createMockHttp = createBoundMockHttp;
