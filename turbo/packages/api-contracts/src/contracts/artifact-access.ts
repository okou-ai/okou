import {
  array,
  enum as zEnum,
  number,
  object,
  string,
  union,
  url,
  uuid,
  type infer as zInfer,
} from "zod";
import { artifactShareEmailSchema } from "../validators/artifact-access";
import { artifactIdPathParamsSchema } from "../validators/artifact-catalog";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

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

export const ARTIFACT_ACCESS_KINDS = [
  "file",
  "hosted-site",
  "image",
  "avatar",
  "presentation",
  "shared-thread",
] as const;

export const artifactAccessKindSchema = zEnum(ARTIFACT_ACCESS_KINDS);
export type ArtifactAccessKind = zInfer<typeof artifactAccessKindSchema>;

export const artifactVisibilityResponseSchema = object({
  artifactId: uuid(),
  kind: artifactAccessKindSchema,
  visibility: artifactVisibilityValueSchema,
  ownerUrl: url(),
  shareUrl: url().nullable(),
  shortUrl: url().nullable(),
  deploymentVersion: number().int().nullable().optional(),
  organization: object({
    id: string(),
    name: string(),
  }),
});
export type ArtifactVisibilityResponse = zInfer<
  typeof artifactVisibilityResponseSchema
>;

export const artifactShareAccountSchema = object({
  userId: string().min(1),
  email: artifactShareEmailSchema,
  name: string().nullable(),
});
export type ArtifactShareAccount = zInfer<typeof artifactShareAccountSchema>;

export const artifactUserShareEntrySchema = object({
  userId: string().min(1),
  email: string(),
  name: string().nullable().optional(),
});
export type ArtifactUserShareEntry = zInfer<
  typeof artifactUserShareEntrySchema
>;

export const addArtifactShareBodySchema = union([
  object({
    userId: string().trim().min(1),
  }),
  object({
    email: artifactShareEmailSchema,
  }),
]);
export type AddArtifactShareBody = zInfer<typeof addArtifactShareBodySchema>;

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
 * `artifactId` and workspace member `userId`. Shields clients from underlying
 * `file` vs `hosted-site` storage.
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
    summary: "List workspace members shared on an owned artifact",
  },
  searchShareAccounts: {
    method: "GET",
    path: "/api/artifacts/:artifactId/share-accounts",
    pathParams: artifactIdPathParamsSchema,
    headers: authHeadersSchema,
    query: object({ query: string().trim().min(2).max(254) }),
    responses: {
      200: object({ accounts: array(artifactShareAccountSchema) }),
      ...limitedErrors,
    },
    summary: "Search workspace members eligible to receive an artifact share",
  },
  addShare: {
    method: "POST",
    path: "/api/artifacts/:artifactId/shares",
    pathParams: artifactIdPathParamsSchema,
    headers: authHeadersSchema,
    body: addArtifactShareBodySchema,
    responses: {
      200: object({ share: artifactUserShareEntrySchema }),
      ...limitedErrors,
    },
    summary: "Grant a workspace member access to an owned artifact",
  },
  removeShare: {
    method: "DELETE",
    path: "/api/artifacts/:artifactId/shares/:userId",
    pathParams: artifactIdPathParamsSchema.extend({
      userId: string().trim().min(1),
    }),
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: object({ removed: string().min(1) }),
      ...baseErrors,
    },
    summary: "Revoke a workspace member's access from an owned artifact",
  },
});

export { artifactShareEmailSchema };
