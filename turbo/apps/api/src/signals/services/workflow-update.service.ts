import { getCustomSkillStorageName } from "@okouai/core/storage-names";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import type { WorkflowUpdateRequest } from "@okouai/api-contracts/contracts/workflows";
import { workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { uploadVolumeServerSide$ } from "./storage-volume-upload.service";
import {
  loadWorkflowVolumeFiles,
  SKILL_FILENAME,
} from "./workflow-volume.service";
import type { WorkflowRow } from "./workflow-data.service";
import {
  beginPiStableContextPublication,
  piStableContextWorkflowPublicationKey,
} from "./pi-stable-context-generation.service";

interface UpdateWorkflowInput {
  readonly workflow: WorkflowRow;
  readonly body: WorkflowUpdateRequest;
  readonly updatedByUserId: string;
}

export const updateWorkflow$ = command(
  async (
    { get, set },
    args: UpdateWorkflowInput,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const { workflow, body } = args;
    if (workflow.officialDefinitionName !== null) {
      throw new Error("Official Workflow content and structure are read-only");
    }

    const nextName = body.name !== undefined ? body.name : workflow.name;
    const nextInstruction =
      body.instruction !== undefined ? body.instruction : workflow.instruction;
    const nextDescription =
      body.description !== undefined ? body.description : workflow.description;

    // Rebuild the volume whenever the synthesized SKILL.md or the attached
    // files change. The volume is fully derived: SKILL.md + attached files.
    const skillChanged =
      body.name !== undefined ||
      body.instruction !== undefined ||
      body.description !== undefined;
    const volumeChanged = body.files !== undefined || skillChanged;
    // Metadata and its pending generation commit together. The later volume
    // transaction may make only this exact generation ready.
    const stableContextPublication = await writeDb.transaction(async (tx) => {
      await tx
        .update(workflows)
        .set({
          ...(body.name !== undefined && {
            name: body.name,
          }),
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
        .where(eq(workflows.id, workflow.id));
      return volumeChanged
        ? await beginPiStableContextPublication(
            tx,
            {
              orgId: workflow.orgId,
              agentId: workflow.agentId,
              ...(workflow.visibility === "private"
                ? { userId: workflow.ownerUserId }
                : {}),
            },
            piStableContextWorkflowPublicationKey(workflow.id),
          )
        : undefined;
    });
    signal.throwIfAborted();

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

      await set(
        uploadVolumeServerSide$,
        {
          orgId: workflow.orgId,
          storageName: getCustomSkillStorageName(workflow.id),
          files: [{ path: SKILL_FILENAME, content: skillMd }, ...attachedFiles],
          piResourceIndex: true,
          ...(stableContextPublication ? { stableContextPublication } : {}),
        },
        signal,
      );
      signal.throwIfAborted();
    }
  },
);
