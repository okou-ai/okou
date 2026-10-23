import { MIMEType } from "node:util";
import { isAllowedUploadType } from "@okouai/core/upload-content-type";
import { safeSync } from "../signals/utils";

export { isAllowedUploadType };

/**
 * Upload limits shared by the presigned-URL prepare endpoint and its callers.
 *
 * The file body never passes through the api runtime — the browser /
 * CLI PUTs straight to R2 using the presigned URL, so we can go all the way
 * up to R2's 5 GB single-PUT ceiling. 1 GB is the policy cap we chose.
 */

export const MAX_UPLOAD_SIZE_BYTES = 1024 * 1024 * 1024;
export const MAX_UPLOAD_SIZE_LABEL = "1 GB";
const GENERIC_UPLOAD_CONTENT_TYPE = "application/octet-stream";

/**
 * Keep recognized MIME types and declared text charsets without inferring the
 * encoding of bytes uploaded directly to storage. Other web uploads remain
 * opaque bytes. Slack canonical assets use isAllowedUploadType as a separate gate.
 */
export function normalizeWebUploadContentType(contentType: string): string {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!isAllowedUploadType(normalized)) {
    return GENERIC_UPLOAD_CONTENT_TYPE;
  }
  if (!normalized.startsWith("text/")) {
    return normalized;
  }

  const result = safeSync(() => {
    const charset = new MIMEType(contentType).params.get("charset");
    if (!charset) {
      return normalized;
    }
    return `${normalized}; charset=${new TextDecoder(charset).encoding}`;
  });
  // Unrecognized parameters retain the existing base-MIME behavior.
  return "ok" in result ? result.ok : normalized;
}
