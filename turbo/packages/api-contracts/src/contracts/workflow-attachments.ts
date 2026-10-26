import {
  array,
  discriminatedUnion,
  literal,
  number,
  object,
  string,
  uuid,
  url as zUrl,
  type infer as zInfer,
} from "zod";

export const WORKFLOW_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const WORKFLOW_ATTACHMENT_MAX_FILES = 500;
const sha256 = string().regex(/^[a-f0-9]{64}$/u);

export const workflowAttachmentFileSchema = object({
  path: string().min(1).max(256),
  size: number().int().nonnegative(),
  sha256,
}).strict();

/** SQL NULL is reserved for an ordinary Workflow not yet migrated. */
export const workflowAttachmentsSchema = discriminatedUnion("kind", [
  object({ kind: literal("empty") }).strict(),
  object({
    kind: literal("bundle"),
    objectKey: string().regex(
      /^workflow-attachments\/[^/]+\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/archive\.tar\.gz$/u,
    ),
    contentHash: sha256,
    archiveSha256: sha256,
    archiveBytes: number().int().positive(),
    files: array(workflowAttachmentFileSchema)
      .min(1)
      .max(WORKFLOW_ATTACHMENT_MAX_FILES),
  }).strict(),
]);
export type WorkflowAttachments = zInfer<typeof workflowAttachmentsSchema>;

/** Claim-only input. Stage 1 deploys its reader without emitting this field. */
export const workflowSkillDocumentSchema = object({
  workflowId: uuid(),
  mountPath: string().regex(
    /^\/home\/user\/\.(?:claude|codex|pi\/agent)\/skills\/[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/u,
  ),
  skillMd: string(),
  attachments: object({
    archiveUrl: zUrl({ protocol: /^https$/u }).refine((value) => {
      const url = new URL(value);
      return url.username === "" && url.password === "";
    }),
    archiveSize: number().int().positive(),
    archiveSha256: sha256,
  })
    .strict()
    .nullable(),
}).strict();
export type WorkflowSkillDocument = zInfer<typeof workflowSkillDocumentSchema>;
