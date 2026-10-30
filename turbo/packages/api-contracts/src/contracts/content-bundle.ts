import {
  array,
  literal,
  number,
  object,
  string,
  url,
  type infer as zInfer,
} from "zod";

/** Digest of the complete canonical tar.gz bytes, independent of entity identity. */
export const contentBundleSchema = object({
  sha256: string().regex(/^[a-f0-9]{64}$/u),
  archiveBytes: number()
    .int()
    .positive()
    .max(32 * 1024 * 1024),
}).strict();
export type ContentBundle = zInfer<typeof contentBundleSchema>;

const contentBundleDownloadSchema = contentBundleSchema
  .extend({
    downloadUrl: url({ protocol: /^https$/u }).refine((value) => {
      const parsed = new URL(value);
      return parsed.username === "" && parsed.password === "";
    }),
  })
  .strict();

/** Prepared reader only: the API activates this section in a later release. */
export const claimedContentBundlesSchema = object({
  format: literal("tar-gzip-v1"),
  instructions: contentBundleDownloadSchema.optional(),
  skills: array(
    contentBundleDownloadSchema
      .extend({
        mountPath: string().regex(
          /^\/home\/user\/\.(?:claude|codex|pi\/agent)\/skills\/[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/u,
        ),
      })
      .strict(),
  ),
}).strict();
