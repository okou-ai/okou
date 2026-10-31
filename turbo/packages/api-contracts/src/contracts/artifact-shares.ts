import {
  boolean,
  discriminatedUnion,
  literal,
  number,
  object,
  record,
  string,
  url,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { artifactShareTargetSchema } from "../validators/artifact-shares";
import { linkLayoutSegmentSchema } from "./link-layout";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
const audienceSchema = zEnum(["private", "organization", "public"]);
export { artifactShareTargetSchema };
export type ArtifactShareTarget = zInfer<typeof artifactShareTargetSchema>;

// This versioned object is authoritative, not a cache of a database boolean.
// Keep its schema usable by both the API and the isolated delivery Worker.
export const artifactSharePolicySchema = object({
  version: literal(1),
  revision: uuid(),
  shareId: uuid(),
  ownerId: string().min(1),
  orgId: string().min(1),
  // Persisted link-layout marker (see link-layout.ts), not product identity.
  publicBrand: linkLayoutSegmentSchema,
  // Absent only on persisted shares from before the delivery registry.
  delivery: literal("artifact-registry-v1").optional(),
  // Existing shared links/policies remain valid until an explicit owner
  // update allocates aliases. #32492 owns any later durable-link retirement.
  organizationReference: string()
    .regex(/^[a-z0-9]{10}$/u)
    .optional(),
  publicSlug: string()
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u)
    .optional(),
  audience: audienceSchema,
  status: zEnum(["active", "revoked"]),
  publicToken: string()
    .regex(/^(?:[a-z0-9]{10}|[a-f0-9]{24})$/u)
    .nullable(),
  target: discriminatedUnion("kind", [
    object({
      kind: literal("file"),
      id: uuid(),
      key: string().startsWith("private-artifacts/"),
      filename: string().min(1),
      contentType: string().min(1),
    }),
    object({
      kind: literal("html"),
      id: uuid(),
      siteId: uuid(),
      snapshotId: uuid(),
      deploymentVersion: number().int().positive(),
      manifest: object({
        version: literal(1),
        access: literal("owner-private-v1"),
        publicBrand: linkLayoutSegmentSchema,
        deploymentId: uuid(),
        siteId: uuid(),
        publicSlug: string(),
        createdAt: string(),
        spaFallback: boolean(),
        files: record(
          string(),
          object({
            path: string(),
            size: number().nonnegative(),
            sha256: string(),
            contentType: string(),
            immutable: boolean().optional(),
          }),
        ),
      }),
    }),
  ]),
}).superRefine((policy, ctx) => {
  if (
    (policy.audience === "private") !== (policy.status === "revoked") ||
    (policy.audience === "public") !== (policy.publicToken !== null)
  ) {
    ctx.addIssue({ code: "custom", message: "Inconsistent sharing policy" });
  }
  const target = policy.target;
  if (
    target.kind === "html" &&
    (target.id !== target.manifest.deploymentId ||
      target.siteId !== target.manifest.siteId ||
      policy.publicBrand !== target.manifest.publicBrand)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Inconsistent shared deployment",
    });
  }
  if (
    target.kind === "file" &&
    !target.key.startsWith(`private-artifacts/${target.id}/`)
  ) {
    ctx.addIssue({ code: "custom", message: "Inconsistent shared file" });
  }
});
export type ArtifactSharePolicy = zInfer<typeof artifactSharePolicySchema>;

const statusSchema = object({
  // Stable owner reference for the requested version, independent of sharing.
  ownerUrl: url(),
  shareId: uuid().nullable(),
  audience: audienceSchema,
  organization: object({ id: string(), name: string() }),
  selectedTarget: artifactShareTargetSchema.nullable(),
  selectedVersion: number().nullable(),
  candidateVersion: number().nullable(),
  // Organization shares return the same short reference in both URL fields.
  url: url().nullable(),
  shortUrl: url().nullable(),
});
export type ArtifactShareStatus = zInfer<typeof statusSchema>;

const errors = {
  500: apiErrorSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
};
export const artifactSharesContract = c.router({
  availability: {
    method: "GET",
    path: "/api/artifact-shares/availability",
    headers: authHeadersSchema,
    responses: { 200: object({ enabled: boolean() }), ...errors },
    summary: "Read whether private artifact creation is currently available",
  },
  status: {
    method: "POST",
    path: "/api/artifact-shares/status",
    headers: authHeadersSchema,
    body: artifactShareTargetSchema,
    responses: { 200: statusSchema, ...errors },
    summary: "Read sharing state without creating a grant",
  },
  update: {
    method: "PUT",
    path: "/api/artifact-shares",
    headers: authHeadersSchema,
    body: object({
      target: artifactShareTargetSchema,
      audience: audienceSchema,
    }),
    responses: { 200: statusSchema, ...errors },
    summary: "Explicitly share a selected artifact version or stop sharing",
  },
  resolve: {
    method: "GET",
    path: "/api/artifact-shares/:id/resolve",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    responses: {
      200: object({ url: url(), expiresAt: string() }),
      ...errors,
    },
    summary:
      "Authorize a share recipient and return temporary direct content delivery",
  },
});
