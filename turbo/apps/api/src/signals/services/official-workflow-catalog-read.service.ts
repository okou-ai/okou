import {
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
import { array, string } from "zod";
import { and, eq, isNull, isNotNull, or } from "drizzle-orm";

import { db$ } from "../external/db";

export const OFFICIAL_WORKFLOW_CATALOG_AUTHORITY = "official" as const;

/**
 * Schema v1 predates every supported reader: its accepted catalog reads as
 * absent so the writer republishes. Exact revision readers decode only the
 * supported immutable versions; any other version throws.
 */
const OLDEST_SUPPORTED_CATALOG_SCHEMA_VERSION = 2;

export interface AcceptedOfficialWorkflowCatalog {
  readonly releaseId: string;
  readonly payload: OfficialWorkflowCatalogReleasePayload;
  readonly hiddenThreadDefinitionNames: readonly string[];
}

interface OfficialWorkflowRevisionRow {
  readonly definitionName: string;
  readonly revision: string;
  readonly payload: unknown;
  readonly storageName: string | null;
  readonly storageId: string | null;
  readonly storageVersion: string | null;
  readonly contentBundle: unknown;
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
    ...(row.storageName === null &&
    row.storageId === null &&
    row.storageVersion === null
      ? { contentBundle: row.contentBundle }
      : {
          artifact: {
            storageName: row.storageName,
            storageId: row.storageId,
            storageVersion: row.storageVersion,
          },
          contentBundle: row.contentBundle,
        }),
  });
}

export function acceptedOfficialWorkflowCatalogReadPlan() {
  return {
    columns: {
      releaseId: officialWorkflowCatalogState.acceptedReleaseId,
      payload: officialWorkflowCatalogReleases.payload,
      hiddenThreadDefinitionNames:
        officialWorkflowCatalogReleases.hiddenThreadDefinitionNames,
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
  row:
    | {
        readonly releaseId: string;
        readonly payload: unknown;
        readonly hiddenThreadDefinitionNames?: unknown;
      }
    | undefined,
): AcceptedOfficialWorkflowCatalog | null {
  if (!row) {
    return null;
  }
  if (
    officialWorkflowPayloadSchemaVersion(row.payload) <
    OLDEST_SUPPORTED_CATALOG_SCHEMA_VERSION
  ) {
    return null;
  }
  return {
    releaseId: row.releaseId,
    payload: officialWorkflowCatalogReleasePayloadSchema.parse(row.payload),
    hiddenThreadDefinitionNames: array(string()).parse(
      row.hiddenThreadDefinitionNames ?? [],
    ),
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
      contentBundle: officialWorkflowDefinitionRevisions.contentBundle,
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
    deliveryCondition: or(
      and(
        isNull(officialWorkflowDefinitionRevisions.storageName),
        isNull(officialWorkflowDefinitionRevisions.storageId),
        isNull(officialWorkflowDefinitionRevisions.storageVersion),
        isNotNull(officialWorkflowDefinitionRevisions.contentBundle),
      ),
      and(isNotNull(storages.id), isNotNull(storageVersions.id)),
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
      .select({
        ...plan.columns,
        verifiedStorageId: storages.id,
        verifiedStorageVersion: storageVersions.id,
      })
      .from(officialWorkflowDefinitionRevisions)
      .leftJoin(storages, plan.storageJoin)
      .leftJoin(storageVersions, plan.storageVersionJoin)
      .where(plan.condition)
      .limit(1);
    signal.throwIfAborted();
    if (
      row &&
      (row.verifiedStorageId !== row.storageId ||
        row.verifiedStorageVersion !== row.storageVersion)
    ) {
      throw new Error(
        "Official Workflow revision artifact registration is inconsistent",
      );
    }
    return row ? acceptedRevisionFromRow(row) : null;
  },
);
