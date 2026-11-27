import {
  array,
  enum as zEnum,
  object,
  string,
  url,
  uuid,
  type infer as zInfer,
} from "zod";
import { artifactIdPathParamsSchema } from "../validators/artifact-catalog";
import { hostedSiteShareEmailSchema } from "../validators/hosted-site-sharing";
import { ARTIFACT_CATALOG_KINDS } from "./artifact-catalog";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { hostedSiteShareAccountSchema } from "./hosted-site-sharing";

const c = initContract();

export const ARTIFACT_VISIBILITY_VALUES = [
  "private",
  "organization",
  "public",
] as const;

export const artifactVisibilityValueSchema = zEnum(ARTIFACT_VISIBILITY_VALUES);
export type ArtifactVisibilityValue = zInfer<
  typeof artifactVisibilityValueSchema
>;

export const artifactVisibilityResponseSchema = object({
  artifactId: uuid(),
  kind: zEnum(ARTIFACT_CATALOG_KINDS),
  visibility: artifactVisibilityValueSchema,
  revision: uuid().nullable(),
  ownerUrl: url().nullable(),
  shareUrl: url().nullable(),
  shortUrl: url().nullable(),
  organization: object({
    id: string(),
    name: string(),
  }),
});
export type ArtifactVisibilityResponse = zInfer<
  typeof artifactVisibilityResponseSchema
>;

export const artifactUserShareEntrySchema = object({
  id: string().min(1),
  userId: string().nullable(),
  email: string(),
});
export type ArtifactUserShareEntry = zInfer<
  typeof artifactUserShareEntrySchema
>;

const baseErrors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  500: apiErrorSchema,
};

const limitedErrors = {
  ...baseErrors,
  429: apiErrorSchema,
};

/**
 * Unified Artifact visibility and per-user sharing contract keyed solely by
 * `artifactId`. Shields clients from underlying `file` vs `hosted-site` storage.
 */
export const artifactAccessContract = c.router({
  getVisibility: {
    method: "GET",
    path: "/api/artifacts/:artifactId/visibility",
    pathParams: artifactIdPathParamsSchema,
    headers: authHeadersSchema,
    responses: {
      200: artifactVisibilityResponseSchema,
      ...baseErrors,
    },
    summary: "Read unified visibility state for an owned artifact",
  },
  updateVisibility: {
    method: "PATCH",
    path: "/api/artifacts/:artifactId/visibility",
    pathParams: artifactIdPathParamsSchema,
    headers: authHeadersSchema,
    body: object({
      visibility: artifactVisibilityValueSchema,
      expectedRevision: uuid().nullable().optional(),
    }),
    responses: {
      200: artifactVisibilityResponseSchema,
      409: apiErrorSchema,
      ...baseErrors,
    },
    summary: "Update unified visibility state for an owned artifact",
  },
  listShares: {
    method: "GET",
    path: "/api/artifacts/:artifactId/shares",
    pathParams: artifactIdPathParamsSchema,
    headers: authHeadersSchema,
    responses: {
      200: object({ shares: array(artifactUserShareEntrySchema) }),
      ...baseErrors,
    },
    summary: "List named viewers of an owned artifact",
  },
  searchShareAccounts: {
    method: "GET",
    path: "/api/artifacts/:artifactId/share-accounts",
    pathParams: artifactIdPathParamsSchema,
    headers: authHeadersSchema,
    query: object({ query: string().trim().min(2).max(254) }),
    responses: {
      200: object({ accounts: array(hostedSiteShareAccountSchema) }),
      ...limitedErrors,
    },
    summary: "Search workspace members eligible to receive an artifact share",
  },
  addShare: {
    method: "POST",
    path: "/api/artifacts/:artifactId/shares",
    pathParams: artifactIdPathParamsSchema,
    headers: authHeadersSchema,
    body: object({
      email: hostedSiteShareEmailSchema,
    }),
    responses: {
      200: object({ share: artifactUserShareEntrySchema }),
      ...limitedErrors,
    },
    summary: "Grant a workspace member or invited email access to an artifact",
  },
  removeShare: {
    method: "DELETE",
    path: "/api/artifacts/:artifactId/shares/:shareId",
    pathParams: artifactIdPathParamsSchema.extend({
      shareId: string().min(1),
    }),
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: object({ removed: string().min(1) }),
      ...baseErrors,
    },
    summary: "Revoke a named viewer or email invitation from an artifact",
  },
});
