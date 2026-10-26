import { array, minLength, object, startsWith, string, url } from "zod/mini";

export const HOSTED_SITE_FILES_PATH = "/.okou/files";
export const HOSTED_SITE_FILE_DOWNLOAD_PATH = "/.okou/download";

/** Same-origin download metadata, returned only after current Site authorization. */
export const hostedSiteDownloadManifestSchema = object({
  publicSlug: string().check(minLength(1)),
  files: array(
    object({
      path: string().check(startsWith("/")),
      contentType: string(),
      downloadUrl: url(),
    }),
  ).check(minLength(1)),
});
