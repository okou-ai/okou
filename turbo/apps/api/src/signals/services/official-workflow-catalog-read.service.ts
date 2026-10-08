import {
  OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
  officialWorkflowAcceptedRevisionSchema,
  officialWorkflowCatalogReleasePayloadSchema,
  officialWorkflowDefinitionRevisionPayloadSchema,
  type OfficialWorkflowAcceptedRevision,
  type OfficialWorkflowCatalogReleasePayload,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import {
  officialWorkflowCatalogReleases,
  officialWorkflowCatalogState,
  officialWorkflowDefinitionRevisions,
} from "@okouai/db/schema/official-workflow-catalog";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { and, asc, eq } from "drizzle-orm";

import { db$ } from "../external/db";

export const OFFICIAL_WORKFLOW_CATALOG_AUTHORITY = "official" as const;

export interface AcceptedOfficialWorkflowCatalog {
  readonly releaseId: string;
  readonly payload: OfficialWorkflowCatalogReleasePayload;
}

interface OfficialWorkflowRevisionRow {
  readonly definitionName: string;
  readonly revision: string;
  readonly payload: unknown;
  readonly storageName: string;
  readonly storageId: string;
  readonly storageVersion: string;
}

function officialWorkflowPayloadSchemaVersion(payload: unknown): number {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    !("schemaVersion" in payload) ||
    typeof payload.schemaVersion !== "number" ||
    !Number.isSafeInteger(payload.schemaVersion) ||
    payload.schemaVersion < 1
  ) {
    throw new Error("Official Workflow payload version is invalid");
  }
  return payload.schemaVersion;
}

export function acceptedRevisionFromRow(
  row: OfficialWorkflowRevisionRow,
): OfficialWorkflowAcceptedRevision {
  const definition = officialWorkflowDefinitionRevisionPayloadSchema.parse(
    row.payload,
  );
  if (
    definition.name !== row.definitionName ||
    definition.revision !== row.revision
  ) {
    throw new Error("Official Workflow revision row identity is inconsistent");
  }
  return officialWorkflowAcceptedRevisionSchema.parse({
    definition,
    artifact: {
      storageName: row.storageName,
      storageId: row.storageId,
      storageVersion: row.storageVersion,
    },
  });
}

export function acceptedOfficialWorkflowCatalogReadPlan() {
  return {
    columns: {
      releaseId: officialWorkflowCatalogState.acceptedReleaseId,
      payload: officialWorkflowCatalogReleases.payload,
    },
    join: eq(
      officialWorkflowCatalogReleases.id,
      officialWorkflowCatalogState.acceptedReleaseId,
    ),
    condition: eq(
      officialWorkflowCatalogState.authority,
      OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
    ),
  };
}

export function acceptedCatalogFromRow(
  row: { readonly releaseId: string; readonly payload: unknown } | undefined,
): AcceptedOfficialWorkflowCatalog | null {
  if (!row) {
    return null;
  }
  if (
    officialWorkflowPayloadSchemaVersion(row.payload) <
    OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION
  ) {
    return null;
  }
  return {
    releaseId: row.releaseId,
    payload: officialWorkflowCatalogReleasePayloadSchema.parse(row.payload),
  };
}

export const readAcceptedOfficialWorkflowCatalog$ = command(
  async (
    { get },
    signal: AbortSignal,
  ): Promise<AcceptedOfficialWorkflowCatalog | null> => {
    const db = get(db$);
    const plan = acceptedOfficialWorkflowCatalogReadPlan();
    const [row] = await db
      .select(plan.columns)
      .from(officialWorkflowCatalogState)
      .innerJoin(officialWorkflowCatalogReleases, plan.join)
      .where(plan.condition)
      .limit(1);
    signal.throwIfAborted();
    return acceptedCatalogFromRow(row);
  },
);

/** Pure native-query inputs for an owner that reads an exact immutable revision. */
export function acceptedOfficialWorkflowRevisionReadPlan(args: {
  readonly name: string;
  readonly revision: string;
}) {
  return {
    columns: {
      definitionName: officialWorkflowDefinitionRevisions.definitionName,
      revision: officialWorkflowDefinitionRevisions.revision,
      payload: officialWorkflowDefinitionRevisions.payload,
      storageName: officialWorkflowDefinitionRevisions.storageName,
      storageId: officialWorkflowDefinitionRevisions.storageId,
      storageVersion: officialWorkflowDefinitionRevisions.storageVersion,
    },
    storageJoin: and(
      eq(storages.id, officialWorkflowDefinitionRevisions.storageId),
      eq(storages.name, officialWorkflowDefinitionRevisions.storageName),
      eq(storages.orgId, SYSTEM_ORG_ID),
      eq(storages.userId, VOLUME_ORG_USER_ID),
    ),
    storageVersionJoin: and(
      eq(
        storageVersions.id,
        officialWorkflowDefinitionRevisions.storageVersion,
      ),
      eq(
        storageVersions.storageId,
        officialWorkflowDefinitionRevisions.storageId,
      ),
    ),
    condition: and(
      eq(officialWorkflowDefinitionRevisions.definitionName, args.name),
      eq(officialWorkflowDefinitionRevisions.revision, args.revision),
    ),
  };
}

export const readAcceptedOfficialWorkflowRevision$ = command(
  async (
    { get },
    args: { readonly name: string; readonly revision: string },
    signal: AbortSignal,
  ): Promise<OfficialWorkflowAcceptedRevision | null> => {
    const db = get(db$);
    const plan = acceptedOfficialWorkflowRevisionReadPlan(args);
    const [row] = await db
      .select(plan.columns)
      .from(officialWorkflowDefinitionRevisions)
      .innerJoin(storages, plan.storageJoin)
      .innerJoin(storageVersions, plan.storageVersionJoin)
      .where(plan.condition)
      .limit(1);
    signal.throwIfAborted();
    return row ? acceptedRevisionFromRow(row) : null;
  },
);

export const readAllCurrentSchemaOfficialWorkflowRevisions$ = command(
  async (
    { get },
    signal: AbortSignal,
  ): Promise<readonly OfficialWorkflowAcceptedRevision[]> => {
    const db = get(db$);
    const rows = await db
      .select({
        definitionName: officialWorkflowDefinitionRevisions.definitionName,
        revision: officialWorkflowDefinitionRevisions.revision,
        payload: officialWorkflowDefinitionRevisions.payload,
        storageName: officialWorkflowDefinitionRevisions.storageName,
        storageId: officialWorkflowDefinitionRevisions.storageId,
        storageVersion: officialWorkflowDefinitionRevisions.storageVersion,
        verifiedStorageId: storages.id,
        verifiedStorageVersion: storageVersions.id,
      })
      .from(officialWorkflowDefinitionRevisions)
      .leftJoin(
        storages,
        and(
          eq(storages.id, officialWorkflowDefinitionRevisions.storageId),
          eq(storages.name, officialWorkflowDefinitionRevisions.storageName),
          eq(storages.orgId, SYSTEM_ORG_ID),
          eq(storages.userId, VOLUME_ORG_USER_ID),
        ),
      )
      .leftJoin(
        storageVersions,
        and(
          eq(
            storageVersions.id,
            officialWorkflowDefinitionRevisions.storageVersion,
          ),
          eq(
            storageVersions.storageId,
            officialWorkflowDefinitionRevisions.storageId,
          ),
        ),
      )
      .orderBy(
        asc(officialWorkflowDefinitionRevisions.definitionName),
        asc(officialWorkflowDefinitionRevisions.revision),
      );
    signal.throwIfAborted();
    return rows.flatMap((row) => {
      if (
        officialWorkflowPayloadSchemaVersion(row.payload) !==
        OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION
      ) {
        return [];
      }
      if (
        row.verifiedStorageId !== row.storageId ||
        row.verifiedStorageVersion !== row.storageVersion
      ) {
        throw new Error(
          "Official Workflow revision artifact registration is inconsistent",
        );
      }
      return [acceptedRevisionFromRow(row)];
    });
  },
);
