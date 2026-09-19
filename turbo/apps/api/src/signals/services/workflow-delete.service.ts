import {
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { storages } from "@okouai/db/schema/storage";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { env } from "../../lib/env";
import { testOverride } from "../../lib/singleton";
import { writeDb$ } from "../external/db";
import { lockCanonicalAgentMutation } from "./agent-mutation-lock.service";
import { reconcileAutomationEventWatches } from "./automation-event-watch-lifecycle.service";
import { OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK } from "./official-workflow-constants";
import { admitPiStableContextSubjects } from "./pi-stable-context-erasure.service";
import { purgeDeletedStoragePrefix$ } from "./storage-prefix-purge.service";
import {
  invalidatePiStableContext,
  lockPiStableContextGenerationScopes,
  piStableContextWorkflowInvalidationOptions,
  piStableContextWorkflowPublicationKey,
  retirePiStableContextPublication,
} from "./pi-stable-context-generation.service";

interface WorkflowDeleteHooks {
  readonly beforeAdmission?: () => Promise<void>;
  readonly beforeAgentLock?: (tx: Tx) => Promise<void>;
  readonly beforeStorageDelete?: (tx: Tx) => Promise<void>;
}

const workflowDeleteHooks = testOverride<WorkflowDeleteHooks>(() => {
  return {};
});

export function setWorkflowDeleteHooksForTest(
  hooks: WorkflowDeleteHooks,
): void {
  workflowDeleteHooks.set(hooks);
}

export function clearWorkflowDeleteHooksForTest(): void {
  workflowDeleteHooks.clear();
}

interface DeleteWorkflowInput {
  readonly orgId: string;
  readonly workflowId: string;
  readonly allowOfficialInstallationDeletion?: boolean;
  readonly requiredOfficialInstallationState?: "installing";
  readonly serializeOfficialLifecycle?: boolean;
  /** Internal compensation may remove an erased installing row without publishing. */
  readonly allowClosedOwnerCleanupWithoutInvalidation?: boolean;
}

interface DeleteOrphanedWorkflowVolumeInput {
  readonly orgId: string;
  readonly workflowId: string;
}

async function admitWorkflowDeletion(
  tx: Tx,
  args: DeleteWorkflowInput,
): Promise<
  | {
      readonly ownerUserId: string;
      readonly agentId: string;
      readonly admitted: boolean;
    }
  | undefined
> {
  const [observed] = await tx
    .select({
      ownerUserId: workflows.ownerUserId,
      agentId: workflows.agentId,
    })
    .from(workflows)
    .where(
      and(eq(workflows.orgId, args.orgId), eq(workflows.id, args.workflowId)),
    )
    .limit(1);
  if (!observed) {
    return undefined;
  }

  await workflowDeleteHooks.get().beforeAdmission?.();
  const admitted = await admitPiStableContextSubjects(tx, [
    { subjectKind: "organization", subjectId: args.orgId },
    { subjectKind: "user", subjectId: observed.ownerUserId },
  ]);
  if (!admitted && args.allowClosedOwnerCleanupWithoutInvalidation !== true) {
    return undefined;
  }
  if (
    args.allowClosedOwnerCleanupWithoutInvalidation === true &&
    (args.allowOfficialInstallationDeletion !== true ||
      args.requiredOfficialInstallationState !== "installing")
  ) {
    throw new Error(
      "Closed-owner Workflow cleanup requires an installing Official Workflow",
    );
  }
  return {
    ownerUserId: observed.ownerUserId,
    agentId: observed.agentId,
    admitted,
  };
}

async function retireDeletedWorkflowStableContext(
  tx: Tx,
  args: {
    readonly orgId: string;
    readonly workflow: {
      readonly id: string;
      readonly agentId: string;
      readonly name: string;
      readonly ownerUserId: string;
      readonly officialDefinitionName: string | null;
    };
  },
): Promise<void> {
  // A Workflow can have an abandoned obligation in either scope after a
  // visibility transition or a stale update. Settle both in one deterministic
  // @agent → user order, then invalidate both memberships from the same
  // post-delete snapshot.
  const scopes = [
    { orgId: args.orgId, agentId: args.workflow.agentId },
    {
      orgId: args.orgId,
      agentId: args.workflow.agentId,
      userId: args.workflow.ownerUserId,
    },
  ] as const;
  await lockPiStableContextGenerationScopes(tx, scopes);
  const publicationKey = piStableContextWorkflowPublicationKey(
    args.workflow.id,
  );
  for (const scope of scopes) {
    await retirePiStableContextPublication(tx, scope, publicationKey);
  }
  for (const scope of scopes) {
    await invalidatePiStableContext(
      tx,
      scope,
      piStableContextWorkflowInvalidationOptions({
        kind: "delete",
        workflow: {
          workflowId: args.workflow.id,
          name: args.workflow.name,
          officialDefinitionName: args.workflow.officialDefinitionName,
        },
      }),
    );
  }
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
      const admission = await admitWorkflowDeletion(tx, args);
      if (!admission) {
        return { deleted: false as const };
      }

      if (args.serializeOfficialLifecycle === true) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock_shared(hashtext(${OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK}))`,
        );
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${args.orgId}))`,
        );
      }
      await workflowDeleteHooks.get().beforeAgentLock?.(tx);
      await lockCanonicalAgentMutation(tx, admission.agentId);
      const [workflow] = await tx
        .select({
          id: workflows.id,
          agentId: workflows.agentId,
          name: workflows.name,
          ownerUserId: workflows.ownerUserId,
          officialDefinitionName: workflows.officialDefinitionName,
          officialInstallationState: workflows.officialInstallationState,
        })
        .from(workflows)
        .where(
          and(
            eq(workflows.orgId, args.orgId),
            eq(workflows.id, args.workflowId),
            eq(workflows.ownerUserId, admission.ownerUserId),
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
        await workflowDeleteHooks.get().beforeStorageDelete?.(tx);
        // Stable-context publishers lock resource parents before the head.
        // Delete in the same parent-before-head order so a publisher holding a
        // Storage key-share lock cannot deadlock with Workflow invalidation.
        await tx.delete(storages).where(eq(storages.id, storage.id));
      }

      if (admission.admitted) {
        await retireDeletedWorkflowStableContext(tx, {
          orgId: args.orgId,
          workflow,
        });
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
