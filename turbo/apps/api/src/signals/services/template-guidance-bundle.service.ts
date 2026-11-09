import { command } from "ccstate";
import {
  contentBundleKey,
  type ContentBundleFile,
} from "@okouai/core/content-bundle";
import { prepareTemplateGuidanceBundle } from "@okouai/core/template-guidance-bundle";

import { env } from "../../lib/env";
import { putImmutableS3Object } from "../external/s3";

/** Publish immutable bytes before making a template owner reference them. */
export const publishTemplateGuidanceBundle$ = command(
  async ({ get }, files: readonly ContentBundleFile[], signal: AbortSignal) => {
    const prepared = await prepareTemplateGuidanceBundle(files);
    signal.throwIfAborted();
    await get(
      putImmutableS3Object(
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
