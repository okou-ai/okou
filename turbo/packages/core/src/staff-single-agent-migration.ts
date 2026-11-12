import { createHash } from "node:crypto";
import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import type { WorkflowAttachments } from "@okouai/api-contracts/contracts/workflow-attachments";
import { readContentBundle } from "./content-bundle";
import { workflowAttachmentMetadata } from "./workflow-attachment-bundle";

export const STAFF_SINGLE_AGENT_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
export const STAFF_WORKFLOW_COPY_NAMESPACE = "staff-single-agent-workflow-v1:";

/** Must match the staff Drizzle migration's stable source-to-copy identity. */
export function staffWorkflowCopyId(sourceId: string): string {
  const digest = createHash("md5")
    .update(`${STAFF_WORKFLOW_COPY_NAMESPACE}${sourceId}`)
    .digest("hex");
  const hash = `${digest.slice(0, 12)}5${digest.slice(13, 16)}8${digest.slice(17)}`;
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
}

/**
 * Temporary reader for staff copies whose attachment package belongs to the
 * retained source. Only the immutable complete bundle is shared; never adopt or
 * delete the source's independently owned attachment upload. Retire after every
 * copied Workflow has a canonical owned package and old Runs have drained.
 */
export function isStaffCopiedAttachment(input: {
  readonly orgId: string;
  readonly workflowId: string;
  readonly objectKey: string;
}): boolean {
  const match =
    /^workflow-attachments\/([^/]+)\/([a-f0-9-]{36})\/[a-f0-9-]{36}\/archive\.tar\.gz$/u.exec(
      input.objectKey,
    );
  return (
    input.orgId === STAFF_SINGLE_AGENT_ORG_ID &&
    match?.[1] === input.orgId &&
    match[2] !== undefined &&
    input.workflowId === staffWorkflowCopyId(match[2])
  );
}

/** Preserve binary bytes and executable modes when an inherited copy is edited. */
export function readStaffCopiedAttachments(
  archive: Buffer,
  reference: ContentBundle,
  attachments: Extract<WorkflowAttachments, { kind: "bundle" }>,
) {
  const files = readContentBundle(archive, reference).filter((file) => {
    return file.path !== "SKILL.md";
  });
  if (
    JSON.stringify(workflowAttachmentMetadata(files)) !==
    JSON.stringify(attachments.files)
  ) {
    throw new Error(
      "Copied Workflow attachment metadata does not match its content",
    );
  }
  return files;
}
