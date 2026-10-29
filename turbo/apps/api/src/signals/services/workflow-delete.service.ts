import { retireWorkflowAttachmentSql } from "./workflow-attachment-cleanup.service";
import { storagePublicationTokens } from "@okouai/db/schema/storage-publication-fence";
import { agents } from "@okouai/db/schema/agent";
import {
  officialWorkflowAutomationIdentities,
  workflows,
} from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { reconcileAutomationEventWatches$ } from "./automation-event-watch-lifecycle.service";

interface DeleteWorkflowInput {
  readonly orgId: string;
  readonly workflowId: string;
  readonly allowOfficialInstallationDeletion?: boolean;
  readonly requiredOfficialInstallationState?: "installing";
}

function workflowDeletionColumns() {
  return {
    id: workflows.id,
    orgId: workflows.orgId,
    attachments: workflows.attachments,
    agentId: workflows.agentId,
    name: workflows.name,
    ownerUserId: workflows.ownerUserId,
    officialDefinitionName: workflows.officialDefinitionName,
    officialInstallationState: workflows.officialInstallationState,
  };
}

const deleteWorkflowRows$ = command(
  async ({ set }, args: DeleteWorkflowInput, signal: AbortSignal) => {
    const writeDb = set(writeDb$);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0342; new non-billing transactions are prohibited.
    const result = await writeDb.transaction(async (tx) => {
      const [observed] = await tx
        .select({ agentId: workflows.agentId })
        .from(workflows)
        .where(
          and(
            eq(workflows.orgId, args.orgId),
            eq(workflows.id, args.workflowId),
          ),
        )
        .limit(1);
      if (!observed) {
        return { deleted: false as const };
      }

      const [agent] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(eq(agents.id, observed.agentId), eq(agents.orgId, args.orgId)),
        )
        .for("key share")
        .limit(1);
      if (!agent) {
        return { deleted: false as const };
      }
      const [workflow] = await tx
        .select(workflowDeletionColumns())
        .from(workflows)
        .where(
          and(
            eq(workflows.orgId, args.orgId),
            eq(workflows.id, args.workflowId),
          ),
        )
        .for("update")
        .limit(1);

      if (!workflow) {
        return { deleted: false as const };
      }
      if (
        args.requiredOfficialInstallationState !== undefined &&
        workflow.officialInstallationState !==
          args.requiredOfficialInstallationState
      ) {
        return { deleted: false as const };
      }
      if (
        workflow.officialDefinitionName !== null &&
        args.allowOfficialInstallationDeletion !== true
      ) {
        throw new Error(
          "Uninstall Official Workflows through the Official installation endpoint",
        );
      }
      const automations = await tx
        .select({
          orgId: workflowAutomations.orgId,
          ownerUserId: workflowAutomations.ownerUserId,
          eventType: workflowAutomations.eventType,
          eventConfig: workflowAutomations.eventConfig,
          eventConnectorId: workflowAutomations.eventConnectorId,
        })
        .from(workflowAutomations)
        .where(eq(workflowAutomations.workflowId, workflow.id));
      // Active identities cannot survive their Automation's SET NULL action.
      // The Workflow cascade owns these rows, so remove them before its children.
      await tx
        .delete(officialWorkflowAutomationIdentities)
        .where(
          eq(officialWorkflowAutomationIdentities.workflowId, workflow.id),
        );
      // Preserve the observed watch targets and capture the rows actually removed
      // before the Workflow cascade can discard their cleanup identities.
      const removedAutomations = await tx
        .delete(workflowAutomations)
        .where(eq(workflowAutomations.workflowId, workflow.id))
        .returning({
          orgId: workflowAutomations.orgId,
          ownerUserId: workflowAutomations.ownerUserId,
          eventType: workflowAutomations.eventType,
          eventConfig: workflowAutomations.eventConfig,
          eventConnectorId: workflowAutomations.eventConnectorId,
        });
      await tx.delete(workflows).where(eq(workflows.id, workflow.id));
      await tx.execute(
        retireWorkflowAttachmentSql(
          {
            orgId: workflow.orgId,
            userId: workflow.ownerUserId,
            workflowId: workflow.id,
          },
          workflow.attachments,
          sql`true`,
        ),
      );
      // An outgoing Stage 1 upload takes the Workflow row before this token.
      await tx
        .delete(storagePublicationTokens)
        .where(
          and(
            eq(storagePublicationTokens.orgId, args.orgId),
            eq(storagePublicationTokens.agentId, workflow.agentId),
            eq(
              storagePublicationTokens.publicationKey,
              `workflow:${workflow.id}`,
            ),
          ),
        );
      return {
        deleted: true as const,
        automations: [...automations, ...removedAutomations],
      };
    });
    signal.throwIfAborted();
    return result;
  },
);

export const deleteWorkflow$ = command(
  async (
    { set },
    args: DeleteWorkflowInput,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const result = await set(deleteWorkflowRows$, args, signal);
    if (!result.deleted) {
      return false;
    }
    await set(
      reconcileAutomationEventWatches$,
      {
        automations: result.automations,
      },
      signal,
    );
    signal.throwIfAborted();
    return true;
  },
);
