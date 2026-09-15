import { z } from "zod";

import { apiErrorSchema, type ApiErrorResponse } from "./errors";
import { authHeadersSchema, initContract } from "./base";
import { publicBrandSchema, type PublicBrand } from "./public-brand";
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
  readonly runGroupIndex?: number;
}

export interface SharedThreadResponse {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly SharedMessage[];
  readonly publicBrand: PublicBrand;
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
}

interface CreateSharedThreadResponse {
  readonly id: string;
}

interface SharedThreadMetaResponse {
  readonly title: string;
  readonly publicBrand: PublicBrand;
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
  | ApiErrorRouteResponse<413>;

type ReadSharedThreadRouteResponse =
  | { readonly status: 200; readonly body: SharedThreadResponse }
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

const sharedMessageZodSchema = z
  .object({
    messageIndex: z.number().int().nonnegative(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    attachments: z
      .array(
        z
          .object({
            filename: z.string().min(1),
            contentType: z.string().min(1),
            size: z.number().int().nonnegative(),
            url: z.httpUrl(),
          })
          .strict(),
      )
      .optional(),
    runIndex: z.number().int().nonnegative().optional(),
    runGroupIndex: z.number().int().nonnegative().optional(),
  })
  .strict();
export const sharedMessageSchema: ZodLikeSchema<SharedMessage> =
  sharedMessageZodSchema;

const sharedThreadIdPathParamsSchema: ZodSchema<
  SharedThreadIdPathParams,
  SharedThreadIdPathParams
> = z.object({
  id: z.string().uuid(),
});

const createSharedThreadPathParamsSchema: ZodSchema<
  CreateSharedThreadPathParams,
  CreateSharedThreadPathParams
> = z.object({
  threadId: z.string().uuid(),
});

const createSharedThreadBodySchema: ZodSchema<
  CreateSharedThreadBody,
  CreateSharedThreadBody
> = z.object({
  eventIds: z.array(z.string().uuid()).min(1),
});

const createSharedThreadResponseSchema: ZodLikeSchema<CreateSharedThreadResponse> =
  z.object({
    id: z.string().uuid(),
  });

const sharedThreadResponseSchema: ZodLikeSchema<SharedThreadResponse> =
  z.object({
    id: z.string().uuid(),
    title: z.string(),
    messages: z.array(sharedMessageZodSchema),
    publicBrand: publicBrandSchema,
  });

const sharedThreadMetaResponseSchema: ZodLikeSchema<SharedThreadMetaResponse> =
  z.object({
    title: z.string(),
    publicBrand: publicBrandSchema,
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
      204: z.undefined(),
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
      404: sharedThreadApiErrorSchema,
    },
    summary: "Read an immutable public chat snapshot",
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
