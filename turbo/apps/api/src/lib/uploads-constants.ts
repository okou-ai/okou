import { MIMEType } from "node:util";
import { safeSync } from "../signals/utils";

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

const ALLOWED_UPLOAD_TYPES: Readonly<Set<string>> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "image/bmp",
  "image/heic",
  "image/heif",
  "image/tiff",
  "image/vnd.adobe.photoshop",
  "image/x-photoshop",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/aac",
  "audio/flac",
  "audio/m4a",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/mpga",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/wave",
  "audio/webm",
  "audio/x-m4a",
  "audio/x-wav",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "text/tab-separated-values",
  "text/xml",
  "text/yaml",
  "text/x-yaml",
  "application/epub+zip",
  "application/gzip",
  "application/illustrator",
  "application/json",
  "application/postscript",
  "application/msword",
  "application/rtf",
  "application/vnd.adobe.illustrator",
  "application/vnd.apache.parquet",
  "application/vnd.apple.keynote",
  "application/vnd.apple.numbers",
  "application/vnd.apple.pages",
  "text/rtf",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.ms-excel.template.macroenabled.12",
  "application/vnd.ms-powerpoint",
  "application/vnd.ms-powerpoint.presentation.macroenabled.12",
  "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
  "application/vnd.ms-powerpoint.template.macroenabled.12",
  "application/vnd.ms-word.document.macroenabled.12",
  "application/vnd.ms-word.template.macroenabled.12",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  "application/vnd.openxmlformats-officedocument.presentationml.template",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  "application/vnd.rar",
  "application/vnd.sqlite3",
  "application/x-7z-compressed",
  "application/x-bzip2",
  "application/x-gzip",
  "application/x-iwork-keynote-sffkey",
  "application/x-iwork-numbers-sffnumbers",
  "application/x-iwork-pages-sffpages",
  "application/x-parquet",
  "application/x-photoshop",
  "application/x-rar-compressed",
  "application/x-sqlite3",
  "application/x-tar",
  "application/x-xz",
  "application/x-yaml",
  "application/x-zip-compressed",
  "application/xml",
  "application/yaml",
  "application/zip",
]);

export function isAllowedUploadType(contentType: string): boolean {
  return ALLOWED_UPLOAD_TYPES.has(contentType);
}

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
