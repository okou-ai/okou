import { command } from "ccstate";
import {
  contentBundleKey,
  prepareContentBundle,
  type ContentBundleFile,
} from "@okouai/core/content-bundle";
import { env } from "../../lib/env";
import { putS3Object } from "../external/s3";

/** Shared immutable bytes are retained; an unsuccessful publisher must never delete them. */
export const publishContentBundle$ = command(
  async ({ get }, files: readonly ContentBundleFile[], signal: AbortSignal) => {
    const prepared = await prepareContentBundle(files);
    signal.throwIfAborted();
    await get(
      putS3Object(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        contentBundleKey(prepared.descriptor.sha256),
        prepared.archive,
        "application/gzip",
        signal,
      ),
    );
    signal.throwIfAborted();
    return prepared.descriptor;
  },
);
