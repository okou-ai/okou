import {
  array,
  httpUrl,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  undefined as zUndefined,
} from "zod";

import { apiErrorSchema, type ApiErrorResponse } from "./errors";
import { authHeadersSchema, initContract } from "./base";
import type {
  AnyRouteTypeSlots,
  AppRoute,
  AppRouteSpec,
  ZodLikeSchema,
  ZodSchema,
} from "./trpc-contract";

const c = initContract();

export interface SharedMessageAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly url: string;
}

export interface SharedMessage {
  readonly messageIndex: number;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly attachments?: readonly SharedMessageAttachment[];
  readonly runIndex?: number;
}

export interface SharedThreadResponse {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly SharedMessage[];
}

interface SharedThreadIdPathParams {
  readonly id: string;
}

interface SharedThreadAuthHeaders {
  readonly authorization?: string;
}

interface CreateSharedThreadPathParams {
  readonly threadId: string;
}

interface CreateSharedThreadBody {
  readonly eventIds: readonly string[];
  /**
   * Optional client-generated share ID. It lets the client copy the public
   * link synchronously inside the user gesture and create the share after.
   */
  readonly id?: string;
}

interface CreateSharedThreadResponse {
  readonly id: string;
}

interface SharedThreadMetaResponse {
  readonly title: string;
}

interface SharedThreadRequestOptions {
  readonly extraHeaders?: Record<string, string>;
  readonly fetchOptions?: RequestInit;
}

interface CreateSharedThreadServerRequest extends SharedThreadRequestOptions {
  readonly params: CreateSharedThreadPathParams;
  readonly body: CreateSharedThreadBody;
  readonly headers: SharedThreadAuthHeaders;
}

interface CreateSharedThreadClientRequest extends SharedThreadRequestOptions {
  readonly params: CreateSharedThreadPathParams;
  readonly body: CreateSharedThreadBody;
  readonly headers?: SharedThreadAuthHeaders;
}

interface ReadSharedThreadRequest extends SharedThreadRequestOptions {
  readonly params: SharedThreadIdPathParams;
  readonly headers?: SharedThreadAuthHeaders;
}

type ApiErrorRouteResponse<TStatus extends number> = {
  readonly status: TStatus;
  readonly body: ApiErrorResponse;
};

type CreateSharedThreadRouteResponse =
  | { readonly status: 201; readonly body: CreateSharedThreadResponse }
  | ApiErrorRouteResponse<400>
  | ApiErrorRouteResponse<401>
  | ApiErrorRouteResponse<403>
  | ApiErrorRouteResponse<404>
  | ApiErrorRouteResponse<409>
  | ApiErrorRouteResponse<413>;

type ReadSharedThreadRouteResponse =
  | { readonly status: 200; readonly body: SharedThreadResponse }
  | ApiErrorRouteResponse<401>
  | ApiErrorRouteResponse<403>
  | ApiErrorRouteResponse<503>
  | ApiErrorRouteResponse<404>;

type ReadSharedThreadMetaRouteResponse =
  | { readonly status: 200; readonly body: SharedThreadMetaResponse }
  | ApiErrorRouteResponse<404>;

interface CreateSharedThreadRouteTypes extends AnyRouteTypeSlots {
  readonly serverRequest: CreateSharedThreadServerRequest;
  readonly clientRequest: CreateSharedThreadClientRequest;
  readonly response: CreateSharedThreadRouteResponse;
}

interface ReadSharedThreadRouteTypes extends AnyRouteTypeSlots {
  readonly serverRequest: ReadSharedThreadRequest;
  readonly clientRequest: ReadSharedThreadRequest;
  readonly response: ReadSharedThreadRouteResponse;
}

interface ReadSharedThreadMetaRouteTypes extends AnyRouteTypeSlots {
  readonly serverRequest: ReadSharedThreadRequest;
  readonly clientRequest: ReadSharedThreadRequest;
  readonly response: ReadSharedThreadMetaRouteResponse;
}

interface DeleteSharedThreadRouteTypes extends AnyRouteTypeSlots {
  readonly serverRequest: ReadSharedThreadRequest & {
    readonly headers: SharedThreadAuthHeaders;
  };
  readonly clientRequest: ReadSharedThreadRequest & {
    readonly headers?: SharedThreadAuthHeaders;
  };
  readonly response:
    | { readonly status: 204; readonly body: undefined }
    | ApiErrorRouteResponse<401>
    | ApiErrorRouteResponse<403>
    | ApiErrorRouteResponse<404>;
}

const sharedMessageZodSchema = object({
  messageIndex: number().int().nonnegative(),
  role: zEnum(["user", "assistant"]),
  content: string(),
  attachments: array(
    object({
      filename: string().min(1),
      contentType: string().min(1),
      size: number().int().nonnegative(),
      url: httpUrl(),
    }).strict(),
  ).optional(),
  runIndex: number().int().nonnegative().optional(),
}).strict();
export const sharedMessageSchema: ZodLikeSchema<SharedMessage> =
  sharedMessageZodSchema;

const sharedThreadIdPathParamsSchema: ZodSchema<
  SharedThreadIdPathParams,
  SharedThreadIdPathParams
> = object({
  id: uuid(),
});

const createSharedThreadPathParamsSchema: ZodSchema<
  CreateSharedThreadPathParams,
  CreateSharedThreadPathParams
> = object({
  threadId: uuid(),
});

const createSharedThreadBodySchema: ZodSchema<
  CreateSharedThreadBody,
  CreateSharedThreadBody
> = object({
  eventIds: array(uuid()).min(1),
  id: uuid().optional(),
});

const createSharedThreadResponseSchema: ZodLikeSchema<CreateSharedThreadResponse> =
  object({
    id: uuid(),
  });

const sharedThreadResponseSchema: ZodLikeSchema<SharedThreadResponse> = object({
  id: uuid(),
  title: string(),
  messages: array(sharedMessageZodSchema),
});

const sharedThreadMetaResponseSchema: ZodLikeSchema<SharedThreadMetaResponse> =
  object({
    title: string(),
  });

const sharedThreadApiErrorSchema: ZodLikeSchema<ApiErrorResponse> =
  apiErrorSchema;
const sharedThreadAuthHeadersSchema: ZodSchema<
  SharedThreadAuthHeaders,
  SharedThreadAuthHeaders
> = authHeadersSchema;

const sharedThreadsRuntimeSpec = {
  delete: {
    method: "DELETE",
    path: "/api/shared-threads/:id",
    headers: sharedThreadAuthHeadersSchema,
    pathParams: sharedThreadIdPathParamsSchema,
    responses: {
      204: zUndefined(),
      401: sharedThreadApiErrorSchema,
      403: sharedThreadApiErrorSchema,
      404: sharedThreadApiErrorSchema,
    },
    summary:
      "Remove an owned conversation share and revoke all of its resource links",
  },
  create: {
    method: "POST",
    path: "/api/chat-threads/:threadId/shared-threads",
    headers: sharedThreadAuthHeadersSchema,
    pathParams: createSharedThreadPathParamsSchema,
    body: createSharedThreadBodySchema,
    responses: {
      201: createSharedThreadResponseSchema,
      400: sharedThreadApiErrorSchema,
      401: sharedThreadApiErrorSchema,
      403: sharedThreadApiErrorSchema,
      404: sharedThreadApiErrorSchema,
      409: sharedThreadApiErrorSchema,
      413: sharedThreadApiErrorSchema,
    },
    summary: "Create an immutable public snapshot from selected chat events",
  },
  get: {
    method: "GET",
    path: "/api/shared-threads/:id",
    pathParams: sharedThreadIdPathParamsSchema,
    responses: {
      200: sharedThreadResponseSchema,
      401: sharedThreadApiErrorSchema,
      403: sharedThreadApiErrorSchema,
      503: sharedThreadApiErrorSchema,
      404: sharedThreadApiErrorSchema,
    },
    summary: "Read an authorized conversation snapshot",
  },
  meta: {
    method: "GET",
    path: "/api/shared-threads/:id/meta",
    pathParams: sharedThreadIdPathParamsSchema,
    responses: {
      200: sharedThreadMetaResponseSchema,
      404: sharedThreadApiErrorSchema,
    },
    summary: "Read public metadata for a shared chat snapshot",
  },
} as const satisfies Record<"create" | "get" | "meta" | "delete", AppRouteSpec>;

const sharedThreadsRuntimeContract = c.router(sharedThreadsRuntimeSpec);

type CreateSharedThreadRoute = AppRoute<CreateSharedThreadRouteTypes> & {
  readonly method: "POST";
  readonly path: "/api/chat-threads/:threadId/shared-threads";
  readonly headers: ZodSchema<SharedThreadAuthHeaders, SharedThreadAuthHeaders>;
  readonly pathParams: ZodSchema<
    CreateSharedThreadPathParams,
    CreateSharedThreadPathParams
  >;
  readonly body: ZodSchema<CreateSharedThreadBody, CreateSharedThreadBody>;
};

type ReadSharedThreadRoute = AppRoute<ReadSharedThreadRouteTypes> & {
  readonly method: "GET";
  readonly path: "/api/shared-threads/:id";
  readonly pathParams: ZodSchema<
    SharedThreadIdPathParams,
    SharedThreadIdPathParams
  >;
};

type ReadSharedThreadMetaRoute = AppRoute<ReadSharedThreadMetaRouteTypes> & {
  readonly method: "GET";
  readonly path: "/api/shared-threads/:id/meta";
  readonly pathParams: ZodSchema<
    SharedThreadIdPathParams,
    SharedThreadIdPathParams
  >;
};

export type SharedThreadsContract = {
  readonly delete: AppRoute<DeleteSharedThreadRouteTypes> & {
    readonly method: "DELETE";
    readonly path: "/api/shared-threads/:id";
    readonly headers: ZodSchema<
      SharedThreadAuthHeaders,
      SharedThreadAuthHeaders
    >;
    readonly pathParams: ZodSchema<
      SharedThreadIdPathParams,
      SharedThreadIdPathParams
    >;
  };
  readonly create: CreateSharedThreadRoute;
  readonly get: ReadSharedThreadRoute;
  readonly meta: ReadSharedThreadMetaRoute;
};

// Keep runtime validation from the Zod-backed router while exposing compact,
// explicit request and response slots to downstream API and app typechecks.
export const sharedThreadsContract: SharedThreadsContract =
  sharedThreadsRuntimeContract;
