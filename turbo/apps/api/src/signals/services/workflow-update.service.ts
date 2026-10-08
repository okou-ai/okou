import { parseRawRows } from "../../lib/db-raw-rows";
import {
  publicationGenerationReceiptSchema,
  beginPublicationSql,
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
import { and, eq, isNull } from "drizzle-orm";

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
    const result = await db.transaction(async (tx) => {
      // Metadata and its pending generation must commit atomically so a later
      // upload can publish only the generation belonging to this source update.
      // Keep the parent alive until the source and its non-FK generation commit.
      // Independent Workflow writes can share this parent protection.
      const [agent] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.id, workflow.agentId),
            eq(agents.orgId, workflow.orgId),
          ),
        )
        .for("key share")
        .limit(1);
      if (!agent) {
        return { updated: false as const };
      }
      const [updated] = await tx
        .update(workflows)
        .set({
          ...(body.name !== undefined && { name: body.name }),
          ...(body.displayName !== undefined && {
            displayName: body.displayName,
          }),
          ...(body.description !== undefined && {
            description: body.description,
          }),
          ...(body.instruction !== undefined && {
            instruction: body.instruction,
          }),
          updatedBy: args.updatedByUserId,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(workflows.id, workflow.id),
            eq(workflows.orgId, workflow.orgId),
            eq(workflows.agentId, workflow.agentId),
            eq(workflows.ownerUserId, workflow.ownerUserId),
            eq(workflows.visibility, workflow.visibility),
            isNull(workflows.officialDefinitionName),
          ),
        )
        .returning({ id: workflows.id });
      if (!updated) {
        return { updated: false as const };
      }
      const piMutation0Scope = {
        orgId: workflow.orgId,
        agentId: workflow.agentId,
        ...(workflow.visibility === "private"
          ? { userId: workflow.ownerUserId }
          : {}),
      };
      const piMutation0Key = workflowPublicationKey(workflow.id);
      const piMutation0Token = randomUUID();
      const publicationFence = volumeChanged
        ? publicationFenceFromReceipt(
            parseRawRows(
              publicationGenerationReceiptSchema,
              await tx.execute(
                beginPublicationSql(
                  piMutation0Scope,
                  piMutation0Key,
                  piMutation0Token,
                  nowDate(),
                ),
              ),
            ),
            piMutation0Scope,
            piMutation0Key,
            piMutation0Token,
          )
        : undefined;
      return { updated: true as const, publicationFence };
    });
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
      const attachedFiles =
        body.files !== undefined
          ? body.files.map((file) => {
              return { path: file.path, content: file.content };
            })
          : (
              (await get(
                loadWorkflowVolumeFiles({
                  orgId: workflow.orgId,
                  workflowId: workflow.id,
                }),
              )) ?? []
            )
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
