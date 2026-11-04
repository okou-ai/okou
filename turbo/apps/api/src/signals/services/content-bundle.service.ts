import { command } from "ccstate";
import {
  contentBundleKey,
  prepareContentBundle,
  type ContentBundleFile,
} from "@okouai/core/content-bundle";
import { env } from "../../lib/env";
import { checkS3ObjectExists$, putImmutableS3Object } from "../external/s3";

/** Shared immutable bytes are retained; an unsuccessful publisher must never delete them. */
export const publishContentBundle$ = command(
  async (
    { get, set },
    files: readonly ContentBundleFile[],
    signal: AbortSignal,
  ) => {
    const prepared = await prepareContentBundle(files);
    signal.throwIfAborted();
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const key = contentBundleKey(prepared.descriptor.sha256);
    // Identical content (especially empty Agent instructions) shares one key.
    // Skip existing bytes rather than repeatedly writing a global hot object.
    const exists = await set(checkS3ObjectExists$, bucket, key, signal);
    signal.throwIfAborted();
    if (!exists) {
      await get(
        putImmutableS3Object(
          bucket,
          key,
          prepared.archive,
          "application/gzip",
          signal,
        ),
      );
    }
    signal.throwIfAborted();
    return prepared.descriptor;
  },
);
