import { getCustomSkillStorageName } from "@okouai/core/storage-names";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import type { WorkflowUpdateRequest } from "@okouai/api-contracts/contracts/workflows";
import { workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";

import { testOverride } from "../../lib/singleton";
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import {
  isStalePiStableContextPublicationError,
  uploadVolumeServerSide$,
} from "./storage-volume-upload.service";
import {
  loadWorkflowVolumeFiles,
  SKILL_FILENAME,
} from "./workflow-volume.service";
import type { WorkflowRow } from "./workflow-data.service";
import { lockCanonicalAgentMutation } from "./agent-mutation-lock.service";
import { admitPiStableContextSubjects } from "./pi-stable-context-erasure.service";
import {
  beginPiStableContextPublication,
  piStableContextWorkflowInvalidationOptions,
  piStableContextWorkflowPublicationKey,
} from "./pi-stable-context-generation.service";

interface WorkflowUpdateHooks {
  readonly beforeAdmission?: () => Promise<void>;
  readonly afterMetadataMutation?: (tx: Tx) => Promise<void>;
}

const workflowUpdateHooks = testOverride<WorkflowUpdateHooks>(() => {
  return {};
});

export function setWorkflowUpdateHooksForTest(
  hooks: WorkflowUpdateHooks,
): void {
  workflowUpdateHooks.set(hooks);
}

export function clearWorkflowUpdateHooksForTest(): void {
  workflowUpdateHooks.clear();
}

interface UpdateWorkflowInput {
  readonly workflow: WorkflowRow;
  readonly body: WorkflowUpdateRequest;
  readonly updatedByUserId: string;
}

async function admitWorkflowUpdate(
  tx: Tx,
  workflow: Pick<WorkflowRow, "orgId" | "ownerUserId">,
): Promise<boolean> {
  return await admitPiStableContextSubjects(tx, [
    { subjectKind: "organization", subjectId: workflow.orgId },
    { subjectKind: "user", subjectId: workflow.ownerUserId },
  ]);
}

async function commitWorkflowMetadata(
  db: Db,
  args: UpdateWorkflowInput,
  derived: { readonly volumeChanged: boolean; readonly nextName: string },
) {
  const { workflow, body } = args;
  return await db.transaction(async (tx) => {
    if (!(await admitWorkflowUpdate(tx, workflow))) {
      return { updated: false as const };
    }
    await lockCanonicalAgentMutation(tx, workflow.agentId);
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
    await workflowUpdateHooks.get().afterMetadataMutation?.(tx);
    const stableContextPublication = derived.volumeChanged
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
          piStableContextWorkflowInvalidationOptions({
            kind: "upsert",
            workflow: {
              workflowId: workflow.id,
              name: derived.nextName,
              officialDefinitionName: workflow.officialDefinitionName,
            },
          }),
        )
      : undefined;
    return { updated: true as const, stableContextPublication };
  });
}

export const updateWorkflow$ = command(
  async (
    { get, set },
    args: UpdateWorkflowInput,
    signal: AbortSignal,
  ): Promise<boolean> => {
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

    const skillChanged =
      body.name !== undefined ||
      body.instruction !== undefined ||
      body.description !== undefined;
    const volumeChanged = body.files !== undefined || skillChanged;
    // Metadata and its pending generation commit together. The later volume
    // transaction may make only this exact generation ready.
    await workflowUpdateHooks.get().beforeAdmission?.();
    signal.throwIfAborted();
    const metadata = await commitWorkflowMetadata(writeDb, args, {
      volumeChanged,
      nextName,
    });
    signal.throwIfAborted();
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
            ...(metadata.stableContextPublication
              ? { stableContextPublication: metadata.stableContextPublication }
              : {}),
          },
          signal,
        ),
        signal,
      );
      if (!upload.ok) {
        if (isStalePiStableContextPublicationError(upload.error)) {
          return false;
        }
        throw upload.error;
      }
      signal.throwIfAborted();
    }
    return true;
  },
);
