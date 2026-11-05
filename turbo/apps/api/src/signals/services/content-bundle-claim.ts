import { between, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { command } from "ccstate";
import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import { contentBundleKey } from "@okouai/core/content-bundle";
import { signPresignedGetUrl$ } from "../external/s3";
import { now } from "../../lib/time";
import {
  CONTENT_BUNDLE_URL_MIN_REMAINING_MS,
  type ContentBundleUrlCacheWrite,
  type ContentBundleUrlCacheContext,
} from "./content-bundle-presigned-url-cache";

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
  readonly cacheWrite: ContentBundleUrlCacheWrite | undefined;
}

/** Reuse only the successful claim's snapshot; sign misses without R2 I/O. */
export const signClaimedContentBundle$ = command(
  async (
    { set },
    args: {
      readonly reference: ContentBundle;
      readonly cache: ContentBundleUrlCacheContext;
      readonly cached:
        { readonly url: string; readonly expiresAtMs: number } | undefined;
    },
    signal: AbortSignal,
  ): Promise<ClaimedContentBundleSignature> => {
    signal.throwIfAborted();
    if (
      args.cached &&
      args.cached.expiresAtMs - now() >= CONTENT_BUNDLE_URL_MIN_REMAINING_MS
    ) {
      return {
        bundle: { ...args.reference, downloadUrl: args.cached.url },
        cacheWrite: undefined,
      };
    }
    const issuedAt = new Date(Math.floor(now() / 1000) * 1000);
    const downloadUrl = await set(signPresignedGetUrl$, {
      bucket: args.cache.bucket,
      key: contentBundleKey(args.reference.sha256),
      publicEndpoint: false,
      signingDate: issuedAt,
    });
    signal.throwIfAborted();
    return {
      bundle: { ...args.reference, downloadUrl },
      cacheWrite: { sha256: args.reference.sha256, url: downloadUrl, issuedAt },
    };
  },
);
