import type { WorkflowAttachments } from "@okouai/db/jsonb-contracts/workflow";
import { workflows } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";
import { command } from "ccstate";
import type {
  WorkflowFileEntry,
  WorkflowFileMetadata,
  WorkflowDetailResponse,
} from "@okouai/api-contracts/contracts/workflows";

import { db$ } from "../external/db";
import {
  workflowSummary,
  type WorkflowMember,
  readWorkflowShadowWinner$,
} from "./workflow-data.service";
import { visibleWorkflowCondition } from "./workflow-visibility";
import { workflowAttachmentFiles } from "./workflow-attachments.service";
import { loadWorkflowAutomations$ } from "./workflow-automation.service";
import { installedOfficialWorkflow } from "./builtin-workflows";

function detailFileMetadata(
  workflow: {
    readonly officialDefinitionName: string | null;
    readonly attachments: WorkflowAttachments | null;
  },
  volumeFiles:
    readonly (WorkflowFileEntry & { readonly size: number })[] | null,
) {
  const files: WorkflowFileMetadata[] | null =
    (workflow.officialDefinitionName === null
      ? workflow.attachments?.kind === "bundle"
        ? workflow.attachments.files
        : []
      : volumeFiles
    )?.map((file) => {
      return { path: file.path, size: file.size };
    }) ?? null;
  const fileContents =
    volumeFiles?.map((file) => {
      return { path: file.path, content: file.content };
    }) ?? null;
  return { files, fileContents };
}

export const workflowDetail$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly member: WorkflowMember;
      readonly workflowId: string;
      readonly includeFileContents?: boolean;
    },
    signal: AbortSignal,
  ): Promise<WorkflowDetailResponse | null> => {
    const db = get(db$);
    const [visible] = await db
      .select({
        workflow: workflows,
      })
      .from(workflows)
      .where(
        and(
          eq(workflows.orgId, args.orgId),
          eq(workflows.id, args.workflowId),
          visibleWorkflowCondition(args.member.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!visible) {
      return null;
    }
    const { workflow } = visible;

    const shadowedBy = await set(
      readWorkflowShadowWinner$,
      { orgId: args.orgId, member: args.member, workflow },
      signal,
    );
    signal.throwIfAborted();

    const official = installedOfficialWorkflow(workflow);
    const officialRevision = official?.revision;

    const baseSummary = workflowSummary({
      workflow,
      member: args.member,
      shadowedBy,
      officialDefinitionLifecycle: official?.lifecycle,
    });
    const summary = officialRevision
      ? {
          ...baseSummary,
          displayName: officialRevision.definition.workflow.displayName,
          description: officialRevision.definition.workflow.description,
        }
      : baseSummary;

    const loadedVolume =
      workflow.officialDefinitionName === null &&
      args.includeFileContents !== false
        ? await get(
            workflowAttachmentFiles({
              orgId: args.orgId,
              workflowId: workflow.id,
              attachments: workflow.attachments,
              contentBundle: workflow.contentBundle,
            }),
          )
        : null;
    signal.throwIfAborted();
    const volumeFiles = officialRevision
      ? officialRevision.definition.workflow.files.map((file) => {
          return {
            ...file,
            size: new TextEncoder().encode(file.content).length,
          };
        })
      : loadedVolume;

    const { files, fileContents } = detailFileMetadata(workflow, volumeFiles);

    const automations = await set(
      loadWorkflowAutomations$,
      {
        orgId: args.orgId,
        workflowId: workflow.id,
        userId: args.member.userId,
      },
      signal,
    );
    signal.throwIfAborted();

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
  },
);
