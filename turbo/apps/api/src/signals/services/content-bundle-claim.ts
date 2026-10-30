import { between, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { command } from "ccstate";
import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import { contentBundleKey } from "@okouai/core/content-bundle";
import { env } from "../../lib/env";
import { signPresignedGetUrl$ } from "../external/s3";

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

/** Fresh local signatures do not read or publish R2 content during claim. */
export const signClaimedContentBundle$ = command(
  async ({ set }, reference: ContentBundle, signal: AbortSignal) => {
    signal.throwIfAborted();
    const downloadUrl = await set(signPresignedGetUrl$, {
      bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
      key: contentBundleKey(reference.sha256),
      publicEndpoint: false,
    });
    signal.throwIfAborted();
    return { ...reference, downloadUrl };
  },
);
