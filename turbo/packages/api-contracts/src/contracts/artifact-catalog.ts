import * as z from "zod";

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
  /** Current-view thread account context; does not change artifact ownership. */
  readonly chatThreadId?: string;
}

export interface ArtifactCatalogGetClientQuery {
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

const artifactKindSchema = z.enum(ARTIFACT_CATALOG_KINDS);

/**
 * Static preview descriptor rendered by the catalog grid. Absent when the
 * artifact has no pre-rendered image yet.
 */
const artifactThumbnailSchema = z.object({
  url: z.string(),
});

/**
 * The catalog list returns only the metadata every kind shares. Kind-specific
 * attributes are loaded from the detail endpoint after a card is opened, so the
 * list query never joins a kind table and never exposes `entityId`.
 */
const artifactSummarySchema = z.object({
  id: z.string().uuid(),
  kind: artifactKindSchema,
  title: z.string(),
  thumbnail: artifactThumbnailSchema.nullable(),
  sourceUrl: z.string().optional(),
  aliasUrl: z.string().optional(),
  videoSourceUrl: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Keyset pagination over `(created_at DESC, id DESC)`. Updates never reorder
 * the list, so a cursor stays stable for the whole scroll session.
 */
const artifactIdPathParamsSchema = z.object({
  artifactId: z.string().uuid(),
});

const artifactCatalogListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  cursor: z.string().optional(),
  kind: artifactKindSchema.optional(),
  chatThreadId: z.string().uuid().optional(),
  keyword: z.string().trim().min(1).max(256).optional(),
});

const artifactCatalogGetQuerySchema = z.object({
  chatThreadId: z.string().uuid().optional(),
});

const artifactCatalogListResponseSchema = z.object({
  artifacts: z.array(artifactSummarySchema),
  nextCursor: z.string().nullable(),
});

/**
 * The stored file backing a `file`, `image`, `video`, or `avatar` artifact.
 */
const artifactFileSchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  url: z.string(),
  previewImageUrl: z.string().nullable(),
});

/**
 * The hosted deployment backing a `hosted-site` or `presentation` artifact.
 * Version state stays owned by the hosted deployment records.
 */
const artifactHostedSiteSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  publicSlug: z.string(),
  url: z.string(),
  deploymentVersion: z.number().nullable(),
  entrypoint: z.string(),
  spaFallback: z.boolean(),
});

// Drive metadata is loaded lazily for detail requests with thread context only.
const artifactDetailBaseSchema = artifactSummarySchema.extend({
  googleDriveConnectionId: z.string().uuid().optional(),
  googleDriveSync: chatThreadArtifactGoogleDriveSyncSchema.optional(),
});

const artifactDetailSchema = z.discriminatedUnion("kind", [
  artifactDetailBaseSchema.extend({
    kind: z.literal("file"),
    file: artifactFileSchema,
  }),
  artifactDetailBaseSchema.extend({
    kind: z.literal("image"),
    file: artifactFileSchema,
    model: z.string().nullable(),
    provider: z.string().nullable(),
  }),
  artifactDetailBaseSchema.extend({
    kind: z.literal("video"),
    file: artifactFileSchema,
    model: z.string().nullable(),
    durationSeconds: z.number().nullable(),
  }),
  artifactDetailBaseSchema.extend({
    kind: z.literal("avatar"),
    file: artifactFileSchema,
    model: z.string().nullable(),
    durationSeconds: z.number().nullable(),
  }),
  artifactDetailBaseSchema.extend({
    kind: z.literal("hosted-site"),
    site: artifactHostedSiteSchema,
  }),
  artifactDetailBaseSchema.extend({
    kind: z.literal("presentation"),
    site: artifactHostedSiteSchema,
  }),
  artifactDetailBaseSchema.extend({
    kind: z.literal("shared-thread"),
    sharedThread: z.object({ id: z.string().uuid() }),
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
} as const satisfies Record<"list" | "get", AppRouteSpec>;

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
};

// Keep runtime validation from the Zod-backed router while exposing compact,
// explicit request and response slots to downstream API and app typechecks.
export const artifactCatalogContract: ArtifactCatalogContract =
  artifactCatalogRuntimeContract;
