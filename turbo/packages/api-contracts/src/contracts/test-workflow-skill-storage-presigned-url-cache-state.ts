import { z } from "zod";

import { initContract } from "./base";

const c = initContract();
const cacheScopeSchema = z.enum(["workflow_skill_storage", "readonly_storage"]);

const testWorkflowSkillStoragePresignedUrlCacheStateErrorSchema = z.object({
  error: z.string(),
});

const cacheRowSchema = z.object({
  cache_key: z.string(),
  bucket: z.string(),
  object_key: z.string(),
  storage_version_id: z.string(),
  resolved_org_id: z.string(),
  public_endpoint: z.boolean(),
  ttl_seconds: z.number(),
  presigned_url: z.string(),
  expires_at: z.string(),
  refresh_after: z.string(),
  last_requested_at: z.string(),
});

export const testWorkflowSkillStoragePresignedUrlCacheStateActionBodySchema =
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal("cleanup"),
      object_key_prefix: z.string(),
      scope: cacheScopeSchema.optional(),
    }),
    z.object({
      action: z.literal("read-cache-by-object-key-prefix"),
      object_key_prefix: z.string(),
      scope: cacheScopeSchema.optional(),
    }),
  ]);

export const testWorkflowSkillStoragePresignedUrlCacheStateActionResponseSchema =
  z.object({
    ok: z.literal(true),
    rows: z.array(cacheRowSchema).optional(),
  });

export const testWorkflowSkillStoragePresignedUrlCacheStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/workflow-skill-storage-presigned-url-cache-state/action",
    body: testWorkflowSkillStoragePresignedUrlCacheStateActionBodySchema,
    responses: {
      200: testWorkflowSkillStoragePresignedUrlCacheStateActionResponseSchema,
      400: testWorkflowSkillStoragePresignedUrlCacheStateErrorSchema,
      404: z.string(),
    },
    summary:
      "Mutate and read workflow skill storage presigned URL cache test state",
  },
});

export type TestWorkflowSkillStoragePresignedUrlCacheStateContract =
  typeof testWorkflowSkillStoragePresignedUrlCacheStateContract;
export type TestWorkflowSkillStoragePresignedUrlCacheStateActionBody = z.infer<
  typeof testWorkflowSkillStoragePresignedUrlCacheStateActionBodySchema
>;
export type TestWorkflowSkillStoragePresignedUrlCacheStateActionResponse =
  z.infer<
    typeof testWorkflowSkillStoragePresignedUrlCacheStateActionResponseSchema
  >;
