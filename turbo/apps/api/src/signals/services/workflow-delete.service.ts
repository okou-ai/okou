import { nowDate } from "../../lib/time";
import {
  publicationGenerationValues,
  retirePublicationSql,
  lockPublicationScopeSql,
  workflowPublicationKey,
} from "./storage-publication-fence.service";
import {
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { agents } from "@okouai/db/schema/agent";
import { storages } from "@okouai/db/schema/storage";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { reconcileAutomationEventWatches$ } from "./automation-event-watch-lifecycle.service";
import { acceptedOfficialWorkflowCatalogReadPlan } from "./official-workflow-catalog-read.service";
import { officialWorkflowCatalogState } from "@okouai/db/schema/official-workflow-catalog";
import { storagePublicationGenerations } from "@okouai/db/schema/storage-publication-fence";
import { purgeDeletedStoragePrefix$ } from "./storage-prefix-purge.service";

interface DeleteWorkflowInput {
  readonly orgId: string;
  readonly workflowId: string;
  readonly allowOfficialInstallationDeletion?: boolean;
  readonly requiredOfficialInstallationState?: "installing";
  readonly serializeOfficialLifecycle?: boolean;
}

interface DeleteOrphanedWorkflowVolumeInput {
  readonly orgId: string;
  readonly workflowId: string;
}

/**
 * Remove a prepared Workflow volume only when no Workflow row was published.
 * Copy/Remix uses this after a transaction-time volume publication failure;
 * the absence check keeps cleanup from deleting a concurrently visible fork.
 */
export const deleteOrphanedWorkflowVolume$ = command(
  async (
    { set },
    args: DeleteOrphanedWorkflowVolumeInput,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const writeDb = set(writeDb$);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0343; new non-billing transactions are prohibited.
    const result = await writeDb.transaction(async (tx) => {
      const [storage] = await tx
        .select({ id: storages.id, s3Prefix: storages.s3Prefix })
        .from(storages)
        .where(
          and(
            eq(storages.orgId, args.orgId),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            eq(storages.name, getCustomSkillStorageName(args.workflowId)),
          ),
        )
        .for("update")
        .limit(1);
      if (!storage) {
        return { deleted: false as const };
      }

      signal.throwIfAborted();
      // Publication holds the storage lock before inserting the Workflow. Read
      // its reference only after that transaction's commit/rollback is known.
      const [workflow] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          and(
            eq(workflows.orgId, args.orgId),
            eq(workflows.id, args.workflowId),
          ),
        )
        .limit(1);
      if (workflow) {
        return { deleted: false as const };
      }

      signal.throwIfAborted();

      await tx.delete(storages).where(eq(storages.id, storage.id));
      return {
        deleted: true as const,
        s3Prefix: storage.s3Prefix,
      };
    });
    signal.throwIfAborted();
    if (!result.deleted) {
      return false;
    }

    await set(
      purgeDeletedStoragePrefix$,
      {
        bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
        s3Prefix: result.s3Prefix,
      },
      signal,
    );
    return true;
  },
);

function workflowDeletionColumns() {
  return {
    id: workflows.id,
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
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0344; new non-billing transactions are prohibited.
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

      if (args.serializeOfficialLifecycle === true) {
        await tx
          .select({ authority: officialWorkflowCatalogState.authority })
          .from(officialWorkflowCatalogState)
          .where(acceptedOfficialWorkflowCatalogReadPlan().condition)
          .for("share");
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
      await tx.delete(workflows).where(eq(workflows.id, workflow.id));
      const storageName = getCustomSkillStorageName(workflow.id);
      const [storage] = await tx
        .select({ id: storages.id, s3Prefix: storages.s3Prefix })
        .from(storages)
        .where(
          and(
            eq(storages.orgId, args.orgId),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            eq(storages.name, storageName),
          ),
        )
        .limit(1);
      if (storage) {
        await tx.delete(storages).where(eq(storages.id, storage.id));
      }
      // Settle both possible publication scopes in deterministic @agent → user order.
      const scopes = [
        { orgId: args.orgId, agentId: workflow.agentId },
        {
          orgId: args.orgId,
          agentId: workflow.agentId,
          userId: workflow.ownerUserId,
        },
      ] as const;
      await tx
        .insert(storagePublicationGenerations)
        .values(publicationGenerationValues(scopes))
        .onConflictDoNothing();
      const publicationKey = workflowPublicationKey(workflow.id);
      for (const scope of scopes) {
        await tx.execute(lockPublicationScopeSql(scope, nowDate()));
        await tx.execute(retirePublicationSql(scope, publicationKey));
      }
      return {
        deleted: true as const,
        s3Prefix: storage?.s3Prefix ?? null,
        automations,
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
    if (result.s3Prefix) {
      await set(
        purgeDeletedStoragePrefix$,
        {
          bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
          s3Prefix: result.s3Prefix,
        },
        signal,
      );
    }
    return true;
  },
);
