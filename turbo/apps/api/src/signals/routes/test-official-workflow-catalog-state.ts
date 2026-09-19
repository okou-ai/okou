import { createHash, randomUUID } from "node:crypto";

import { OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import {
  testOfficialWorkflowCatalogStateContract,
  type TestOfficialWorkflowCatalogStateActionBody,
} from "@okouai/api-contracts/contracts/test-official-workflow-catalog-state";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import {
  officialWorkflowCatalogReleases,
  officialWorkflowCatalogState,
  officialWorkflowDefinitionRevisions,
  officialWorkflowReconciliationWork,
} from "@okouai/db/schema/official-workflow-catalog";
import { gmailWatchStates } from "@okouai/db/schema/gmail-event";
import {
  officialWorkflowAutomationIdentities,
  workflowAutomations,
  workflows,
} from "@okouai/db/schema/workflow";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { and, asc, count, eq, like, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { testOverride } from "../../lib/singleton";
import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  currentOfficialWorkflowCatalogAuthority,
  currentOfficialWorkflowCatalogStoragePrefix,
  currentOfficialWorkflowDefinitionStorageName,
  officialWorkflowCatalogIsTestScoped,
} from "../services/official-workflow-catalog-authority";
import {
  readAcceptedOfficialWorkflowCatalog,
  readAcceptedOfficialWorkflowDefinition,
  readAcceptedOfficialWorkflowRevision,
} from "../services/official-workflow-catalog-read.service";
import { executeOfficialWorkflowReconciliationWork$ } from "../services/official-workflow-reconciliation-worker.service";
import {
  clearAutomationStructureTransitionPreparedHookForTest,
  clearDormantMaterializationReservedHookForTest,
  setAutomationStructureTransitionPreparedHookForTest,
  setDormantMaterializationReservedHookForTest,
} from "../services/official-workflow-reconciliation.service";
import { createDeferredPromise } from "../utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const actionBody$ = bodyResultOf(
  testOfficialWorkflowCatalogStateContract.action,
);
const PREVIOUS_SCHEMA_RELEASE_ID = "f".repeat(64);
const PREVIOUS_SCHEMA_DEFINITION_NAME = "api-test-legacy";
const PREVIOUS_SCHEMA_REVISION = "e".repeat(64);
const PREVIOUS_SCHEMA_BLUEPRINT_FINGERPRINT = "c".repeat(64);

interface DormantMaterializationPause {
  readonly reached: ReturnType<typeof createDeferredPromise<void>>;
  readonly resume: ReturnType<typeof createDeferredPromise<void>>;
}

const dormantMaterializationPause = testOverride<
  Map<string, DormantMaterializationPause>
>(() => {
  return new Map();
});

const structureTransitionPromotionPause = testOverride<
  Map<string, DormantMaterializationPause>
>(() => {
  return new Map();
});

function releaseDormantMaterializationPause(): void {
  const authority = currentOfficialWorkflowCatalogAuthority();
  const pause = dormantMaterializationPause.get().get(authority);
  if (pause && !pause.resume.settled()) {
    pause.resume.resolve(undefined);
  }
  dormantMaterializationPause.get().delete(authority);
  clearDormantMaterializationReservedHookForTest();
}

function pauseNextDormantMaterialization(signal: AbortSignal): void {
  releaseDormantMaterializationPause();
  const pause = {
    reached: createDeferredPromise<void>(signal),
    resume: createDeferredPromise<void>(signal),
  };
  dormantMaterializationPause
    .get()
    .set(currentOfficialWorkflowCatalogAuthority(), pause);
  setDormantMaterializationReservedHookForTest(async () => {
    const current = dormantMaterializationPause
      .get()
      .get(currentOfficialWorkflowCatalogAuthority());
    if (!current) {
      return;
    }
    if (!current.reached.settled()) {
      current.reached.resolve(undefined);
    }
    await current.resume.promise;
  });
}

function releaseStructureTransitionPromotionPause(): void {
  const authority = currentOfficialWorkflowCatalogAuthority();
  const pause = structureTransitionPromotionPause.get().get(authority);
  if (pause && !pause.resume.settled()) {
    pause.resume.resolve(undefined);
  }
  structureTransitionPromotionPause.get().delete(authority);
  clearAutomationStructureTransitionPreparedHookForTest();
}

function pauseNextStructureTransitionPromotion(signal: AbortSignal): void {
  releaseStructureTransitionPromotionPause();
  const pause = {
    reached: createDeferredPromise<void>(signal),
    resume: createDeferredPromise<void>(signal),
  };
  structureTransitionPromotionPause
    .get()
    .set(currentOfficialWorkflowCatalogAuthority(), pause);
  setAutomationStructureTransitionPreparedHookForTest(async () => {
    const current = structureTransitionPromotionPause
      .get()
      .get(currentOfficialWorkflowCatalogAuthority());
    if (!current) {
      return;
    }
    if (!current.reached.settled()) {
      current.reached.resolve(undefined);
    }
    await current.resume.promise;
  });
}

function crashNextStructureTransitionPromotion(): void {
  releaseStructureTransitionPromotionPause();
  setAutomationStructureTransitionPreparedHookForTest(() => {
    clearAutomationStructureTransitionPreparedHookForTest();
    return Promise.reject(
      new Error(
        "Simulated hard crash after Official structure-transition watch preparation",
      ),
    );
  });
}

type ReadAction = Extract<
  TestOfficialWorkflowCatalogStateActionBody,
  { readonly action: "read" }
>;

async function cleanupTestState(db: Db, signal: AbortSignal): Promise<void> {
  if (!officialWorkflowCatalogIsTestScoped()) {
    throw new Error("Official Workflow catalog cleanup requires a test scope");
  }
  const authority = currentOfficialWorkflowCatalogAuthority();
  const storagePattern = `${currentOfficialWorkflowCatalogStoragePrefix()}%`;
  releaseDormantMaterializationPause();
  releaseStructureTransitionPromotionPause();
  await db
    .delete(officialWorkflowReconciliationWork)
    .where(eq(officialWorkflowReconciliationWork.authority, authority));
  await db
    .delete(officialWorkflowCatalogState)
    .where(eq(officialWorkflowCatalogState.authority, authority));
  await db
    .delete(officialWorkflowDefinitionRevisions)
    .where(eq(officialWorkflowDefinitionRevisions.authority, authority));
  await db
    .delete(officialWorkflowCatalogReleases)
    .where(eq(officialWorkflowCatalogReleases.authority, authority));
  await db
    .delete(storages)
    .where(
      and(
        eq(storages.orgId, SYSTEM_ORG_ID),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        like(storages.name, storagePattern),
      ),
    );
  signal.throwIfAborted();
}

async function seedPreviousSchemaRelease(
  db: Db,
  signal: AbortSignal,
): Promise<void> {
  const previousSchemaVersion = OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION - 1;
  if (previousSchemaVersion < 1) {
    throw new Error("Official Workflow catalog has no previous schema version");
  }
  const authority = currentOfficialWorkflowCatalogAuthority();
  const storageName = currentOfficialWorkflowDefinitionStorageName(
    PREVIOUS_SCHEMA_DEFINITION_NAME,
  );
  const storageId = randomUUID();
  const storagePrefix = `api-test/${storageId}`;
  const storageVersion = createHash("sha256")
    .update(authority)
    .update("\0previous-schema-storage-version")
    .digest("hex");
  const blueprint = {
    key: "daily-delivery",
    parameters: [
      {
        key: "timezone",
        type: "string",
        format: "timezone",
        required: true,
        derivation: { kind: "user-timezone" },
      },
    ],
    desiredState: {
      kind: "schedule",
      schedule: {
        type: "cron",
        cronExpression: "0 7 * * *",
        timezone: { parameter: "timezone" },
      },
    },
    runtime: { resultEmail: true },
    fingerprint: PREVIOUS_SCHEMA_BLUEPRINT_FINGERPRINT,
  };
  const revisionPayload = JSON.stringify({
    schemaVersion: previousSchemaVersion,
    name: PREVIOUS_SCHEMA_DEFINITION_NAME,
    revision: PREVIOUS_SCHEMA_REVISION,
    workflow: {
      displayName: "Legacy test workflow",
      description: "Exercises a previous-schema catalog revision.",
      instruction: "Use the legacy test workflow.",
      files: [],
    },
    blueprints: [blueprint],
  });
  const releasePayload = JSON.stringify({
    schemaVersion: previousSchemaVersion,
    definitions: [
      {
        name: PREVIOUS_SCHEMA_DEFINITION_NAME,
        lifecycle: "active",
        revision: PREVIOUS_SCHEMA_REVISION,
        artifact: {
          storageName,
          storageId,
          storageVersion,
        },
        blueprints: [blueprint],
        releasedBlueprintKeys: [blueprint.key],
        presentation: { category: "productivity" },
      },
    ],
  });
  await db.transaction(async (tx) => {
    await tx.insert(storages).values({
      id: storageId,
      orgId: SYSTEM_ORG_ID,
      userId: VOLUME_ORG_USER_ID,
      name: storageName,
      s3Prefix: storagePrefix,
      size: 0,
      fileCount: 0,
    });
    await tx.insert(storageVersions).values({
      id: storageVersion,
      storageId,
      s3Key: `${storagePrefix}/${storageVersion}`,
      size: 0,
      archiveSize: 0,
      fileCount: 0,
      message: "Previous-schema Official Workflow test revision",
      createdBy: "system",
    });
    await tx
      .update(storages)
      .set({ headVersionId: storageVersion })
      .where(eq(storages.id, storageId));
    await tx.execute(sql`
      INSERT INTO ${officialWorkflowDefinitionRevisions} (
        authority,
        definition_name,
        revision,
        payload,
        storage_name,
        storage_id,
        storage_version
      ) VALUES (
        ${authority},
        ${PREVIOUS_SCHEMA_DEFINITION_NAME},
        ${PREVIOUS_SCHEMA_REVISION},
        ${revisionPayload}::jsonb,
        ${storageName},
        ${storageId},
        ${storageVersion}
      )
    `);
    await tx.execute(sql`
      INSERT INTO ${officialWorkflowCatalogReleases} (authority, id, payload)
      VALUES (${authority}, ${PREVIOUS_SCHEMA_RELEASE_ID}, ${releasePayload}::jsonb)
    `);
    await tx.insert(officialWorkflowCatalogState).values({
      authority,
      acceptedReleaseId: PREVIOUS_SCHEMA_RELEASE_ID,
    });
  });
  signal.throwIfAborted();
}

async function catalogCounts(db: Db, signal: AbortSignal) {
  const authority = currentOfficialWorkflowCatalogAuthority();
  const storagePattern = `${currentOfficialWorkflowCatalogStoragePrefix()}%`;
  const [[releaseCount], [revisionCount], [storageCount], [versionCount]] =
    await Promise.all([
      db
        .select({ value: count() })
        .from(officialWorkflowCatalogReleases)
        .where(eq(officialWorkflowCatalogReleases.authority, authority)),
      db
        .select({ value: count() })
        .from(officialWorkflowDefinitionRevisions)
        .where(eq(officialWorkflowDefinitionRevisions.authority, authority)),
      db
        .select({ value: count() })
        .from(storages)
        .where(
          and(
            eq(storages.orgId, SYSTEM_ORG_ID),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            like(storages.name, storagePattern),
          ),
        ),
      db
        .select({ value: count() })
        .from(storageVersions)
        .innerJoin(storages, eq(storages.id, storageVersions.storageId))
        .where(
          and(
            eq(storages.orgId, SYSTEM_ORG_ID),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            like(storages.name, storagePattern),
          ),
        ),
    ]);
  signal.throwIfAborted();
  if (!releaseCount || !revisionCount || !storageCount || !versionCount) {
    throw new Error("Official Workflow catalog test counts are incomplete");
  }
  return {
    releases: releaseCount.value,
    revisions: revisionCount.value,
    storages: storageCount.value,
    storageVersions: versionCount.value,
  };
}

async function readStorageState(
  db: Db,
  definitionName: string | undefined,
  signal: AbortSignal,
) {
  if (definitionName === undefined) {
    return null;
  }
  const [row] = await db
    .select({
      storageName: storages.name,
      storageId: storages.id,
      orgId: storages.orgId,
      userId: storages.userId,
      headVersionId: storages.headVersionId,
    })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, SYSTEM_ORG_ID),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(
          storages.name,
          currentOfficialWorkflowDefinitionStorageName(definitionName),
        ),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!row) {
    return null;
  }
  const [versionCount] = await db
    .select({ value: count() })
    .from(storageVersions)
    .where(eq(storageVersions.storageId, row.storageId));
  signal.throwIfAborted();
  if (!versionCount) {
    throw new Error("Official Workflow catalog storage count is incomplete");
  }
  return {
    ...row,
    versionCount: versionCount.value,
  };
}

async function stateResponse(
  db: Db,
  body:
    | Pick<ReadAction, "definitionName" | "revision" | "workflowId">
    | undefined,
  worker: {
    readonly claimed: number;
    readonly completed: number;
    readonly advanced: number;
    readonly retried: number;
    readonly installations: number;
  } | null,
  signal: AbortSignal,
) {
  const catalog = await readAcceptedOfficialWorkflowCatalog(db, signal);
  const definition = body?.definitionName
    ? await readAcceptedOfficialWorkflowDefinition(
        db,
        body.definitionName,
        signal,
      )
    : null;
  const revision =
    body?.definitionName && body.revision
      ? await readAcceptedOfficialWorkflowRevision(
          db,
          { name: body.definitionName, revision: body.revision },
          signal,
        )
      : null;
  const [reconciliationWork, identities] = await Promise.all([
    db
      .select({
        definitionName: officialWorkflowReconciliationWork.definitionName,
        requestedReleaseId:
          officialWorkflowReconciliationWork.requestedReleaseId,
        cursorWorkflowId: officialWorkflowReconciliationWork.cursorWorkflowId,
        state: officialWorkflowReconciliationWork.state,
        leaseId: officialWorkflowReconciliationWork.leaseId,
        attemptCount: officialWorkflowReconciliationWork.attemptCount,
        lastError: officialWorkflowReconciliationWork.lastError,
      })
      .from(officialWorkflowReconciliationWork)
      .where(
        eq(
          officialWorkflowReconciliationWork.authority,
          currentOfficialWorkflowCatalogAuthority(),
        ),
      )
      .orderBy(asc(officialWorkflowReconciliationWork.definitionName)),
    body?.workflowId === undefined
      ? Promise.resolve([])
      : db
          .select({
            id: officialWorkflowAutomationIdentities.id,
            workflowId: officialWorkflowAutomationIdentities.workflowId,
            automationId: officialWorkflowAutomationIdentities.automationId,
            blueprintKey: officialWorkflowAutomationIdentities.blueprintKey,
            state: officialWorkflowAutomationIdentities.state,
            retainedParameterBindings:
              officialWorkflowAutomationIdentities.retainedParameterBindings,
            retainedIntendedEnabled:
              officialWorkflowAutomationIdentities.retainedIntendedEnabled,
            retainedAppliedFingerprint:
              officialWorkflowAutomationIdentities.retainedAppliedFingerprint,
          })
          .from(officialWorkflowAutomationIdentities)
          .where(
            eq(
              officialWorkflowAutomationIdentities.workflowId,
              body.workflowId,
            ),
          )
          .orderBy(asc(officialWorkflowAutomationIdentities.blueprintKey)),
  ]);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      catalog,
      definition,
      revision,
      storage: await readStorageState(db, body?.definitionName, signal),
      counts: await catalogCounts(db, signal),
      reconciliationWork,
      identities,
      worker,
    },
  };
}

async function upsertExpiredReconciliationWork(
  db: Db,
  definitionName: string,
  requestedReleaseId: string,
  currentTime: Date,
  leaseId: string,
): Promise<void> {
  const authority = currentOfficialWorkflowCatalogAuthority();
  await db
    .insert(officialWorkflowReconciliationWork)
    .values({
      authority,
      definitionName,
      requestedReleaseId,
      state: "running",
      leaseId,
      leaseExpiresAt: new Date(currentTime.getTime() - 1),
      availableAt: currentTime,
      attemptCount: 0,
      lastError: null,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: [
        officialWorkflowReconciliationWork.authority,
        officialWorkflowReconciliationWork.definitionName,
      ],
      set: {
        requestedReleaseId,
        cursorWorkflowId: null,
        state: "running",
        leaseId,
        leaseExpiresAt: new Date(currentTime.getTime() - 1),
        availableAt: currentTime,
        attemptCount: 0,
        lastError: null,
        updatedAt: currentTime,
      },
    });
}

async function deleteGmailWatchState(
  db: Db,
  orgId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(gmailWatchStates)
    .where(
      and(
        eq(gmailWatchStates.orgId, orgId),
        eq(gmailWatchStates.userId, userId),
      ),
    );
}

async function simulateCommittedLifecycleGap(
  db: Db,
  args: {
    readonly automationId: string;
    readonly definitionName: string;
    readonly materializationState: "current" | "reconciling" | "failed";
  },
  signal: AbortSignal,
): Promise<void> {
  const currentTime = nowDate();
  const leaseId = randomUUID();
  await db.transaction(async (tx) => {
    const [catalogState] = await tx
      .select({
        acceptedReleaseId: officialWorkflowCatalogState.acceptedReleaseId,
      })
      .from(officialWorkflowCatalogState)
      .where(
        eq(
          officialWorkflowCatalogState.authority,
          currentOfficialWorkflowCatalogAuthority(),
        ),
      )
      .limit(1);
    const [automation] = await tx
      .select({
        id: workflowAutomations.id,
        workflowId: workflowAutomations.workflowId,
        orgId: workflowAutomations.orgId,
        ownerUserId: workflowAutomations.ownerUserId,
        eventType: workflowAutomations.eventType,
        workflowDefinitionName: workflows.officialDefinitionName,
        officialBlueprintKey: workflowAutomations.officialBlueprintKey,
        officialAppliedFingerprint:
          workflowAutomations.officialAppliedFingerprint,
        officialParameterBindings:
          workflowAutomations.officialParameterBindings,
        officialIntendedEnabled: workflowAutomations.officialIntendedEnabled,
        officialReconciliationStatus:
          workflowAutomations.officialReconciliationStatus,
      })
      .from(workflowAutomations)
      .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
      .where(eq(workflowAutomations.id, args.automationId))
      .for("update")
      .limit(1);
    if (
      !catalogState ||
      !automation ||
      automation.workflowDefinitionName !== args.definitionName ||
      automation.officialBlueprintKey === null ||
      automation.officialAppliedFingerprint === null ||
      automation.officialParameterBindings === null ||
      automation.officialIntendedEnabled !== true ||
      automation.officialReconciliationStatus !== "current"
    ) {
      throw new Error("Cannot simulate an incomplete lifecycle commit");
    }
    const [identity] = await tx
      .select()
      .from(officialWorkflowAutomationIdentities)
      .where(eq(officialWorkflowAutomationIdentities.id, automation.id))
      .for("update")
      .limit(1);
    if (
      !identity ||
      identity.workflowId !== automation.workflowId ||
      identity.automationId !== automation.id ||
      identity.blueprintKey !== automation.officialBlueprintKey ||
      identity.state !== "active"
    ) {
      throw new Error("Cannot simulate lifecycle gap without active identity");
    }
    await tx
      .update(workflowAutomations)
      .set({
        enabled: false,
        nextRunAt: null,
        ...(args.materializationState === "current"
          ? {}
          : { officialReconciliationStatus: args.materializationState }),
        updatedAt: currentTime,
      })
      .where(eq(workflowAutomations.id, automation.id));
    if (args.materializationState !== "current") {
      const [reserved] = await tx
        .update(officialWorkflowAutomationIdentities)
        .set({
          automationId: null,
          state: args.materializationState,
          retainedParameterBindings: automation.officialParameterBindings,
          retainedIntendedEnabled: true,
          retainedAppliedFingerprint: automation.officialAppliedFingerprint,
          updatedAt: currentTime,
        })
        .where(
          and(
            eq(officialWorkflowAutomationIdentities.id, automation.id),
            eq(
              officialWorkflowAutomationIdentities.automationId,
              automation.id,
            ),
            eq(officialWorkflowAutomationIdentities.state, "active"),
          ),
        )
        .returning({ id: officialWorkflowAutomationIdentities.id });
      if (!reserved) {
        throw new Error("Failed to persist dormant materialization stage");
      }
    }
    if (
      args.materializationState !== "failed" &&
      (automation.eventType === "gmail-new-message" ||
        automation.eventType === "gmail-label-applied")
    ) {
      await deleteGmailWatchState(tx, automation.orgId, automation.ownerUserId);
    }
    await upsertExpiredReconciliationWork(
      tx,
      args.definitionName,
      catalogState.acceptedReleaseId,
      currentTime,
      leaseId,
    );
  });
  signal.throwIfAborted();
}

async function simulateStructureTransitionCrash(
  db: Db,
  args: {
    readonly automationId: string;
    readonly definitionName: string;
  },
  signal: AbortSignal,
): Promise<void> {
  const currentTime = nowDate();
  await db.transaction(async (tx) => {
    const [catalogState] = await tx
      .select({
        acceptedReleaseId: officialWorkflowCatalogState.acceptedReleaseId,
      })
      .from(officialWorkflowCatalogState)
      .where(
        eq(
          officialWorkflowCatalogState.authority,
          currentOfficialWorkflowCatalogAuthority(),
        ),
      )
      .limit(1);
    const [automation] = await tx
      .select({
        id: workflowAutomations.id,
        workflowDefinitionName: workflows.officialDefinitionName,
        officialBlueprintKey: workflowAutomations.officialBlueprintKey,
        officialReconciliationStatus:
          workflowAutomations.officialReconciliationStatus,
      })
      .from(workflowAutomations)
      .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
      .where(eq(workflowAutomations.id, args.automationId))
      .for("update")
      .limit(1);
    if (
      !catalogState ||
      !automation ||
      automation.workflowDefinitionName !== args.definitionName ||
      automation.officialBlueprintKey === null ||
      automation.officialReconciliationStatus !== "current"
    ) {
      throw new Error("Cannot simulate an Official structure-transition crash");
    }
    await tx
      .update(workflowAutomations)
      .set({
        enabled: false,
        nextRunAt: null,
        officialReconciliationStatus: "reconciling",
        updatedAt: currentTime,
      })
      .where(eq(workflowAutomations.id, automation.id));
    await upsertExpiredReconciliationWork(
      tx,
      args.definitionName,
      catalogState.acceptedReleaseId,
      currentTime,
      randomUUID(),
    );
  });
  signal.throwIfAborted();
}

async function simulateReconciliationWorkerCrash(
  db: Db,
  definitionName: string,
  signal: AbortSignal,
): Promise<void> {
  const currentTime = nowDate();
  await db
    .update(officialWorkflowReconciliationWork)
    .set({
      state: "running",
      leaseId: randomUUID(),
      leaseExpiresAt: new Date(currentTime.getTime() - 1),
      availableAt: currentTime,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(
          officialWorkflowReconciliationWork.authority,
          currentOfficialWorkflowCatalogAuthority(),
        ),
        eq(officialWorkflowReconciliationWork.definitionName, definitionName),
      ),
    );
  signal.throwIfAborted();
}

async function handleLifecycleSimulationAction(
  db: Db,
  body: TestOfficialWorkflowCatalogStateActionBody,
  signal: AbortSignal,
): Promise<boolean> {
  if (body.action === "simulate-reconciliation-worker-crash") {
    await simulateReconciliationWorkerCrash(db, body.definitionName, signal);
    return true;
  }
  if (
    body.action === "simulate-dormant-materialization-crash" ||
    body.action === "simulate-current-lifecycle-gap" ||
    body.action === "simulate-dormant-materialization-discard-crash"
  ) {
    await simulateCommittedLifecycleGap(
      db,
      {
        automationId: body.automationId,
        definitionName: body.definitionName,
        materializationState:
          body.action === "simulate-current-lifecycle-gap"
            ? "current"
            : body.action === "simulate-dormant-materialization-crash"
              ? "reconciling"
              : "failed",
      },
      signal,
    );
    return true;
  }
  if (body.action === "simulate-structure-transition-crash") {
    await simulateStructureTransitionCrash(
      db,
      {
        automationId: body.automationId,
        definitionName: body.definitionName,
      },
      signal,
    );
    return true;
  }
  return false;
}

async function handleLifecycleControlAction(
  body: TestOfficialWorkflowCatalogStateActionBody,
  signal: AbortSignal,
): Promise<boolean> {
  if (body.action === "pause-next-dormant-materialization") {
    pauseNextDormantMaterialization(signal);
    return true;
  }
  if (body.action === "wait-for-dormant-materialization-pause") {
    const pause = dormantMaterializationPause
      .get()
      .get(currentOfficialWorkflowCatalogAuthority());
    if (!pause) {
      throw new Error("Dormant materialization pause is not configured");
    }
    await pause.reached.promise;
    signal.throwIfAborted();
    return true;
  }
  if (body.action === "resume-dormant-materialization") {
    releaseDormantMaterializationPause();
    return true;
  }
  if (body.action === "pause-next-structure-transition-promotion") {
    pauseNextStructureTransitionPromotion(signal);
    return true;
  }
  if (body.action === "crash-next-structure-transition-promotion") {
    crashNextStructureTransitionPromotion();
    return true;
  }
  if (body.action === "wait-for-structure-transition-promotion-pause") {
    const pause = structureTransitionPromotionPause
      .get()
      .get(currentOfficialWorkflowCatalogAuthority());
    if (!pause) {
      throw new Error("Structure-transition pause is not configured");
    }
    await pause.reached.promise;
    signal.throwIfAborted();
    return true;
  }
  if (body.action === "resume-structure-transition-promotion") {
    releaseStructureTransitionPromotionPause();
    return true;
  }
  return false;
}

async function makeReconciliationWorkDue(
  db: Db,
  definitionName: string,
  signal: AbortSignal,
): Promise<void> {
  const currentTime = nowDate();
  await db
    .update(officialWorkflowReconciliationWork)
    .set({
      state: "pending",
      leaseId: null,
      leaseExpiresAt: null,
      availableAt: currentTime,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(
          officialWorkflowReconciliationWork.authority,
          currentOfficialWorkflowCatalogAuthority(),
        ),
        eq(officialWorkflowReconciliationWork.definitionName, definitionName),
      ),
    );
  signal.throwIfAborted();
}

const officialWorkflowCatalogTestStateRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    if (!officialWorkflowCatalogIsTestScoped()) {
      throw new Error("Official Workflow catalog test scope is not active");
    }
    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const db = set(writeDb$);
    if (bodyResult.data.action === "cleanup") {
      await cleanupTestState(db, signal);
      return await stateResponse(db, undefined, null, signal);
    }
    if (bodyResult.data.action === "seed-previous-schema-release") {
      await seedPreviousSchemaRelease(db, signal);
      return await stateResponse(db, undefined, null, signal);
    }
    if (
      (await handleLifecycleSimulationAction(db, bodyResult.data, signal)) ||
      (await handleLifecycleControlAction(bodyResult.data, signal))
    ) {
      return await stateResponse(db, undefined, null, signal);
    }
    if (bodyResult.data.action === "make-reconciliation-work-due") {
      await makeReconciliationWorkDue(
        db,
        bodyResult.data.definitionName,
        signal,
      );
      return await stateResponse(db, undefined, null, signal);
    }
    if (bodyResult.data.action === "run-reconciliation-worker") {
      const worker = await set(
        executeOfficialWorkflowReconciliationWork$,
        { organizationIds: bodyResult.data.organizationIds },
        signal,
      );
      return await stateResponse(db, undefined, worker, signal);
    }
    if (bodyResult.data.action === "read") {
      return await stateResponse(db, bodyResult.data, null, signal);
    }
    throw new Error("Unsupported Official Workflow catalog test action");
  },
);

export const testOfficialWorkflowCatalogStateRoutes: readonly RouteEntry[] = [
  {
    route: testOfficialWorkflowCatalogStateContract.action,
    handler: officialWorkflowCatalogTestStateRoute$,
  },
];
