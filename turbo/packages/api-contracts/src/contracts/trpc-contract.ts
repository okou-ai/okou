const noBodySymbol: unique symbol = Symbol("contract.noBody");
const typeSymbol: unique symbol = Symbol("contract.type");

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface NoBodyMarker {
  readonly [noBodySymbol]: true;
}

export interface TypeMarker<T> {
  readonly [typeSymbol]: T;
}

interface ZodLikeResult<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: { readonly issues: readonly unknown[] };
}

export interface ZodLikeSchema<T = unknown> {
  readonly safeParse: (input: unknown) => ZodLikeResult<T>;
}

export interface ZodSchema<TOutput = unknown, TInput = unknown> {
  readonly _zod: {
    readonly output: TOutput;
    readonly input: TInput;
  };
  readonly safeParse: (input: unknown) => ZodLikeResult<TOutput>;
}

export type ContractSchema<T = unknown> =
  | ZodSchema<T>
  | ZodLikeSchema<T>
  | TypeMarker<T>
  | NoBodyMarker;

export interface ResponseWithBody<TBody = unknown> {
  readonly contentType?: string;
  readonly body: ContractSchema<TBody>;
}

export type ResponseSchema<TBody = unknown> =
  | ContractSchema<TBody>
  | ResponseWithBody<TBody>;

export type ResponseMap = Record<number, ResponseSchema>;

export interface AppRouteSpec {
  readonly method: HttpMethod;
  readonly path: string;
  readonly headers?: ContractSchema;
  readonly query?: ContractSchema;
  readonly pathParams?: ContractSchema;
  readonly body?: ContractSchema;
  readonly contentType?: string;
  readonly responses: ResponseMap;
  readonly summary?: string;
}

// Read Zod v4 input/output through its shallow structural slots. Matching
// `z.ZodType<infer T>` forces expensive variance checks across Zod internals.
type ZodSchemaOutput<T> = T extends {
  readonly _zod: { readonly output: infer Output };
}
  ? Output
  : never;

type ZodSchemaInput<T> = T extends {
  readonly _zod: { readonly input: infer Input };
}
  ? Input
  : never;

export type SchemaOutput<T> = T extends {
  readonly _zod: { readonly output: unknown };
}
  ? ZodSchemaOutput<T>
  : T extends ZodLikeSchema<infer Output>
    ? Output
    : T extends TypeMarker<infer Output>
      ? Output
      : T extends NoBodyMarker
        ? undefined
        : never;

type SchemaInput<T> = T extends { readonly _zod: { readonly input: unknown } }
  ? ZodSchemaInput<T>
  : T extends ZodLikeSchema<infer Output>
    ? Output
    : T extends TypeMarker<infer Output>
      ? Output
      : T extends NoBodyMarker
        ? undefined
        : never;

type EmptyObject = Record<never, never>;

type ResponseBody<T> = T extends { readonly body: infer Body }
  ? SchemaOutput<Body>
  : SchemaOutput<T>;

type ResponseUnion<TResponses extends ResponseMap> = {
  readonly [Status in keyof TResponses & number]: {
    readonly status: Status;
    readonly body: ResponseBody<TResponses[Status]>;
  };
}[keyof TResponses & number];

type AddRequestPart<
  TKey extends string,
  TSchema,
> = TSchema extends ContractSchema
  ? SchemaOutput<TSchema> extends infer Output
    ? [Output] extends [undefined]
      ? { readonly [Key in TKey]?: undefined }
      : { readonly [Key in TKey]: Output }
    : never
  : Record<never, never>;

type AddClientRequestPart<
  TKey extends string,
  TSchema,
> = TSchema extends ContractSchema
  ? SchemaInput<TSchema> extends infer Input
    ? [Input] extends [undefined]
      ? { readonly [Key in TKey]?: Input }
      : EmptyObject extends Input
        ? { readonly [Key in TKey]?: Input }
        : { readonly [Key in TKey]: Input }
    : never
  : Record<never, never>;

type ServerRouteRequest<TSpec extends AppRouteSpec> = AddRequestPart<
  "params",
  TSpec["pathParams"]
> &
  AddRequestPart<"query", TSpec["query"]> &
  AddRequestPart<"body", TSpec["body"]> &
  AddRequestPart<"headers", TSpec["headers"]> & {
    readonly extraHeaders?: Record<string, string>;
    readonly fetchOptions?: RequestInit;
  };

type ClientRouteRequest<TSpec extends AppRouteSpec> = AddClientRequestPart<
  "params",
  TSpec["pathParams"]
> &
  AddClientRequestPart<"query", TSpec["query"]> &
  AddClientRequestPart<"body", TSpec["body"]> &
  AddClientRequestPart<"headers", TSpec["headers"]> & {
    readonly extraHeaders?: Record<string, string>;
    readonly fetchOptions?: RequestInit;
  };

type ClientRouteInput<TSpec extends AppRouteSpec> =
  EmptyObject extends ClientRouteRequest<TSpec>
    ? ClientRouteRequest<TSpec> | undefined
    : ClientRouteRequest<TSpec>;

export type RouteTypeSlots<TSpec extends AppRouteSpec> = {
  readonly serverRequest: ServerRouteRequest<TSpec>;
  readonly clientRequest: ClientRouteInput<TSpec>;
  readonly response: ResponseUnion<TSpec["responses"]>;
};

export interface AnyRouteTypeSlots {
  readonly serverRequest: unknown;
  readonly clientRequest: unknown;
  readonly response: unknown;
}

type RuntimeRouteSpec = {
  readonly method: HttpMethod;
  readonly path: string;
  readonly headers?: ContractSchema;
  readonly query?: ContractSchema;
  readonly pathParams?: ContractSchema;
  readonly body?: ContractSchema;
  readonly contentType?: string;
  readonly responses: ResponseMap;
  readonly summary?: string;
};

export type AppRoute<TTypes extends AnyRouteTypeSlots = AnyRouteTypeSlots> =
  RuntimeRouteSpec & {
    readonly __types?: TTypes;
  };

export type AppRouteMutation = AppRoute & {
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
};

export type AppRouter = Record<string, AppRoute>;

export interface ApiFetcherArgs {
  readonly path: string;
  readonly method: HttpMethod;
  readonly headers: NonNullable<RequestInit["headers"]>;
  readonly body?: NonNullable<RequestInit["body"]>;
  readonly route: AppRoute;
  readonly fetchOptions?: RequestInit;
}

export type ApiFetcher = (args: ApiFetcherArgs) => Promise<{
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}>;

export interface InitClientArgs {
  readonly baseUrl: string;
  readonly baseHeaders?: Record<string, string>;
  readonly jsonQuery?: boolean;
  readonly throwOnUnknownStatus?: boolean;
  readonly validateResponse?: boolean;
  readonly api?: ApiFetcher;
}

export type ServerInferRequest<R extends AppRoute> = NonNullable<
  R["__types"]
>["serverRequest"];

export type ServerInferResponses<R extends AppRoute> = NonNullable<
  R["__types"]
>["response"];

export type ClientInferResponses<R extends AppRoute> =
  ServerInferResponses<R> & {
    readonly headers: Headers;
  };

export type ServerInferResponseBody<R extends AppRoute, Status extends number> =
  Extract<ServerInferResponses<R>, { readonly status: Status }> extends {
    readonly body: infer Body;
  }
    ? Body
    : undefined;

type ClientInferRequest<R extends AppRoute> = NonNullable<
  R["__types"]
>["clientRequest"];

type ClientMethod<R extends AppRoute> =
  undefined extends ClientInferRequest<R>
    ? (args?: ClientInferRequest<R>) => Promise<ClientInferResponses<R>>
    : (args: ClientInferRequest<R>) => Promise<ClientInferResponses<R>>;

export type InitClientReturn<
  TContract extends AppRouter,
  TArgs,
> = TArgs extends unknown
  ? {
      readonly [Key in keyof TContract]: ClientMethod<TContract[Key]>;
    }
  : never;

function isNoBody(value: unknown): value is NoBodyMarker {
  return typeof value === "object" && value !== null && noBodySymbol in value;
}

function isTypeMarker(value: unknown): value is TypeMarker<unknown> {
  return typeof value === "object" && value !== null && typeSymbol in value;
}

function isZodLikeSchema(value: unknown): value is ZodLikeSchema {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof (value as { readonly safeParse: unknown }).safeParse === "function"
  );
}

function responseBodySchema(response: ResponseSchema): ContractSchema {
  if (typeof response === "object" && response !== null && "body" in response) {
    return response.body;
  }

  return response;
}

function validateSchema(schema: ContractSchema, body: unknown): unknown {
  if (isNoBody(schema)) {
    return body;
  }

  if (isTypeMarker(schema)) {
    return body;
  }

  if (!isZodLikeSchema(schema)) {
    return body;
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    throw new Error(
      `Response validation failed: ${JSON.stringify(result.error?.issues ?? [])}`,
    );
  }

  return result.data;
}

function isFrameworkErrorResponse(response: ResponseForValidation): boolean {
  if (response.status < 500) {
    return false;
  }

  if (typeof response.body === "string") {
    return true;
  }

  return (
    typeof response.body === "object" &&
    response.body !== null &&
    "error" in response.body &&
    typeof response.body.error === "string"
  );
}

interface ResponseForValidation {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Headers;
}

export function validateResponse<
  R extends AppRoute,
  TResponse extends ResponseForValidation,
>(args: { readonly appRoute: R; readonly response: TResponse }): TResponse {
  const response = args.response;
  const schema = args.appRoute.responses[response.status];
  if (!schema) {
    return args.response;
  }

  let body: unknown;
  try {
    body = validateSchema(responseBodySchema(schema), response.body);
  } catch (error) {
    if (isFrameworkErrorResponse(response)) {
      return response;
    }
    throw error;
  }
  return { ...response, body };
}

type RouteFromSpec<TSpec extends AppRouteSpec> = TSpec &
  AppRoute<RouteTypeSlots<TSpec>>;

type RouterFromSpec<TSpec extends Record<string, AppRouteSpec>> = {
  readonly [Key in keyof TSpec]: RouteFromSpec<TSpec[Key]>;
};

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

export function initContract(): {
  readonly router: <TSpec extends Record<string, AppRouteSpec>>(
    spec: TSpec,
  ) => RouterFromSpec<TSpec>;
  readonly noBody: () => NoBodyMarker;
  readonly otherResponse: <TResponse extends ResponseWithBody>(
    response: TResponse,
  ) => TResponse;
  readonly type: <T>() => TypeMarker<T>;
} {
  return {
    router: (spec) => {
      return spec;
    },
    noBody: () => {
      return { [noBodySymbol]: true };
    },
    otherResponse: (response) => {
      return response;
    },
    type: <T>() => {
      return { [typeSymbol]: undefined as T };
    },
  };
}

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
  config: InitClientArgs,
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
): Promise<{
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}> {
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

function responseStatusIsKnown(route: AppRoute, status: number): boolean {
  return Object.hasOwn(route.responses, status);
}

function createClientMethod<R extends AppRoute>(
  route: R,
  config: InitClientArgs,
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

    const response = config.validateResponse
      ? validateResponse({
          appRoute: route,
          response: result,
        })
      : result;
    return response as ClientInferResponses<R>;
  };

  return callRoute as ClientMethod<R>;
}

export function initClient<TContract extends AppRouter>(
  contract: TContract,
  config: InitClientArgs,
): InitClientReturn<TContract, InitClientArgs> {
  return mapRecordValues<
    TContract,
    InitClientReturn<TContract, InitClientArgs>
  >(contract, (_name, route) => {
    return createClientMethod(route, config);
  });
}
