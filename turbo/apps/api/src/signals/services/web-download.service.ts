import { createHash } from "node:crypto";
import { computed, type Computed } from "ccstate";

import { recordWebDownloadFailure$, request$ } from "../context/hono";
import { downloadS3Buffer } from "../external/s3";
import { uploadedArtifactObject } from "./uploaded-artifact.service";

interface DownloadFileResult {
  readonly buffer: Buffer;
  readonly contentType: string;
  readonly filename: string;
  readonly isPrivate: boolean;
}

/**
 * Locate and download a user-owned file by its file ID and owning user.
 * Returns null when no matching S3 object exists.
 */
export function webDownloadFile(
  fileId: string,
  userId: string,
  orgId?: string,
): Computed<Promise<DownloadFileResult | null>> {
  return computed(async (get): Promise<DownloadFileResult | null> => {
    const object = await get(
      uploadedArtifactObject({ userId, orgId, id: fileId }),
    );
    if (!object) {
      return null;
    }

    const request = get(request$);
    const recordFailure = get(recordWebDownloadFailure$);
    const buffer = await get(
      downloadS3Buffer(object.bucket, object.key, {
        onFailure: (diagnostics) => {
          recordFailure({
            ...diagnostics,
            storageScope: object.isPrivate
              ? "private_artifact"
              : "user_artifact",
            objectFingerprint: createHash("sha256")
              .update(object.bucket)
              .update("\0")
              .update(object.key)
              .digest("hex"),
            objectSize: object.size,
            requestAborted: request.raw.signal.aborted,
          });
        },
      }),
    );

    return {
      buffer,
      contentType: object.contentType,
      filename: object.filename,
      isPrivate: object.isPrivate,
    };
  });
}
