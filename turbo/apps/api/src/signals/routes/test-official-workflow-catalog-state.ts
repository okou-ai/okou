import { randomUUID } from "node:crypto";

import { OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import {
  testOfficialWorkflowCatalogStateContract,
  type TestOfficialWorkflowCatalogStateActionBody,
} from "@okouai/api-contracts/contracts/test-official-workflow-catalog-state";
import {
  getOfficialWorkflowDefinitionStorageName,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import {
  officialWorkflowCatalogReleases,
  officialWorkflowCatalogState,
  officialWorkflowDefinitionRevisions,
  officialWorkflowReconciliationWork,
} from "@okouai/db/schema/official-workflow-catalog";
import { officialWorkflowAutomationIdentities } from "@okouai/db/schema/workflow";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { and, asc, count, eq, inArray, like, or, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { db$, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  readAcceptedOfficialWorkflowCatalog$,
  readAcceptedOfficialWorkflowRevision$,
} from "../services/official-workflow-catalog-read.service";
import { executeOfficialWorkflowReconciliationWork$ } from "../services/official-workflow-reconciliation-worker.service";

import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const actionBody$ = bodyResultOf(
  testOfficialWorkflowCatalogStateContract.action,
);
const TEST_STORAGE_NAME_PATTERN = "official-workflow@api-test-%";
const DEPLOYED_TEST_STORAGE_NAMES = [
  getOfficialWorkflowDefinitionStorageName("connector-doctor"),
  getOfficialWorkflowDefinitionStorageName("morning-brief"),
] as const;
const PREVIOUS_SCHEMA_RELEASE_ID = "f".repeat(64);
const PREVIOUS_SCHEMA_DEFINITION_NAME = "api-test-legacy";
const PREVIOUS_SCHEMA_REVISION = "e".repeat(64);
const PREVIOUS_SCHEMA_STORAGE_VERSION = "d".repeat(64);
const PREVIOUS_SCHEMA_BLUEPRINT_FINGERPRINT = "c".repeat(64);

type ReadAction = Extract<
  TestOfficialWorkflowCatalogStateActionBody,
  { readonly action: "read" }
>;

const seedPreviousSchemaRelease$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);

    const previousSchemaVersion = OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION - 1;
    if (previousSchemaVersion < 1) {
      throw new Error(
        "Official Workflow catalog has no previous schema version",
      );
    }
    const storageName = getOfficialWorkflowDefinitionStorageName(
      PREVIOUS_SCHEMA_DEFINITION_NAME,
    );
    const storageId = randomUUID();
    const storagePrefix = `api-test/${storageId}`;
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
            storageVersion: PREVIOUS_SCHEMA_STORAGE_VERSION,
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
        id: PREVIOUS_SCHEMA_STORAGE_VERSION,
        storageId,
        s3Key: `${storagePrefix}/${PREVIOUS_SCHEMA_STORAGE_VERSION}`,
        size: 0,
        archiveSize: 0,
        fileCount: 0,
        message: "Previous-schema Official Workflow test revision",
        createdBy: "system",
      });
      await tx
        .update(storages)
        .set({ headVersionId: PREVIOUS_SCHEMA_STORAGE_VERSION })
        .where(eq(storages.id, storageId));
      await tx.execute(sql`
      INSERT INTO ${officialWorkflowDefinitionRevisions} (
        definition_name,
        revision,
        payload,
        storage_name,
        storage_id,
        storage_version
      ) VALUES (
        ${PREVIOUS_SCHEMA_DEFINITION_NAME},
        ${PREVIOUS_SCHEMA_REVISION},
        ${revisionPayload}::jsonb,
        ${storageName},
        ${storageId},
        ${PREVIOUS_SCHEMA_STORAGE_VERSION}
      )
    `);
      await tx.execute(sql`
      INSERT INTO ${officialWorkflowCatalogReleases} (id, payload)
      VALUES (${PREVIOUS_SCHEMA_RELEASE_ID}, ${releasePayload}::jsonb)
    `);
      await tx.insert(officialWorkflowCatalogState).values({
        authority: "official",
        acceptedReleaseId: PREVIOUS_SCHEMA_RELEASE_ID,
      });
    });
    signal.throwIfAborted();
  },
);

const catalogCounts$ = command(async ({ get }, signal: AbortSignal) => {
  const db = get(db$);

  const [[releaseCount], [revisionCount], [storageCount], [versionCount]] =
    await Promise.all([
      db.select({ value: count() }).from(officialWorkflowCatalogReleases),
      db.select({ value: count() }).from(officialWorkflowDefinitionRevisions),
      db
        .select({ value: count() })
        .from(storages)
        .where(
          and(
            eq(storages.orgId, SYSTEM_ORG_ID),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            or(
              like(storages.name, TEST_STORAGE_NAME_PATTERN),
              inArray(storages.name, DEPLOYED_TEST_STORAGE_NAMES),
            ),
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
            or(
              like(storages.name, TEST_STORAGE_NAME_PATTERN),
              inArray(storages.name, DEPLOYED_TEST_STORAGE_NAMES),
            ),
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
});

const readStorageState$ = command(
  async ({ get }, definitionName: string | undefined, signal: AbortSignal) => {
    const db = get(db$);

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
          eq(storages.name, `official-workflow@${definitionName}`),
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
  },
);

const stateResponse$ = command(
  async (
    { get, set },
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
  ) => {
    const db = get(db$);

    const catalog = await set(readAcceptedOfficialWorkflowCatalog$, signal);
    const definition = body?.definitionName
      ? (catalog?.payload.definitions.find((candidate) => {
          return candidate.name === body?.definitionName;
        }) ?? null)
      : null;
    const revision =
      body?.definitionName && body.revision
        ? await set(
            readAcceptedOfficialWorkflowRevision$,
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
        storage: await set(readStorageState$, body?.definitionName, signal),
        counts: await set(catalogCounts$, signal),
        reconciliationWork,
        identities,
        worker,
      },
    };
  },
);

const simulateReconciliationWorkerCrash$ = command(
  async (
    { set },
    definitionName: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);

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
        eq(officialWorkflowReconciliationWork.definitionName, definitionName),
      );
    signal.throwIfAborted();
  },
);

const officialWorkflowCatalogTestStateRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    if (bodyResult.data.action === "seed-previous-schema-release") {
      await set(seedPreviousSchemaRelease$, signal);
      return await set(stateResponse$, undefined, null, signal);
    }

    if (bodyResult.data.action === "simulate-reconciliation-worker-crash") {
      await set(
        simulateReconciliationWorkerCrash$,
        bodyResult.data.definitionName,
        signal,
      );
      return await set(stateResponse$, undefined, null, signal);
    }

    if (bodyResult.data.action === "run-reconciliation-worker") {
      const worker = await set(
        executeOfficialWorkflowReconciliationWork$,
        signal,
      );
      return await set(stateResponse$, undefined, worker, signal);
    }
    if (bodyResult.data.action === "read") {
      return await set(stateResponse$, bodyResult.data, null, signal);
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
