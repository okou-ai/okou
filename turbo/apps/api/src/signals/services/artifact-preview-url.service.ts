import { command } from "ccstate";

import { env } from "../../lib/env";
import { generateArtifactPreviewUrl$ } from "../external/s3";
import {
  privateArtifactPreviewPresignedUrlCacheKey,
  resolvePrivateArtifactPreviewPresignedUrls$,
  type PrivateArtifactPreviewPresignedUrlRequest,
} from "./system-storage-presigned-url-cache.service";

/** Call only after resolving the viewer's current access to this object. */
export const resolveArtifactPreviewUrl$ = command(
  async (
    { set },
    args: {
      readonly bucket: string;
      readonly key: string;
      readonly signingDate: Date;
      readonly filename?: string;
    },
    signal: AbortSignal,
  ): Promise<{ readonly url: string; readonly expiresAt: string }> => {
    if (args.bucket !== env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME")) {
      const preview = await set(
        generateArtifactPreviewUrl$,
        args.bucket,
        args.key,
        {
          signingDate: args.signingDate,
          ...(args.filename !== undefined ? { filename: args.filename } : {}),
        },
        signal,
      );
      signal.throwIfAborted();
      return preview;
    }

    const request: PrivateArtifactPreviewPresignedUrlRequest = {
      bucket: args.bucket,
      objectKey: args.key,
      ...(args.filename !== undefined ? { filename: args.filename } : {}),
    };
    const results = await set(
      resolvePrivateArtifactPreviewPresignedUrls$,
      {
        requests: [request],
        issuedAt: args.signingDate,
      },
      signal,
    );
    signal.throwIfAborted();
    const result = results.get(
      privateArtifactPreviewPresignedUrlCacheKey(request),
    );
    if (!result) {
      throw new Error("Private artifact preview URL was not resolved");
    }
    return { url: result.url, expiresAt: result.expiresAt.toISOString() };
  },
);
