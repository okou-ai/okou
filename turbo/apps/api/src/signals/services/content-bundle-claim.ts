import { between, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { command } from "ccstate";
import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import { presignedGetUrlSignerForBucket } from "../external/s3";
import {
  contentBundleUrlCacheRequest,
  type ContentBundleUrlCacheContext,
} from "./content-bundle-presigned-url-cache";
import {
  signStoragePresignedUrls,
  type StoragePresignedUrlCacheWrite,
} from "./system-storage-presigned-url-cache.service";

/** Match contentBundleSchema before the atomic claim consumes its queued Run. */
export function contentBundleAvailableCondition(reference: SQLWrapper): SQL {
  const archiveBytes = sql`(${reference}->>'archiveBytes')::numeric`;
  return sql`CASE WHEN
    jsonb_typeof(${reference}) = 'object'
    AND jsonb_typeof(${reference}->'sha256') = 'string'
    AND (${reference}->>'sha256') ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(${reference}->'archiveBytes') = 'number'
  THEN (${reference} - 'sha256' - 'archiveBytes') = '{}'::jsonb
    AND ${between(archiveBytes, 1, 32 * 1024 * 1024)}
    AND ${eq(archiveBytes, sql`trunc(${archiveBytes})`)}
  ELSE false END`;
}

export interface ClaimedContentBundleSignature {
  readonly bundle: ContentBundle & { readonly downloadUrl: string };
  readonly cacheWrite: StoragePresignedUrlCacheWrite | undefined;
}

/** Reuse only the successful claim's snapshot; sign misses without R2 I/O. */
export const signClaimedContentBundle$ = command(
  async (
    { get },
    args: {
      readonly reference: ContentBundle;
      readonly cache: ContentBundleUrlCacheContext;
      readonly cached:
        { readonly url: string; readonly expiresAtMs: number } | undefined;
    },
    signal: AbortSignal,
  ): Promise<ClaimedContentBundleSignature> => {
    signal.throwIfAborted();
    const request = contentBundleUrlCacheRequest(
      args.cache,
      args.reference.sha256,
    );
    const signed = await signStoragePresignedUrls({
      requests: [request],
      rows: args.cached
        ? [
            {
              cacheKey: request.cacheKey,
              presignedUrl: args.cached.url,
              expiresAt: new Date(args.cached.expiresAtMs),
            },
          ]
        : [],
      sign: get(presignedGetUrlSignerForBucket(args.cache.bucket, false)),
    });
    signal.throwIfAborted();
    const result = signed.results.get(request.cacheKey);
    if (!result) {
      throw new Error("Claimed Content Bundle URL is missing");
    }
    return {
      bundle: { ...args.reference, downloadUrl: result.url },
      cacheWrite: signed.freshValues[0],
    };
  },
);
