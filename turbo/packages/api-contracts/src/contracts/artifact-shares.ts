import {
  boolean,
  discriminatedUnion,
  literal,
  number,
  object,
  record,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { artifactShareTargetSchema } from "../validators/artifact-shares";
import { linkLayoutSegmentSchema } from "./link-layout";

const audienceSchema = zEnum(["private", "organization", "public"]);
export { artifactShareTargetSchema };
export type ArtifactShareTarget = zInfer<typeof artifactShareTargetSchema>;

// Versioned R2 policy schema for read-only historical `/share/artifacts/:id`
// link resolution and the isolated delivery Worker. The legacy HTTP routes were
// retired in Release 2.
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
