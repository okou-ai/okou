import {
  array,
  boolean,
  coerce,
  intersection,
  literal,
  object,
  record,
  string,
  union,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
import {
  ARTIFACT_CATALOG_CATEGORIES,
  artifactDetailSchema,
  artifactSummarySchema,
  type ArtifactDetail,
} from "./artifact-catalog";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
const artifactIdParams = object({ artifactId: uuid() });
const artifactUrl = string().min(1).max(8192);
export const artifactFavoriteCreateSchema = union([
  object({ artifactId: uuid() }).strict(),
  object({ url: artifactUrl }).strict(),
]);

export const artifactFavoritesListQuerySchema = object({
  limit: coerce.number().int().positive().max(50).optional(),
  cursor: string().max(2048).optional(),
  category: zEnum(ARTIFACT_CATALOG_CATEGORIES).optional(),
  keyword: string().trim().min(1).max(256).optional(),
});

export const artifactFavoriteSchema = object({
  artifactId: uuid(),
  createdAt: string(),
  artifact: artifactSummarySchema.nullable(),
});

export type ArtifactFavorite = zInfer<typeof artifactFavoriteSchema>;
export type ArtifactFavoritesListQuery = zInfer<
  typeof artifactFavoritesListQuerySchema
>;
export type ArtifactFavoriteDetail = ArtifactDetail & { isOwner: boolean };

/** Favorites never confer read access or management of their referenced target. */
export const artifactFavoritesContract = c.router({
  create: {
    method: "POST",
    path: "/api/artifact-favorites",
    headers: authHeadersSchema,
    body: artifactFavoriteCreateSchema,
    responses: {
      200: object({ artifactId: uuid(), favorited: literal(true) }),
      500: apiErrorSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Favorite a currently readable artifact in the current workspace",
  },
  remove: {
    method: "DELETE",
    path: "/api/artifact-favorites/:artifactId",
    headers: authHeadersSchema,
    pathParams: artifactIdParams,
    body: c.noBody(),
    responses: {
      200: object({ artifactId: uuid(), favorited: literal(false) }),
      500: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Remove the caller's favorite even when its target is unavailable",
  },
  list: {
    method: "GET",
    path: "/api/artifact-favorites",
    headers: authHeadersSchema,
    query: artifactFavoritesListQuerySchema,
    responses: {
      200: object({
        favorites: array(artifactFavoriteSchema),
        nextCursor: string().nullable(),
      }),
      500: apiErrorSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List the caller's favorites with current authorized metadata",
  },
  status: {
    method: "GET",
    path: "/api/artifact-favorites/status",
    headers: authHeadersSchema,
    query: object({
      artifactIds: string()
        .max(7400)
        .refine((value) => {
          return array(uuid()).min(1).max(200).safeParse(value.split(","))
            .success;
        }, "Expected between 1 and 200 comma-separated catalog UUIDs"),
    }),
    responses: {
      200: object({ favorites: record(uuid(), boolean()) }),
      500: apiErrorSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Read only the caller's favorite relations for a batch of UUIDs",
  },
  resolve: {
    method: "GET",
    path: "/api/artifact-favorites/resolve",
    headers: authHeadersSchema,
    query: object({ url: artifactUrl }),
    responses: {
      200: object({ artifactId: uuid(), favorited: boolean() }),
      500: apiErrorSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Resolve a supported readable link to its current catalog identity",
  },
  get: {
    method: "GET",
    path: "/api/artifact-favorites/:artifactId",
    headers: authHeadersSchema,
    pathParams: artifactIdParams,
    responses: {
      200: intersection(artifactDetailSchema, object({ isOwner: boolean() })),
      500: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Open the currently readable version without granting owner controls",
  },
});
