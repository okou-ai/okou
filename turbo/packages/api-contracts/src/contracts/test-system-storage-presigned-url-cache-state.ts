import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const testSystemStoragePresignedUrlCacheStateErrorSchema = z.object({
  error: z.string(),
});

const cacheRowSchema = z.object({
  cache_key: z.string(),
  bucket: z.string(),
  object_key: z.string(),
  storage_version_id: z.string(),
  public_endpoint: z.boolean(),
  ttl_seconds: z.number(),
  presigned_url: z.string(),
  expires_at: z.string(),
  refresh_after: z.string(),
  last_requested_at: z.string(),
});

const storageStateSchema = z.object({
  s3_prefix: z.string(),
  size: z.number(),
  file_count: z.number(),
  head_version_id: z.string().nullable(),
});

const storageVersionStateSchema = z.object({
  version_id: z.string(),
  s3_key: z.string(),
  size: z.number(),
  archive_size: z.number(),
  file_count: z.number(),
  message: z.string().nullable(),
  created_by: z.string(),
});

const ownedStorageSeedSchema = z.object({
  storage_id: z.string().uuid(),
  org_id: z.string(),
  user_id: z.string(),
  storage_name: z.string(),
  s3_prefix: z.string(),
});

const cachePruneResultSchema = z.object({
  pruned: z.number().int().nonnegative(),
});

export const testSystemStoragePresignedUrlCacheStateActionBodySchema =
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal("cleanup"),
      object_key_prefix: z.string(),
    }),
    z.object({
      action: z.literal("claim-owned-storages"),
      storages: z.array(ownedStorageSeedSchema).min(1),
    }),
    z.object({
      action: z.literal("cleanup-owned-storages"),
      storage_ids: z.array(z.string().uuid()).min(1),
    }),
    z.object({
      action: z.literal("read-owned-storage-state"),
      storage_id: z.string().uuid(),
    }),
    z.object({
      action: z.literal("seed-owned-storage-version"),
      storage_id: z.string().uuid(),
      version_id: z.string(),
      s3_key: z.string(),
      archive_size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }),
    z.object({
      action: z.literal("cleanup-owned-storage-cache"),
      storage_id: z.string().uuid(),
    }),
    z.object({
      action: z.literal("seed-owned-storage-cache-row"),
      storage_id: z.string().uuid(),
      storage_version_id: z.string(),
      bucket: z.string(),
      public_endpoint: z.boolean(),
      ttl_seconds: z.number().int().positive(),
      presigned_url: z.string(),
      expires_at: z.string(),
      refresh_after: z.string(),
      last_requested_at: z.string().optional(),
    }),
    z.object({
      action: z.literal("read-owned-storage-cache"),
      storage_id: z.string().uuid(),
    }),
    z.object({
      action: z.literal("prune-owned-storage-cache"),
      storage_id: z.string().uuid(),
    }),
    z.object({
      action: z.literal("read-storage-state"),
      org_id: z.string(),
      user_id: z.string(),
      storage_name: z.string(),
    }),
    z.object({
      action: z.literal("read-storage-version"),
      org_id: z.string(),
      user_id: z.string(),
      storage_name: z.string(),
      version_id: z.string(),
    }),
    z.object({
      action: z.literal("set-storage-version-archive-size"),
      org_id: z.string(),
      user_id: z.string(),
      storage_name: z.string(),
      version_id: z.string(),
      archive_size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
    z.object({
      action: z.literal("read-cache-by-object-key-prefix"),
      object_key_prefix: z.string(),
    }),
  ]);

export const testSystemStoragePresignedUrlCacheStateActionResponseSchema =
  z.object({
    ok: z.literal(true),
    rows: z.array(cacheRowSchema).optional(),
    storage_state: storageStateSchema.nullable().optional(),
    storage_version: storageVersionStateSchema.nullable().optional(),
    cache_prune: cachePruneResultSchema.optional(),
  });

export const testSystemStoragePresignedUrlCacheStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/system-storage-presigned-url-cache-state/action",
    body: testSystemStoragePresignedUrlCacheStateActionBodySchema,
    responses: {
      200: testSystemStoragePresignedUrlCacheStateActionResponseSchema,
      400: testSystemStoragePresignedUrlCacheStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate and read system storage presigned URL cache test state",
  },
});

export type TestSystemStoragePresignedUrlCacheStateContract =
  typeof testSystemStoragePresignedUrlCacheStateContract;
export type TestSystemStoragePresignedUrlCacheStateActionBody = z.infer<
  typeof testSystemStoragePresignedUrlCacheStateActionBodySchema
>;
export type TestSystemStoragePresignedUrlCacheStateActionResponse = z.infer<
  typeof testSystemStoragePresignedUrlCacheStateActionResponseSchema
>;
