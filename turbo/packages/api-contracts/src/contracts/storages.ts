import { array, number, object, string, url } from "zod";

/**
 * Maximum file size per file in bytes (100MB).
 */
export const MAX_FILE_SIZE_BYTES = 104_857_600;

/**
 * Maximum file entries accepted in a storage manifest.
 */
export const STORAGE_MANIFEST_MAX_FILES = 50_000;

/**
 * Maximum cumulative UTF-8 path bytes accepted in a storage manifest.
 */
export const STORAGE_MANIFEST_MAX_PATH_BYTES = 8 * 1024 * 1024;

/**
 * File entry with hash for content-addressable storage.
 */
export const fileEntryWithHashSchema = object({
  path: string().min(1, "File path is required"),
  hash: string().length(64, "Hash must be SHA-256 (64 hex chars)"),
  size: number()
    .int()
    .min(0, "Size must be non-negative")
    .max(MAX_FILE_SIZE_BYTES, "File size exceeds 100MB limit"),
});

const storageManifestPathEncoder = new TextEncoder();

/**
 * Bounded file entries for storage prepare and commit manifests.
 */
export const storageManifestFilesSchema = array(fileEntryWithHashSchema)
  .max(
    STORAGE_MANIFEST_MAX_FILES,
    `Storage manifest exceeds ${STORAGE_MANIFEST_MAX_FILES} files`,
  )
  .refine(
    (files) => {
      // The array check already rejects this case. Avoid another linear pass
      // over an arbitrarily oversized request just to report a second issue.
      if (files.length > STORAGE_MANIFEST_MAX_FILES) {
        return true;
      }
      let pathBytes = 0;
      for (const file of files) {
        pathBytes += storageManifestPathEncoder.encode(file.path).byteLength;
        if (pathBytes > STORAGE_MANIFEST_MAX_PATH_BYTES) {
          return false;
        }
      }
      return true;
    },
    {
      message: `Storage manifest paths exceed ${STORAGE_MANIFEST_MAX_PATH_BYTES} UTF-8 bytes`,
    },
  );

/**
 * Incremental changes for partial uploads.
 */
export const storageChangesSchema = object({
  added: array(string()),
  modified: array(string()),
  deleted: array(string()),
});

/**
 * Presigned upload URL.
 */
export const presignedUploadSchema = object({
  key: string(),
  presignedUrl: url(),
});
