import * as z from "zod";

export const WORKFLOW_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const WORKFLOW_ATTACHMENT_MAX_FILES = 500;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const workflowAttachmentFileSchema = z
  .object({
    path: z.string().min(1).max(256),
    size: z.number().int().nonnegative(),
    sha256,
  })
  .strict();

/** SQL NULL is reserved for an ordinary Workflow not yet migrated. */
export const workflowAttachmentsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }).strict(),
  z
    .object({
      kind: z.literal("bundle"),
      objectKey: z
        .string()
        .regex(
          /^workflow-attachments\/[^/]+\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/archive\.tar\.gz$/u,
        ),
      contentHash: sha256,
      archiveSha256: sha256,
      archiveBytes: z.number().int().positive(),
      files: z
        .array(workflowAttachmentFileSchema)
        .min(1)
        .max(WORKFLOW_ATTACHMENT_MAX_FILES),
    })
    .strict(),
]);
export type WorkflowAttachments = z.infer<typeof workflowAttachmentsSchema>;

/** Claim-only input. Stage 1 deploys its reader without emitting this field. */
export const workflowSkillDocumentSchema = z
  .object({
    workflowId: z.uuid(),
    mountPath: z
      .string()
      .regex(
        /^\/home\/user\/\.(?:claude|codex|pi\/agent)\/skills\/[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/u,
      ),
    skillMd: z.string(),
    attachments: z
      .object({
        archiveUrl: z.url({ protocol: /^https$/u }).refine((value) => {
          const url = new URL(value);
          return url.username === "" && url.password === "";
        }),
        archiveSize: z.number().int().positive(),
        archiveSha256: sha256,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type WorkflowSkillDocument = z.infer<typeof workflowSkillDocumentSchema>;
