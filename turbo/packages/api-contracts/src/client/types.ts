import type { AppRoute, AppRouter } from "../contracts/trpc-contract";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ClientTypeSlots {
  readonly clientRequest: unknown;
  readonly response: unknown;
}

interface ClientRouteBase {
  readonly method: HttpMethod;
  readonly path: string;
  readonly contentType?: string;
  readonly __types?: ClientTypeSlots;
}

export type ClientRoute = ClientRouteBase &
  (
    | { readonly statuses: Readonly<Record<number, true>> }
    | { readonly responses: AppRoute["responses"] }
  );

export type ClientRouter = Record<string, ClientRoute>;

type StatusOf<TRoute extends AppRoute> = NonNullable<
  TRoute["__types"]
>["response"] extends { readonly status: infer Status extends number }
  ? Status
  : never;

export type ClientDescriptor<TContract extends AppRouter> = {
  readonly [Key in keyof TContract]: {
    readonly method: TContract[Key]["method"];
    readonly path: TContract[Key]["path"];
    readonly contentType?: string;
    readonly statuses: Readonly<Record<StatusOf<TContract[Key]>, true>>;
    readonly __types?: {
      readonly clientRequest: NonNullable<
        TContract[Key]["__types"]
      >["clientRequest"];
      readonly response: NonNullable<TContract[Key]["__types"]>["response"];
    };
  };
};

export interface ApiFetcherArgs<TRoute extends ClientRoute = ClientRoute> {
  readonly path: string;
  readonly method: HttpMethod;
  readonly headers: NonNullable<RequestInit["headers"]>;
  readonly body?: NonNullable<RequestInit["body"]>;
  readonly route: TRoute;
  readonly fetchOptions?: RequestInit;
}

export interface ApiFetcherResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

export type ApiFetcher<TRoute extends ClientRoute = ClientRoute> = (
  args: ApiFetcherArgs<TRoute>,
) => Promise<ApiFetcherResponse>;

export interface InitClientArgs<TRoute extends ClientRoute = ClientRoute> {
  readonly baseUrl: string;
  readonly baseHeaders?: Record<string, string>;
  readonly jsonQuery?: boolean;
  readonly throwOnUnknownStatus?: boolean;
  readonly validateResponse?: boolean;
  readonly api?: ApiFetcher<TRoute>;
}

export type ClientResponseValidator<TRoute extends ClientRoute = ClientRoute> =
  (args: {
    readonly appRoute: TRoute;
    readonly response: ApiFetcherResponse;
  }) => ApiFetcherResponse;

export type ClientInferRequest<R extends ClientRoute> = NonNullable<
  R["__types"]
>["clientRequest"];

export type ClientInferResponses<R extends ClientRoute> = NonNullable<
  R["__types"]
>["response"] & {
  readonly headers: Headers;
};

export type ClientMethod<R extends ClientRoute> =
  undefined extends ClientInferRequest<R>
    ? (args?: ClientInferRequest<R>) => Promise<ClientInferResponses<R>>
    : (args: ClientInferRequest<R>) => Promise<ClientInferResponses<R>>;

export type InitClientReturn<
  TContract extends ClientRouter,
  TArgs,
> = TArgs extends unknown
  ? {
      readonly [Key in keyof TContract]: ClientMethod<TContract[Key]>;
    }
  : never;
