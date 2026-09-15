import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
const audienceSchema = z.enum(["private", "organization", "public"]);
export const artifactShareTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), id: z.uuid() }),
  z.object({ kind: z.literal("html"), id: z.uuid() }),
]);
export type ArtifactShareTarget = z.infer<typeof artifactShareTargetSchema>;

// This versioned object is authoritative, not a cache of a database boolean.
// Keep its schema usable by both the API and the isolated delivery Worker.
export const artifactSharePolicySchema = z
  .object({
    version: z.literal(1),
    revision: z.uuid(),
    shareId: z.uuid(),
    ownerId: z.string().min(1),
    orgId: z.string().min(1),
    publicBrand: z.enum(["vm0", "okou"]),
    // Absent only on persisted shares from before the delivery registry.
    delivery: z.literal("artifact-registry-v1").optional(),
    organizationReference: z
      .string()
      .regex(/^[a-z0-9]{10}$/u)
      .optional(),
    publicSlug: z
      .string()
      .max(63)
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u)
      .optional(),
    audience: audienceSchema,
    status: z.enum(["active", "revoked"]),
    publicToken: z
      .string()
      .regex(/^[a-f0-9]{24}$/u)
      .nullable(),
    target: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("file"),
        id: z.uuid(),
        key: z.string().startsWith("private-artifacts/"),
        filename: z.string().min(1),
        contentType: z.string().min(1),
      }),
      z.object({
        kind: z.literal("html"),
        id: z.uuid(),
        siteId: z.uuid(),
        snapshotId: z.uuid(),
        deploymentVersion: z.number().int().positive(),
        manifest: z.object({
          version: z.literal(1),
          access: z.literal("owner-private-v1"),
          publicBrand: z.enum(["vm0", "okou"]),
          deploymentId: z.uuid(),
          siteId: z.uuid(),
          publicSlug: z.string(),
          createdAt: z.string(),
          spaFallback: z.boolean(),
          files: z.record(
            z.string(),
            z.object({
              path: z.string(),
              size: z.number().nonnegative(),
              sha256: z.string(),
              contentType: z.string(),
              immutable: z.boolean().optional(),
            }),
          ),
        }),
      }),
    ]),
  })
  .superRefine((policy, ctx) => {
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
export type ArtifactSharePolicy = z.infer<typeof artifactSharePolicySchema>;

const statusSchema = z.object({
  shareId: z.uuid().nullable(),
  audience: audienceSchema,
  organization: z.object({ id: z.string(), name: z.string() }),
  selectedTarget: artifactShareTargetSchema.nullable(),
  selectedVersion: z.number().nullable(),
  candidateVersion: z.number().nullable(),
  url: z.url().nullable(),
  // Optional until pre-short-reference APIs have drained. `url` remains
  // readable by already-open App bundles during API-first deployment.
  shortUrl: z.url().nullable().optional(),
});
export type ArtifactShareStatus = z.infer<typeof statusSchema>;

const errors = {
  500: apiErrorSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
};
export const artifactSharesContract = c.router({
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
    body: z.object({
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
    pathParams: z.object({ id: z.uuid() }),
    responses: {
      200: z.object({ url: z.url(), expiresAt: z.string() }),
      ...errors,
    },
    summary:
      "Authorize a share recipient and return temporary direct content delivery",
  },
});
