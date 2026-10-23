import { parseRawRows } from "../../lib/db-raw-rows";
import {
  publicationGenerationReceiptSchema,
  beginPublicationCtesSql,
  publicationFenceFromReceipt,
  workflowPublicationKey,
} from "./storage-publication-fence.service";
import { randomUUID } from "node:crypto";

import { getCustomSkillStorageName } from "@okouai/core/storage-names";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import type { WorkflowUpdateRequest } from "@okouai/api-contracts/contracts/workflows";
import { agents } from "@okouai/db/schema/agent";
import { workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  isStalePublicationFenceError,
  uploadVolumeServerSide$,
} from "./storage-volume-upload.service";
import {
  loadWorkflowVolumeFiles,
  SKILL_FILENAME,
} from "./workflow-volume.service";
import type { WorkflowRow } from "./workflow-data.service";
import { prepareWorkflowAttachments$ } from "./workflow-attachments.service";

interface UpdateWorkflowInput {
  readonly workflow: WorkflowRow;
  readonly body: WorkflowUpdateRequest;
  readonly updatedByUserId: string;
}

const commitWorkflowMetadata$ = command(
  async (
    { set },
    args: UpdateWorkflowInput,
    volumeChanged: boolean,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const { workflow, body } = args;
    // Consume the original parent protection before mutating metadata or its
    // non-FK publication rows. Independent Workflow writes still share it.
    const protectedAgentQuery = db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(eq(agents.id, workflow.agentId), eq(agents.orgId, workflow.orgId)),
      )
      .for("key share")
      .limit(1);
    const protectedAgent = db.$with("protected_agent").as(protectedAgentQuery);
    const values = {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.displayName !== undefined && { displayName: body.displayName }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.instruction !== undefined && { instruction: body.instruction }),
      updatedBy: args.updatedByUserId,
      updatedAt: nowDate(),
    };
    const condition = and(
      eq(workflows.id, workflow.id),
      eq(workflows.orgId, workflow.orgId),
      eq(workflows.agentId, workflow.agentId),
      eq(workflows.ownerUserId, workflow.ownerUserId),
      eq(workflows.visibility, workflow.visibility),
      isNull(workflows.officialDefinitionName),
      gt(db.select({ total: count() }).from(protectedAgent), 0),
    );
    if (!volumeChanged) {
      const [updated] = await db
        .with(protectedAgent)
        .update(workflows)
        .set(values)
        .where(condition)
        .returning({ id: workflows.id });
      signal.throwIfAborted();
      return updated
        ? { updated: true as const, publicationFence: undefined }
        : { updated: false as const };
    }

    const updatedWorkflow = db
      .update(workflows)
      .set(values)
      .where(condition)
      .returning({ id: workflows.id });
    const scope = {
      orgId: workflow.orgId,
      agentId: workflow.agentId,
      ...(workflow.visibility === "private"
        ? { userId: workflow.ownerUserId }
        : {}),
    };
    const key = workflowPublicationKey(workflow.id);
    const token = randomUUID();
    // Both application clocks are sampled before execution. The actual UPDATE
    // gates generation, then token; reading reserved exhausts all their effects.
    const receipts = parseRawRows(
      publicationGenerationReceiptSchema,
      await db.execute(sql`WITH protected_agent AS (${protectedAgentQuery.getSQL()}),
        updated_workflow AS (${updatedWorkflow.getSQL()}),
        ${beginPublicationCtesSql(scope, key, token, nowDate(), sql`updated_workflow`)}
        SELECT generation FROM reserved`),
    );
    const result =
      receipts.length > 0
        ? {
            updated: true as const,
            publicationFence: publicationFenceFromReceipt(
              receipts,
              scope,
              key,
              token,
            ),
          }
        : { updated: false as const };
    signal.throwIfAborted();
    return result;
  },
);

export const updateWorkflow$ = command(
  async (
    { get, set },
    args: UpdateWorkflowInput,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { workflow, body } = args;
    if (workflow.officialDefinitionName !== null) {
      throw new Error("Official Workflow content and structure are read-only");
    }

    const nextName = body.name !== undefined ? body.name : workflow.name;
    const nextInstruction =
      body.instruction !== undefined ? body.instruction : workflow.instruction;
    const nextDescription =
      body.description !== undefined ? body.description : workflow.description;

    const skillChanged =
      body.name !== undefined ||
      body.instruction !== undefined ||
      body.description !== undefined;
    const volumeChanged = body.files !== undefined || skillChanged;
    // Metadata and its pending generation commit together. The later volume
    // transaction may make only this exact generation ready.
    const metadata = await set(
      commitWorkflowMetadata$,
      args,
      volumeChanged,
      signal,
    );
    if (!metadata.updated) {
      return false;
    }

    if (volumeChanged) {
      const sourceFiles =
        body.files ??
        (await get(
          loadWorkflowVolumeFiles({
            orgId: workflow.orgId,
            workflowId: workflow.id,
          }),
        ));
      if (sourceFiles === null) {
        throw new Error(
          "Workflow attachment source is unavailable; provide an explicit file list to replace it",
        );
      }
      const attachedFiles = sourceFiles
        .filter((file) => {
          return file.path !== SKILL_FILENAME;
        })
        .map((file) => {
          return { path: file.path, content: file.content };
        });
      signal.throwIfAborted();

      const skillMd = synthesizeWorkflowSkillMd({
        name: nextName,
        description: nextDescription,
        instruction: nextInstruction,
      });

      const attachments = await set(
        prepareWorkflowAttachments$,
        {
          orgId: workflow.orgId,
          workflowId: workflow.id,
          files: attachedFiles,
          current: workflow.attachments,
        },
        signal,
      );

      const upload = await settle(
        set(
          uploadVolumeServerSide$,
          {
            orgId: workflow.orgId,
            storageName: getCustomSkillStorageName(workflow.id),
            files: [
              { path: SKILL_FILENAME, content: skillMd },
              ...attachedFiles,
            ],
            piResourceIndex: true,
            workflowAttachments: {
              workflowId: workflow.id,
              orgId: workflow.orgId,
              attachments,
            },
            ...(metadata.publicationFence
              ? { publicationFence: metadata.publicationFence }
              : {}),
          },
          signal,
        ),
        signal,
      );
      if (!upload.ok) {
        if (isStalePublicationFenceError(upload.error)) {
          return false;
        }
        throw upload.error;
      }
      signal.throwIfAborted();
    }
    return true;
  },
);
