import { computed, type Computed } from "ccstate";
import type {
  WorkflowFileEntry,
  WorkflowFileMetadata,
  WorkflowDetailResponse,
} from "@okouai/api-contracts/contracts/workflows";

import { db$ } from "../external/db";
import {
  loadWorkflowShadowWinner,
  loadVisibleWorkflowById,
  workflowSummary,
  type WorkflowMember,
} from "./workflow-data.service";
import {
  loadWorkflowVolumeFiles,
  SKILL_FILENAME,
} from "./workflow-volume.service";
import { loadWorkflowAutomations } from "./workflow-automation.service";
import {
  readAcceptedOfficialWorkflowDefinition,
  readAcceptedOfficialWorkflowRevision,
} from "./official-workflow-catalog-read.service";

export function workflowDetail(args: {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
}): Computed<Promise<WorkflowDetailResponse | null>> {
  return computed(async (get): Promise<WorkflowDetailResponse | null> => {
    const db = get(db$);
    const visible = await loadVisibleWorkflowById(db, {
      orgId: args.orgId,
      member: args.member,
      workflowId: args.workflowId,
    });

    if (!visible) {
      return null;
    }
    const { workflow, agent } = visible;

    const shadowedBy = await loadWorkflowShadowWinner(db, {
      orgId: args.orgId,
      member: args.member,
      workflow,
    });

    const officialDefinition = workflow.officialDefinitionName
      ? await readAcceptedOfficialWorkflowDefinition(
          db,
          workflow.officialDefinitionName,
        )
      : null;
    const officialRevision = officialDefinition
      ? await readAcceptedOfficialWorkflowRevision(db, {
          name: officialDefinition.name,
          revision: officialDefinition.revision,
        })
      : null;

    const baseSummary = workflowSummary({
      workflow,
      agent,
      member: args.member,
      shadowedBy,
      officialDefinitionLifecycle: officialDefinition?.lifecycle,
    });
    const summary = officialRevision
      ? {
          ...baseSummary,
          displayName: officialRevision.definition.workflow.displayName,
          description: officialRevision.definition.workflow.description,
        }
      : baseSummary;

    // The synthesized SKILL.md is derived from the DB instruction; users never
    // see it in the file list, so exclude it from both files and fileContents.
    // A `null` volume (no backing storage, or its objects are missing) surfaces
    // as `null` files/fileContents, distinct from an empty-but-loaded volume.
    const loadedVolume =
      workflow.officialDefinitionName === null
        ? await get(
            loadWorkflowVolumeFiles({
              orgId: args.orgId,
              workflowId: workflow.id,
            }),
          )
        : null;
    const volumeFiles = officialRevision
      ? officialRevision.definition.workflow.files.map((file) => {
          return {
            ...file,
            size: new TextEncoder().encode(file.content).length,
          };
        })
      : loadedVolume?.filter((file) => {
          return file.path !== SKILL_FILENAME;
        });

    const files: WorkflowFileMetadata[] | null =
      volumeFiles?.map((file) => {
        return { path: file.path, size: file.size };
      }) ?? null;
    const fileContents: WorkflowFileEntry[] | null =
      volumeFiles?.map((file) => {
        return { path: file.path, content: file.content };
      }) ?? null;

    const automations = await loadWorkflowAutomations(db, {
      orgId: args.orgId,
      workflowId: workflow.id,
      userId: args.member.userId,
    });

    return {
      ...summary,
      createdByUserId: workflow.createdBy,
      updatedByUserId: workflow.updatedBy,
      createdAt: workflow.createdAt.toISOString(),
      updatedAt: workflow.updatedAt.toISOString(),
      instruction:
        officialRevision?.definition.workflow.instruction ??
        workflow.instruction,
      files,
      fileContents,
      automations: [...automations],
    };
  });
}
