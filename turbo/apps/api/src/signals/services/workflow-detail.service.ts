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
import {
  loadWorkflowVolumeFiles,
  SKILL_FILENAME,
} from "./workflow-volume.service";
import { loadWorkflowAutomations$ } from "./workflow-automation.service";
import {
  readAcceptedOfficialWorkflowCatalog$,
  readAcceptedOfficialWorkflowRevision$,
} from "./official-workflow-catalog-read.service";

export const workflowDetail$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly member: WorkflowMember;
      readonly workflowId: string;
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
    signal.throwIfAborted();
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
