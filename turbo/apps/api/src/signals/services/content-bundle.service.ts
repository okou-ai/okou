import { command } from "ccstate";
import {
  contentBundleKey,
  prepareContentBundle,
  type ContentBundleFile,
} from "@okouai/core/content-bundle";
import { env } from "../../lib/env";
import { PRIVATE_NO_STORE_CACHE_CONTROL } from "@okouai/api-contracts/contracts/artifact-cache";
import { putImmutableS3Object, s3ObjectExists } from "../external/s3";

/** Shared immutable bytes are retained; an unsuccessful publisher must never delete them. */
export const publishContentBundle$ = command(
  async ({ get }, files: readonly ContentBundleFile[], signal: AbortSignal) => {
    const prepared = await prepareContentBundle(files);
    signal.throwIfAborted();
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const key = contentBundleKey(prepared.descriptor.sha256);
    // Identical content (especially empty Agent instructions) shares one key.
    // Skip existing bytes rather than repeatedly writing a global hot object.
    const exists = await get(s3ObjectExists(bucket, key, signal));
    signal.throwIfAborted();
    if (!exists) {
      await get(
        putImmutableS3Object(
          bucket,
          key,
          prepared.archive,
          "application/gzip",
          {
            signal,
            cacheControl: PRIVATE_NO_STORE_CACHE_CONTROL,
          },
        ),
      );
    }
    signal.throwIfAborted();
    return prepared.descriptor;
  },
);
