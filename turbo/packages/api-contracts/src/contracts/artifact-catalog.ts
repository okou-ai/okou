import {
  array,
  boolean,
  coerce,
  discriminatedUnion,
  literal,
  number,
  object,
  string,
  enum as zEnum,
} from "zod";

import { artifactIdPathParamsSchema } from "../validators/artifact-catalog";
import { authHeadersSchema, initContract } from "./base";
import {
  chatThreadArtifactGoogleDriveSyncSchema,
  type ChatThreadArtifactGoogleDriveSync,
} from "./artifact-google-drive-sync";
import { apiErrorSchema, type ApiErrorResponse } from "./errors";
import type {
  AnyRouteTypeSlots,
  AppRoute,
  AppRouteSpec,
  NoBodyMarker,
  ZodLikeSchema,
  ZodSchema,
} from "./trpc-contract";

const c = initContract();

export const ARTIFACT_CATALOG_KINDS = [
  "file",
  "hosted-site",
  "image",
  "video",
  "avatar",
  "presentation",
  "shared-thread",
] as const;

export type ArtifactCatalogKind = (typeof ARTIFACT_CATALOG_KINDS)[number];

interface ArtifactThumbnail {
  url: string;
}

export interface ArtifactSummary {
  id: string;
  kind: ArtifactCatalogKind;
  title: string;
  thumbnail: ArtifactThumbnail | null;
  /** Lightweight projection URL for resource-link deduplication. */
  sourceUrl?: string;
  aliasUrl?: string;
  /** Shared-conversation identity for direct navigation from the catalog. */
  sharedThreadId?: string;
  /** Original video used when the catalog card cannot show a static poster. */
  videoSourceUrl?: string;
  createdAt: string;
  updatedAt: string;
}

interface ArtifactFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  previewImageUrl: string | null;
}

interface ArtifactHostedSite {
  id: string;
  slug: string;
  publicSlug: string;
  url: string;
  deploymentVersion: number | null;
  entrypoint: string;
  spaFallback: boolean;
}

interface ArtifactDetailCommon extends ArtifactSummary {
  googleDriveConnectionId?: string;
  googleDriveSync?: ChatThreadArtifactGoogleDriveSync;
}

interface FileArtifactDetail extends ArtifactDetailCommon {
  kind: "file";
  file: ArtifactFile;
}

interface ImageArtifactDetail extends ArtifactDetailCommon {
  kind: "image";
  file: ArtifactFile;
  model: string | null;
  provider: string | null;
}

interface VideoArtifactDetail extends ArtifactDetailCommon {
  kind: "video";
  file: ArtifactFile;
  model: string | null;
  durationSeconds: number | null;
}

interface AvatarArtifactDetail extends ArtifactDetailCommon {
  kind: "avatar";
  file: ArtifactFile;
  model: string | null;
  durationSeconds: number | null;
}

interface HostedSiteArtifactDetail extends ArtifactDetailCommon {
  kind: "hosted-site";
  site: ArtifactHostedSite;
}

interface PresentationArtifactDetail extends ArtifactDetailCommon {
  kind: "presentation";
  site: ArtifactHostedSite;
}

interface SharedThreadArtifactDetail extends ArtifactDetailCommon {
  kind: "shared-thread";
  sharedThread: { id: string };
}

export type ArtifactDetail =
  | FileArtifactDetail
  | ImageArtifactDetail
  | VideoArtifactDetail
  | AvatarArtifactDetail
  | HostedSiteArtifactDetail
  | PresentationArtifactDetail
  | SharedThreadArtifactDetail;

export interface ArtifactCatalogAuthHeaders {
  readonly authorization?: string;
}

export interface ArtifactCatalogListQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly kind?: ArtifactCatalogKind;
  readonly chatThreadId?: string;
  readonly keyword?: string;
}

export interface ArtifactCatalogListClientQuery {
  readonly limit?: unknown;
  readonly cursor?: string;
  readonly kind?: ArtifactCatalogKind;
  readonly chatThreadId?: string;
  readonly keyword?: string;
}

export interface ArtifactCatalogGetQuery {
  /** Resolve an owned shared conversation to its catalog identity. */
  readonly sourceKind?: "shared-thread";
  /** Current-view thread account context; does not change artifact ownership. */
  readonly chatThreadId?: string;
}

export interface ArtifactCatalogGetClientQuery {
  readonly sourceKind?: "shared-thread";
  /** Current-view thread account context; does not change artifact ownership. */
  readonly chatThreadId?: string;
}

export interface ArtifactIdPathParams {
  readonly artifactId: string;
}

export interface ArtifactCatalogListResponse {
  artifacts: ArtifactSummary[];
  nextCursor: string | null;
}

export interface ArtifactCatalogRequestOptions {
  readonly extraHeaders?: Record<string, string>;
  readonly fetchOptions?: RequestInit;
}

export interface ArtifactCatalogListServerRequest extends ArtifactCatalogRequestOptions {
  readonly headers: ArtifactCatalogAuthHeaders;
  readonly query: ArtifactCatalogListQuery;
}

export interface ArtifactCatalogListClientRequest extends ArtifactCatalogRequestOptions {
  readonly headers?: ArtifactCatalogAuthHeaders;
  readonly query?: ArtifactCatalogListClientQuery;
}

export interface ArtifactCatalogGetServerRequest extends ArtifactCatalogRequestOptions {
  readonly headers: ArtifactCatalogAuthHeaders;
  readonly params: ArtifactIdPathParams;
  readonly query: ArtifactCatalogGetQuery;
}

export interface ArtifactCatalogGetClientRequest extends ArtifactCatalogRequestOptions {
  readonly headers?: ArtifactCatalogAuthHeaders;
  readonly params: ArtifactIdPathParams;
  readonly query?: ArtifactCatalogGetClientQuery;
}

export interface ArtifactCatalogDeleteServerRequest extends ArtifactCatalogRequestOptions {
  readonly headers: ArtifactCatalogAuthHeaders;
  readonly params: ArtifactIdPathParams;
}

export interface ArtifactCatalogDeleteClientRequest extends ArtifactCatalogRequestOptions {
  readonly headers?: ArtifactCatalogAuthHeaders;
  readonly params: ArtifactIdPathParams;
}

export type ArtifactCatalogApiErrorRouteResponse<TStatus extends number> = {
  readonly status: TStatus;
  readonly body: ApiErrorResponse;
};

export type ArtifactCatalogListRouteResponse =
  | { readonly status: 200; readonly body: ArtifactCatalogListResponse }
  | ArtifactCatalogApiErrorRouteResponse<401>
  | ArtifactCatalogApiErrorRouteResponse<403>;

export type ArtifactCatalogGetRouteResponse =
  | { readonly status: 200; readonly body: ArtifactDetail }
  | ArtifactCatalogApiErrorRouteResponse<401>
  | ArtifactCatalogApiErrorRouteResponse<403>
  | ArtifactCatalogApiErrorRouteResponse<404>;

export type ArtifactCatalogDeleteRouteResponse =
  | { readonly status: 200; readonly body: { readonly deleted: true } }
  | ArtifactCatalogApiErrorRouteResponse<400>
  | ArtifactCatalogApiErrorRouteResponse<401>
  | ArtifactCatalogApiErrorRouteResponse<403>
  | ArtifactCatalogApiErrorRouteResponse<404>
  | ArtifactCatalogApiErrorRouteResponse<500>
  | ArtifactCatalogApiErrorRouteResponse<503>;

export interface ArtifactCatalogListRouteTypes extends AnyRouteTypeSlots {
  readonly serverRequest: ArtifactCatalogListServerRequest;
  readonly clientRequest: ArtifactCatalogListClientRequest | undefined;
  readonly response: ArtifactCatalogListRouteResponse;
}

export interface ArtifactCatalogGetRouteTypes extends AnyRouteTypeSlots {
  readonly serverRequest: ArtifactCatalogGetServerRequest;
  readonly clientRequest: ArtifactCatalogGetClientRequest;
  readonly response: ArtifactCatalogGetRouteResponse;
}

export interface ArtifactCatalogDeleteRouteTypes extends AnyRouteTypeSlots {
  readonly serverRequest: ArtifactCatalogDeleteServerRequest;
  readonly clientRequest: ArtifactCatalogDeleteClientRequest;
  readonly response: ArtifactCatalogDeleteRouteResponse;
}

const artifactKindSchema = zEnum(ARTIFACT_CATALOG_KINDS);

/**
 * Static preview descriptor rendered by the catalog grid. Absent when the
 * artifact has no pre-rendered image yet.
 */
const artifactThumbnailSchema = object({
  url: string(),
});

/**
 * The catalog list returns only the metadata every kind shares. Kind-specific
 * attributes are loaded from the detail endpoint after a card is opened. Shared
 * conversations include their destination identity so native links need no
 * detail request. The list query never joins a kind table.
 */
const artifactSummarySchema = object({
  id: string().uuid(),
  kind: artifactKindSchema,
  title: string(),
  thumbnail: artifactThumbnailSchema.nullable(),
  sourceUrl: string().optional(),
  aliasUrl: string().optional(),
  sharedThreadId: string().uuid().optional(),
  videoSourceUrl: string().optional(),
  createdAt: string(),
  updatedAt: string(),
});

const artifactCatalogListQuerySchema = object({
  limit: coerce.number().int().positive().max(200).optional(),
  cursor: string().optional(),
  kind: artifactKindSchema.optional(),
  chatThreadId: string().uuid().optional(),
  keyword: string().trim().min(1).max(256).optional(),
});

const artifactCatalogGetQuerySchema = object({
  sourceKind: literal("shared-thread").optional(),
  chatThreadId: string().uuid().optional(),
});

const artifactCatalogListResponseSchema = object({
  artifacts: array(artifactSummarySchema),
  nextCursor: string().nullable(),
});

/**
 * The stored file backing a `file`, `image`, `video`, or `avatar` artifact.
 */
const artifactFileSchema = object({
  id: string().uuid(),
  filename: string(),
  contentType: string(),
  size: number(),
  url: string(),
  previewImageUrl: string().nullable(),
});

/**
 * The hosted deployment backing a `hosted-site` or `presentation` artifact.
 * Version state stays owned by the hosted deployment records.
 */
const artifactHostedSiteSchema = object({
  id: string().uuid(),
  slug: string(),
  publicSlug: string(),
  url: string(),
  deploymentVersion: number().nullable(),
  entrypoint: string(),
  spaFallback: boolean(),
});

// Drive metadata is loaded lazily for detail requests with thread context only.
const artifactDetailBaseSchema = artifactSummarySchema.extend({
  googleDriveConnectionId: string().uuid().optional(),
  googleDriveSync: chatThreadArtifactGoogleDriveSyncSchema.optional(),
});

const artifactDetailSchema = discriminatedUnion("kind", [
  artifactDetailBaseSchema.extend({
    kind: literal("file"),
    file: artifactFileSchema,
  }),
  artifactDetailBaseSchema.extend({
    kind: literal("image"),
    file: artifactFileSchema,
    model: string().nullable(),
    provider: string().nullable(),
  }),
  artifactDetailBaseSchema.extend({
    kind: literal("video"),
    file: artifactFileSchema,
    model: string().nullable(),
    durationSeconds: number().nullable(),
  }),
  artifactDetailBaseSchema.extend({
    kind: literal("avatar"),
    file: artifactFileSchema,
    model: string().nullable(),
    durationSeconds: number().nullable(),
  }),
  artifactDetailBaseSchema.extend({
    kind: literal("hosted-site"),
    site: artifactHostedSiteSchema,
  }),
  artifactDetailBaseSchema.extend({
    kind: literal("presentation"),
    site: artifactHostedSiteSchema,
  }),
  artifactDetailBaseSchema.extend({
    kind: literal("shared-thread"),
    sharedThread: object({ id: string().uuid() }),
  }),
]);

const artifactCatalogAuthHeadersSchema: ZodSchema<
  ArtifactCatalogAuthHeaders,
  ArtifactCatalogAuthHeaders
> = authHeadersSchema;
const artifactCatalogQuerySchema: ZodSchema<
  ArtifactCatalogListQuery,
  ArtifactCatalogListClientQuery
> = artifactCatalogListQuerySchema;
const artifactCatalogGetRequestQuerySchema: ZodSchema<
  ArtifactCatalogGetQuery,
  ArtifactCatalogGetClientQuery
> = artifactCatalogGetQuerySchema;
const artifactCatalogPathParamsSchema: ZodSchema<
  ArtifactIdPathParams,
  ArtifactIdPathParams
> = artifactIdPathParamsSchema;
const artifactCatalogListResultSchema: ZodLikeSchema<ArtifactCatalogListResponse> =
  artifactCatalogListResponseSchema;
const artifactCatalogDetailResultSchema: ZodLikeSchema<ArtifactDetail> =
  artifactDetailSchema;
const artifactCatalogApiErrorSchema: ZodLikeSchema<ApiErrorResponse> =
  apiErrorSchema;

const artifactCatalogRuntimeSpec = {
  list: {
    method: "GET",
    path: "/api/artifacts/catalog",
    headers: artifactCatalogAuthHeadersSchema,
    query: artifactCatalogQuerySchema,
    responses: {
      200: artifactCatalogListResultSchema,
      401: artifactCatalogApiErrorSchema,
      403: artifactCatalogApiErrorSchema,
    },
    summary: "List the caller's artifacts from the artifact catalog",
  },
  get: {
    method: "GET",
    path: "/api/artifacts/catalog/:artifactId",
    headers: artifactCatalogAuthHeadersSchema,
    pathParams: artifactCatalogPathParamsSchema,
    query: artifactCatalogGetRequestQuerySchema,
    responses: {
      200: artifactCatalogDetailResultSchema,
      401: artifactCatalogApiErrorSchema,
      403: artifactCatalogApiErrorSchema,
      404: artifactCatalogApiErrorSchema,
    },
    summary: "Get one artifact with its kind-specific detail",
  },
  delete: {
    method: "DELETE",
    path: "/api/artifacts/catalog/:artifactId",
    headers: artifactCatalogAuthHeadersSchema,
    pathParams: artifactCatalogPathParamsSchema,
    body: c.noBody(),
    responses: {
      200: object({ deleted: literal(true) }),
      400: artifactCatalogApiErrorSchema,
      401: artifactCatalogApiErrorSchema,
      403: artifactCatalogApiErrorSchema,
      404: artifactCatalogApiErrorSchema,
      500: artifactCatalogApiErrorSchema,
      503: artifactCatalogApiErrorSchema,
    },
    summary: "Delete an owned artifact and withdraw its Okou links",
  },
} as const satisfies Record<"list" | "get" | "delete", AppRouteSpec>;

const artifactCatalogRuntimeContract = c.router(artifactCatalogRuntimeSpec);

export type ArtifactCatalogListRoute =
  AppRoute<ArtifactCatalogListRouteTypes> & {
    readonly method: "GET";
    readonly path: "/api/artifacts/catalog";
    readonly headers: ZodSchema<
      ArtifactCatalogAuthHeaders,
      ArtifactCatalogAuthHeaders
    >;
    readonly query: ZodSchema<
      ArtifactCatalogListQuery,
      ArtifactCatalogListClientQuery
    >;
  };

export type ArtifactCatalogGetRoute = AppRoute<ArtifactCatalogGetRouteTypes> & {
  readonly method: "GET";
  readonly path: "/api/artifacts/catalog/:artifactId";
  readonly headers: ZodSchema<
    ArtifactCatalogAuthHeaders,
    ArtifactCatalogAuthHeaders
  >;
  readonly pathParams: ZodSchema<ArtifactIdPathParams, ArtifactIdPathParams>;
  readonly query: ZodSchema<
    ArtifactCatalogGetQuery,
    ArtifactCatalogGetClientQuery
  >;
};

export type ArtifactCatalogContract = {
  readonly list: ArtifactCatalogListRoute;
  readonly get: ArtifactCatalogGetRoute;
  readonly delete: AppRoute<ArtifactCatalogDeleteRouteTypes> & {
    readonly method: "DELETE";
    readonly path: "/api/artifacts/catalog/:artifactId";
    readonly headers: ZodSchema<
      ArtifactCatalogAuthHeaders,
      ArtifactCatalogAuthHeaders
    >;
    readonly pathParams: ZodSchema<ArtifactIdPathParams, ArtifactIdPathParams>;
    readonly body: NoBodyMarker;
  };
};

// Keep runtime validation from the Zod-backed router while exposing compact,
// explicit request and response slots to downstream API and app typechecks.
export const artifactCatalogContract: ArtifactCatalogContract =
  artifactCatalogRuntimeContract;
export {
  artifactIdPathParamsSchema,
  chatArtifactCatalogChangedEvent,
} from "../validators/artifact-catalog";
