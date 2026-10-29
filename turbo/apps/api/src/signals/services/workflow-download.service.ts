import { computed, type Computed } from "ccstate";
import { and, eq, isNull, or } from "drizzle-orm";
import {
  workflowAttachmentsSchema,
  type WorkflowDownload,
} from "@okouai/api-contracts/contracts/workflow-attachments";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { workflows } from "@okouai/db/schema/workflow";
import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import { assertWorkflowAttachmentOwner } from "./workflow-attachment-cleanup.service";

/** Current entity ownership is the authority; claim does not freeze content. */
export function createWorkflowDownload(
  input$: Computed<{
    readonly runId: string;
    readonly authRunId: string;
    readonly workflowId: string;
    readonly userId: string;
    readonly orgId: string;
  }>,
) {
  return computed(async (get): Promise<WorkflowDownload | undefined> => {
    const input = get(input$);
    if (input.authRunId !== input.runId) {
      return undefined;
    }
    const db = get(db$);
    const [workflow] = await db
      .select({
        id: workflows.id,
        name: workflows.name,
        description: workflows.description,
        instruction: workflows.instruction,
        attachments: workflows.attachments,
      })
      .from(workflows)
      .innerJoin(agents, eq(agents.id, workflows.agentId))
      .innerJoin(agentRuns, eq(agentRuns.agentId, workflows.agentId))
      .where(
        and(
          eq(agentRuns.id, input.runId),
          eq(agentRuns.userId, input.userId),
          eq(agentRuns.orgId, input.orgId),
          eq(agentRuns.status, "running"),
          eq(workflows.id, input.workflowId),
          eq(workflows.orgId, input.orgId),
          eq(agents.orgId, input.orgId),
          isNull(workflows.officialDefinitionName),
          or(eq(agents.visibility, "public"), eq(agents.owner, input.userId)),
          or(
            eq(workflows.visibility, "public"),
            eq(workflows.ownerUserId, input.userId),
          ),
        ),
      )
      .limit(1);
    if (!workflow || workflow.attachments === null) {
      return undefined;
    }
    const descriptor = workflowAttachmentsSchema.parse(workflow.attachments);
    let attachments: WorkflowDownload["attachments"] = null;
    if (descriptor.kind === "bundle") {
      assertWorkflowAttachmentOwner(
        input.orgId,
        workflow.id,
        descriptor.objectKey,
      );
      const archiveUrl = await get(
        generatePresignedGetUrl(
          env("R2_USER_STORAGES_BUCKET_NAME"),
          descriptor.objectKey,
        ),
      );
      attachments = {
        archiveUrl,
        archiveSha256: descriptor.archiveSha256,
        archiveSize: descriptor.archiveBytes,
      };
    }
    return {
      workflowId: workflow.id,
      skillMd: synthesizeWorkflowSkillMd(workflow),
      attachments,
    };
  });
}
