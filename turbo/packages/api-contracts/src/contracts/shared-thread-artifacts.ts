import {
  literal,
  object,
  record,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { linkLayoutSegmentSchema, type LinkLayoutSegment } from "./link-layout";
import { artifactSharePolicySchema } from "./artifact-shares";

const resourceTokenSchema = string().regex(/^(?:[a-z0-9]{10}|[a-f0-9]{24})$/u);

/** One mutable authority owns every immutable resource in a conversation share. */
export const sharedThreadArtifactPolicySchema = object({
  version: literal(1),
  threadId: uuid(),
  ownerId: string().min(1),
  orgId: string().min(1),
  // Persisted link-layout marker (see link-layout.ts), not product identity.
  publicBrand: linkLayoutSegmentSchema,
  status: zEnum(["preparing", "active", "revoked"]),
  resources: record(
    resourceTokenSchema,
    artifactSharePolicySchema.shape.target,
  ),
  previews: record(
    resourceTokenSchema,
    object({
      token: resourceTokenSchema,
      reference: string().regex(/^[a-z0-9]{10}$/u),
    }),
  ).optional(),
}).superRefine((policy, context) => {
  for (const [token, target] of Object.entries(policy.resources)) {
    const valid =
      target.kind === "file"
        ? target.key.startsWith(
            `private-artifacts/${target.id}/thread-shares/${policy.threadId}/${token}/`,
          )
        : target.snapshotId === policy.threadId &&
          target.id === target.manifest.deploymentId &&
          target.siteId === target.manifest.siteId &&
          policy.publicBrand === target.manifest.publicBrand;
    if (!valid) {
      context.addIssue({
        code: "custom",
        message: "Invalid thread snapshot target",
      });
    }
  }
  for (const [token, preview] of Object.entries(policy.previews ?? {})) {
    const target = policy.resources[preview.token];
    if (
      !policy.resources[token] ||
      target?.kind !== "file" ||
      !target.contentType.startsWith("image/")
    ) {
      context.addIssue({
        code: "custom",
        message: "Invalid thread snapshot preview",
      });
    }
  }
});

export type SharedThreadArtifactPolicy = zInfer<
  typeof sharedThreadArtifactPolicySchema
>;

export function sharedThreadArtifactPolicyKey(
  segment: LinkLayoutSegment,
  threadId: string,
): string {
  return `shared-thread-artifacts/${segment}/${threadId}.json`;
}
