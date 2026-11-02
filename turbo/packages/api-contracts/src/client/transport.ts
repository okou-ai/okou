import type {
  ApiFetcherArgs,
  ApiFetcherResponse,
  ClientInferRequest,
  ClientInferResponses,
  ClientMethod,
  ClientResponseValidator,
  ClientRoute,
  ClientRouter,
  InitClientArgs,
  InitClientReturn,
} from "./types";

function appendQuery(url: URL, query: unknown): void {
  if (typeof query !== "object" || query === null) {
    return;
  }

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }

    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === undefined || item === null) {
        continue;
      }
      url.searchParams.append(key, String(item));
    }
  }
}

function applyPathParams(path: string, params: unknown): string {
  if (typeof params !== "object" || params === null) {
    return path;
  }

  return Object.entries(params).reduce((current, [key, value]) => {
    return current.replace(`:${key}`, encodeURIComponent(String(value)));
  }, path);
}

function isBodyInit(value: unknown): value is NonNullable<RequestInit["body"]> {
  return (
    typeof value === "string" ||
    value instanceof Blob ||
    value instanceof FormData ||
    value instanceof URLSearchParams ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}

function createRequestBody(body: unknown): {
  readonly body?: NonNullable<RequestInit["body"]>;
  readonly contentType?: string;
} {
  if (body === undefined) {
    return {};
  }

  if (isBodyInit(body)) {
    return { body };
  }

  return {
    body: JSON.stringify(body),
    contentType: "application/json",
  };
}

function mergeHeaders(
  config: Pick<InitClientArgs, "baseHeaders">,
  args: {
    readonly headers?: unknown;
    readonly extraHeaders?: Record<string, string>;
  },
  contentType?: string,
): Headers {
  const headers = new Headers(config.baseHeaders);
  if (args.headers && typeof args.headers === "object") {
    for (const [key, value] of Object.entries(args.headers)) {
      if (typeof value === "string") {
        headers.set(key, value);
      }
    }
  }
  for (const [key, value] of Object.entries(args.extraHeaders ?? {})) {
    headers.set(key, value);
  }
  if (contentType && !headers.has("content-type")) {
    headers.set("content-type", contentType);
  }
  return headers;
}

function parseResponseBody(response: Response): Promise<unknown> | undefined {
  if (
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304
  ) {
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

export async function trpcRestFetchApi(
  args: ApiFetcherArgs,
  options: { readonly parseResponseBody?: boolean } = {},
): Promise<ApiFetcherResponse> {
  const response = await fetch(args.path, {
    ...args.fetchOptions,
    method: args.method,
    headers: args.headers,
    body: args.body,
  });

  return {
    status: response.status,
    body:
      options.parseResponseBody === false
        ? undefined
        : await parseResponseBody(response),
    headers: response.headers,
  };
}

function responseStatusIsKnown(route: ClientRoute, status: number): boolean {
  return "statuses" in route
    ? Object.hasOwn(route.statuses, status)
    : Object.hasOwn(route.responses, status);
}

function createClientMethod<R extends ClientRoute>(
  route: R,
  config: InitClientArgs<R>,
  validateResponse?: ClientResponseValidator<R>,
): ClientMethod<R> {
  const callRoute = async (input?: ClientInferRequest<R>) => {
    const requestInput =
      typeof input === "object" && input !== null
        ? (input as {
            readonly params?: unknown;
            readonly query?: unknown;
            readonly body?: unknown;
            readonly headers?: unknown;
            readonly extraHeaders?: Record<string, string>;
            readonly fetchOptions?: RequestInit;
          })
        : {};
    const path = applyPathParams(route.path, requestInput.params);
    const url = new URL(path, config.baseUrl);
    appendQuery(url, requestInput.query);
    const body = createRequestBody(requestInput.body);
    const headers = mergeHeaders(config, requestInput, body.contentType);
    const fetcher = config.api ?? trpcRestFetchApi;
    const result = await fetcher({
      path: url.toString(),
      method: route.method,
      headers,
      body: body.body,
      route,
      fetchOptions: requestInput.fetchOptions,
    });

    if (
      config.throwOnUnknownStatus &&
      !responseStatusIsKnown(route, result.status)
    ) {
      throw new Error(
        `Unknown response status ${result.status} for ${route.method} ${route.path}`,
      );
    }

    const response =
      config.validateResponse && validateResponse
        ? validateResponse({ appRoute: route, response: result })
        : result;
    return response as ClientInferResponses<R>;
  };

  return callRoute as ClientMethod<R>;
}

function mapRecordValues<
  TInput extends object,
  TOutput extends { readonly [Key in keyof TInput]: unknown },
>(
  input: TInput,
  mapValue: <Key extends keyof TInput>(
    key: Key,
    value: TInput[Key],
  ) => TOutput[Key],
): TOutput {
  const output: Partial<{
    -readonly [Key in keyof TOutput]: TOutput[Key];
  }> = {};
  for (const key of Object.keys(input) as (keyof TInput)[]) {
    output[key] = mapValue(key, input[key]);
  }
  return output as TOutput;
}

export function initClient<TContract extends ClientRouter>(
  contract: TContract,
  config: InitClientArgs<TContract[keyof TContract]>,
  validateResponse?: ClientResponseValidator<TContract[keyof TContract]>,
): InitClientReturn<TContract, InitClientArgs> {
  if (config.validateResponse && validateResponse === undefined) {
    throw new Error("Response validation requires a response validator");
  }

  return mapRecordValues<
    TContract,
    InitClientReturn<TContract, InitClientArgs>
  >(contract, (_name, route) => {
    return createClientMethod(route, config, validateResponse);
  });
}
