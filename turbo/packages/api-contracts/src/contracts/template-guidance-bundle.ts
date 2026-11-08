import {
  array,
  enum as zEnum,
  number,
  object,
  string,
  uuid,
  type infer as zInfer,
} from "zod";

export const MAX_TEMPLATE_GUIDANCE_CONTENT_BYTES = 100 * 1024 * 1024;
export const MAX_TEMPLATE_GUIDANCE_FILES = 200;
export const MAX_TEMPLATE_GUIDANCE_FILE_BYTES = 25 * 1024 * 1024;
// 200 POSIX paths (at most 4095 bytes each), PAX headers and file padding fit
// within 2 MiB. A further MiB covers gzip's worst-case framing/deflate overhead.
export const MAX_TEMPLATE_GUIDANCE_TAR_BYTES = 102 * 1024 * 1024;
export const MAX_TEMPLATE_GUIDANCE_ARCHIVE_BYTES = 103 * 1024 * 1024;

export const templateGuidanceBundleSchema = object({
  sha256: string().regex(/^[a-f0-9]{64}$/u),
  archiveBytes: number()
    .int()
    .positive()
    .max(MAX_TEMPLATE_GUIDANCE_ARCHIVE_BYTES),
}).strict();
export type TemplateGuidanceBundle = zInfer<
  typeof templateGuidanceBundleSchema
>;

/** The owner, not a caller-provided mount path, selects the template directory. */
export const storedTemplateGuidanceBundleSchema = templateGuidanceBundleSchema
  .extend({
    ownerKind: zEnum(["user-template", "presentation-template"]),
    templateId: uuid(),
    // Keep overlay precedence when bundle and legacy Storage mounts coexist.
    // Missing optional legacy mounts are skipped when selecting the next anchor.
    beforeMountPaths: array(string()),
  })
  .strict();
export type StoredTemplateGuidanceBundle = zInfer<
  typeof storedTemplateGuidanceBundleSchema
>;

export function templateGuidanceMountPath(
  reference: Pick<StoredTemplateGuidanceBundle, "ownerKind" | "templateId">,
): string {
  const directory =
    reference.ownerKind === "user-template"
      ? "user-template"
      : "presentation-template";
  return `/home/user/workspace/generated/${directory}/${reference.templateId}`;
}
