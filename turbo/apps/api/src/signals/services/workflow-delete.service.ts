import {
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { storages } from "@okouai/db/schema/storage";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { reconcileAutomationEventWatches } from "./automation-event-watch-lifecycle.service";
import { OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK } from "./official-workflow-constants";
import { purgeDeletedStoragePrefix$ } from "./storage-prefix-purge.service";
import { invalidatePiStableContext } from "./pi-stable-context-generation.service";

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

export const deleteWorkflow$ = command(
  async (
    { set },
    args: DeleteWorkflowInput,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const writeDb = set(writeDb$);

    const result = await writeDb.transaction(async (tx) => {
      if (args.serializeOfficialLifecycle === true) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock_shared(hashtext(${OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK}))`,
        );
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${args.orgId}))`,
        );
      }
      const [workflow] = await tx
        .select({
          id: workflows.id,
          agentId: workflows.agentId,
          ownerUserId: workflows.ownerUserId,
          visibility: workflows.visibility,
          officialDefinitionName: workflows.officialDefinitionName,
          officialInstallationState: workflows.officialInstallationState,
        })
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
      await invalidatePiStableContext(tx, {
        orgId: args.orgId,
        agentId: workflow.agentId,
        ...(workflow.visibility === "private"
          ? { userId: workflow.ownerUserId }
          : {}),
      });

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

      return {
        deleted: true as const,
        s3Prefix: storage?.s3Prefix ?? null,
        automations,
      };
    });
    signal.throwIfAborted();

    if (!result.deleted) {
      return false;
    }

    await reconcileAutomationEventWatches(
      {
        db: writeDb,
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
