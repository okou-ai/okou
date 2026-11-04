import { command } from "ccstate";
import {
  contentBundleKey,
  prepareContentBundle,
  type ContentBundleFile,
} from "@okouai/core/content-bundle";
import { env } from "../../lib/env";
import { putS3Object, s3ObjectExists } from "../external/s3";

/** Shared immutable bytes are retained; an unsuccessful publisher must never delete them. */
export const publishContentBundle$ = command(
  async ({ get }, files: readonly ContentBundleFile[], signal: AbortSignal) => {
    const prepared = await prepareContentBundle(files);
    signal.throwIfAborted();
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const key = contentBundleKey(prepared.descriptor.sha256);
    const exists = await get(s3ObjectExists(bucket, key, signal));
    signal.throwIfAborted();
    // Rewriting shared hashes, especially empty instructions, hits R2's per-key write limit.
    if (!exists) {
      await get(
        putS3Object(bucket, key, prepared.archive, "application/gzip", signal),
      );
    }
    signal.throwIfAborted();
    return prepared.descriptor;
  },
);
