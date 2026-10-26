import * as z from "zod/mini";

export const HOSTED_SITE_FILES_PATH = "/.okou/files";
export const HOSTED_SITE_FILE_DOWNLOAD_PATH = "/.okou/download";

/** Same-origin download metadata, returned only after current Site authorization. */
export const hostedSiteDownloadManifestSchema = z.object({
  publicSlug: z.string().check(z.minLength(1)),
  files: z
    .array(
      z.object({
        path: z.string().check(z.startsWith("/")),
        contentType: z.string(),
        downloadUrl: z.url(),
      }),
    )
    .check(z.minLength(1)),
});
