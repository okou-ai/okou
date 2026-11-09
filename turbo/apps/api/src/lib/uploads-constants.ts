import { MIMEType } from "node:util";
import { isAllowedUploadType } from "@okouai/core/upload-content-type";
import { safeSync } from "../signals/utils";
import { MAX_ATTACHMENT_UPLOAD_BYTES } from "@okouai/core/upload-limits";

export { isAllowedUploadType };

/**
 * Upload limits shared by the presigned-URL prepare endpoint and its callers.
 *
 * The file body never passes through the api runtime — the browser /
 * CLI PUTs straight to R2 using the presigned URL. Large browser attachments
 * use multipart uploads with a bounded part count.
 */

export const MAX_UPLOAD_SIZE_BYTES = MAX_ATTACHMENT_UPLOAD_BYTES;
export const MAX_UPLOAD_SIZE_LABEL = "5 GB";
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
