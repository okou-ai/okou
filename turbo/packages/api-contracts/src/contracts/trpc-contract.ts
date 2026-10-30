import { initClient as initTransportClient } from "../client/transport";
import type {
  ApiFetcher as TransportApiFetcher,
  ApiFetcherArgs as TransportApiFetcherArgs,
  HttpMethod,
  InitClientArgs as TransportInitClientArgs,
  InitClientReturn,
} from "../client/types";

export { trpcRestFetchApi } from "../client/transport";
export type {
  ClientInferResponses,
  HttpMethod,
  InitClientReturn,
} from "../client/types";

const noBodySymbol: unique symbol = Symbol("contract.noBody");
const typeSymbol: unique symbol = Symbol("contract.type");

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
  ZodSchema<T> | ZodLikeSchema<T> | TypeMarker<T> | NoBodyMarker;

export interface ResponseWithBody<TBody = unknown> {
  readonly contentType?: string;
  readonly body: ContractSchema<TBody>;
}

export type ResponseSchema<TBody = unknown> =
  ContractSchema<TBody> | ResponseWithBody<TBody>;

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

export type ApiFetcherArgs = TransportApiFetcherArgs<AppRoute>;

export type ApiFetcher = TransportApiFetcher<AppRoute>;

export type InitClientArgs = TransportInitClientArgs<AppRoute>;

export type ServerInferRequest<R extends AppRoute> = NonNullable<
  R["__types"]
>["serverRequest"];

export type ServerInferResponses<R extends AppRoute> = NonNullable<
  R["__types"]
>["response"];

export type ServerInferResponseBody<R extends AppRoute, Status extends number> =
  Extract<ServerInferResponses<R>, { readonly status: Status }> extends {
    readonly body: infer Body;
  }
    ? Body
    : undefined;

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
  R extends Pick<AppRoute, "responses">,
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

export function initClient<TContract extends AppRouter>(
  contract: TContract,
  config: InitClientArgs,
): InitClientReturn<TContract, InitClientArgs> {
  return initTransportClient(contract, config, validateResponse);
}
