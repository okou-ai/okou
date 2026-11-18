import { createHash } from "node:crypto";
import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import type { WorkflowAttachments } from "@okouai/api-contracts/contracts/workflow-attachments";
import { readContentBundle } from "./content-bundle";
import { workflowAttachmentMetadata } from "./workflow-attachment-bundle";

export const STAFF_SINGLE_AGENT_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
export const STAFF_WORKFLOW_COPY_NAMESPACE = "staff-single-agent-workflow-v1:";
const INACTIVE_BATCH_WORKFLOW_COPY_NAMESPACE = "inactive-batch-workflow-v1:";

/** Must match the Drizzle migrations and delete_workflow_rows. */
function workflowCopyId(namespace: string, sourceId: string): string {
  const digest = createHash("md5")
    .update(`${namespace}${sourceId}`)
    .digest("hex");
  const hash = `${digest.slice(0, 12)}5${digest.slice(13, 16)}8${digest.slice(17)}`;
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
}

export function staffWorkflowCopyId(sourceId: string): string {
  return workflowCopyId(STAFF_WORKFLOW_COPY_NAMESPACE, sourceId);
}

/**
 * Only the deterministic same-workspace copy can share immutable content.
 * The attachment upload remains independently owned by its source Workflow.
 * Retire after copied Workflows own their descriptors and old Runs have drained.
 */
export function isMigratedWorkflowAttachment(input: {
  readonly orgId: string;
  readonly workflowId: string;
  readonly objectKey: string;
}): boolean {
  const [, orgId, sourceId] =
    /^workflow-attachments\/([^/]+)\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/archive\.tar\.gz$/u.exec(
      input.objectKey,
    ) ?? [];
  const namespace =
    input.orgId === STAFF_SINGLE_AGENT_ORG_ID
      ? STAFF_WORKFLOW_COPY_NAMESPACE
      : INACTIVE_BATCH_WORKFLOW_COPY_NAMESPACE;
  return (
    orgId === input.orgId &&
    sourceId !== undefined &&
    input.workflowId === workflowCopyId(namespace, sourceId)
  );
}

/** Preserve binary bytes and executable modes when an inherited copy is edited. */
export function readMigratedWorkflowAttachments(
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
