import type { WorkflowAttachments } from "@okouai/db/jsonb-contracts/workflow";
import { agents } from "@okouai/db/schema/agent";
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
  visibleWorkflowCondition,
  workflowSummary,
  type WorkflowMember,
  readWorkflowShadowWinner$,
} from "./workflow-data.service";
import { workflowAttachmentFiles } from "./workflow-attachments.service";
import { loadWorkflowAutomations$ } from "./workflow-automation.service";
import {
  readAcceptedOfficialWorkflowCatalog$,
  readAcceptedOfficialWorkflowRevision$,
} from "./official-workflow-catalog-read.service";

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
        agent: {
          id: agents.id,
          owner: agents.owner,
          visibility: agents.visibility,
          name: agents.name,
          displayName: agents.displayName,
        },
      })
      .from(workflows)
      .innerJoin(agents, eq(workflows.agentId, agents.id))
      .where(
        and(
          eq(workflows.orgId, args.orgId),
          eq(workflows.id, args.workflowId),
          visibleWorkflowCondition(args.member),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!visible) {
      return null;
    }
    const { workflow, agent } = visible;

    const shadowedBy = await set(
      readWorkflowShadowWinner$,
      { orgId: args.orgId, member: args.member, workflow },
      signal,
    );
    signal.throwIfAborted();

    const acceptedCatalog = workflow.officialDefinitionName
      ? await set(readAcceptedOfficialWorkflowCatalog$, signal)
      : null;
    signal.throwIfAborted();
    const officialDefinition =
      acceptedCatalog?.payload.definitions.find((definition) => {
        return definition.name === workflow.officialDefinitionName;
      }) ?? null;
    const officialRevision = officialDefinition
      ? await set(
          readAcceptedOfficialWorkflowRevision$,
          {
            name: officialDefinition.name,
            revision: officialDefinition.revision,
          },
          signal,
        )
      : null;
    signal.throwIfAborted();

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

    const loadedVolume =
      workflow.officialDefinitionName === null &&
      args.includeFileContents !== false
        ? await get(
            workflowAttachmentFiles({
              orgId: args.orgId,
              workflowId: workflow.id,
              attachments: workflow.attachments,
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
