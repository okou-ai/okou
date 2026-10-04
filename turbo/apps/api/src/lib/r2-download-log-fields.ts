import {
  associateR2DownloadError,
  type R2DownloadLogFields,
} from "@okouai/core/log-utils";
import { onRejection } from "../signals/utils";

export function withR2DownloadLogFields<T>(
  operation: Promise<T>,
  fields: R2DownloadLogFields,
): Promise<T> {
  return onRejection(operation, (error) => {
    const bounded =
      fields.r2_bucket.length >= 3 &&
      fields.r2_bucket.length <= 63 &&
      fields.r2_key.length > 0 &&
      Buffer.byteLength(fields.r2_key, "utf8") <= 1024;
    associateR2DownloadError(error, bounded ? fields : null);
  });
}
