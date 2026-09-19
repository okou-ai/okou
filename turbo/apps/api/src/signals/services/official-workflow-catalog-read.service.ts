import {
  OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
  officialWorkflowAcceptedRevisionSchema,
  officialWorkflowCatalogReleasePayloadSchema,
  officialWorkflowDefinitionRevisionPayloadSchema,
  type OfficialWorkflowAcceptedDefinition,
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
import { and, asc, eq, or } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";
import {
  currentOfficialWorkflowCatalogAuthority,
  officialWorkflowCatalogDefinitionKey,
  officialWorkflowCatalogDefinitionName,
  officialWorkflowCatalogReleaseId,
  OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
} from "./official-workflow-catalog-authority";

export { OFFICIAL_WORKFLOW_CATALOG_AUTHORITY };

export interface AcceptedOfficialWorkflowCatalog {
  readonly releaseId: string;
  readonly payload: OfficialWorkflowCatalogReleasePayload;
}

interface OfficialWorkflowRevisionRow {
  readonly authority: string;
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

function acceptedRevisionFromRow(
  row: OfficialWorkflowRevisionRow,
): OfficialWorkflowAcceptedRevision {
  const definition = officialWorkflowDefinitionRevisionPayloadSchema.parse(
    row.payload,
  );
  if (
    definition.name !==
      officialWorkflowCatalogDefinitionName(
        row.authority,
        row.definitionName,
      ) ||
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

export async function readAcceptedOfficialWorkflowCatalog(
  db: ReadonlyDb,
  signal?: AbortSignal,
): Promise<AcceptedOfficialWorkflowCatalog | null> {
  const authority = currentOfficialWorkflowCatalogAuthority();
  const [row] = await db
    .select({
      authority: officialWorkflowCatalogState.authority,
      releaseKey: officialWorkflowCatalogState.acceptedReleaseId,
      payload: officialWorkflowCatalogReleases.payload,
    })
    .from(officialWorkflowCatalogState)
    .innerJoin(
      officialWorkflowCatalogReleases,
      and(
        eq(
          officialWorkflowCatalogReleases.authority,
          officialWorkflowCatalogState.authority,
        ),
        eq(
          officialWorkflowCatalogReleases.id,
          officialWorkflowCatalogState.acceptedReleaseId,
        ),
      ),
    )
    .where(eq(officialWorkflowCatalogState.authority, authority))
    .limit(1);
  signal?.throwIfAborted();
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
    releaseId: officialWorkflowCatalogReleaseId(row.authority, row.releaseKey),
    payload: officialWorkflowCatalogReleasePayloadSchema.parse(row.payload),
  };
}

export async function readAcceptedOfficialWorkflowDefinition(
  db: ReadonlyDb,
  name: string,
  signal?: AbortSignal,
): Promise<OfficialWorkflowAcceptedDefinition | null> {
  const catalog = await readAcceptedOfficialWorkflowCatalog(db, signal);
  return (
    catalog?.payload.definitions.find((definition) => {
      return definition.name === name;
    }) ?? null
  );
}

interface OfficialWorkflowRevisionIdentity {
  readonly name: string;
  readonly revision: string;
}

function officialWorkflowRevisionIdentityKey(
  identity: OfficialWorkflowRevisionIdentity,
): string {
  return JSON.stringify([identity.name, identity.revision]);
}

/**
 * Read exact immutable revisions in one statement. The returned array preserves
 * the caller's order, duplicates and missing entries so callers retain their
 * existing fail-closed semantics.
 */
export async function readAcceptedOfficialWorkflowRevisions(
  db: ReadonlyDb,
  identities: readonly OfficialWorkflowRevisionIdentity[],
  signal?: AbortSignal,
): Promise<readonly (OfficialWorkflowAcceptedRevision | null)[]> {
  if (identities.length === 0) {
    signal?.throwIfAborted();
    return [];
  }
  const rows = await db
    .select({
      authority: officialWorkflowDefinitionRevisions.authority,
      definitionName: officialWorkflowDefinitionRevisions.definitionName,
      revision: officialWorkflowDefinitionRevisions.revision,
      payload: officialWorkflowDefinitionRevisions.payload,
      storageName: officialWorkflowDefinitionRevisions.storageName,
      storageId: officialWorkflowDefinitionRevisions.storageId,
      storageVersion: officialWorkflowDefinitionRevisions.storageVersion,
    })
    .from(officialWorkflowDefinitionRevisions)
    .innerJoin(
      storages,
      and(
        eq(storages.id, officialWorkflowDefinitionRevisions.storageId),
        eq(storages.name, officialWorkflowDefinitionRevisions.storageName),
        eq(storages.orgId, SYSTEM_ORG_ID),
        eq(storages.userId, VOLUME_ORG_USER_ID),
      ),
    )
    .innerJoin(
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
    .where(
      and(
        eq(
          officialWorkflowDefinitionRevisions.authority,
          currentOfficialWorkflowCatalogAuthority(),
        ),
        or(
          ...identities.map((identity) => {
            return and(
              eq(
                officialWorkflowDefinitionRevisions.definitionName,
                officialWorkflowCatalogDefinitionKey(
                  currentOfficialWorkflowCatalogAuthority(),
                  identity.name,
                ),
              ),
              eq(
                officialWorkflowDefinitionRevisions.revision,
                identity.revision,
              ),
            );
          }),
        ),
      ),
    )
    .orderBy(
      asc(officialWorkflowDefinitionRevisions.definitionName),
      asc(officialWorkflowDefinitionRevisions.revision),
    );
  signal?.throwIfAborted();
  const revisionByIdentity = new Map(
    rows.map((row) => {
      const revision = acceptedRevisionFromRow(row);
      return [
        officialWorkflowRevisionIdentityKey({
          name: revision.definition.name,
          revision: row.revision,
        }),
        revision,
      ] as const;
    }),
  );
  return identities.map((identity) => {
    return (
      revisionByIdentity.get(officialWorkflowRevisionIdentityKey(identity)) ??
      null
    );
  });
}

export async function readAcceptedOfficialWorkflowRevision(
  db: ReadonlyDb,
  args: OfficialWorkflowRevisionIdentity,
  signal?: AbortSignal,
): Promise<OfficialWorkflowAcceptedRevision | null> {
  const [revision] = await readAcceptedOfficialWorkflowRevisions(
    db,
    [args],
    signal,
  );
  return revision ?? null;
}

export async function readAllCurrentSchemaOfficialWorkflowRevisions(
  db: ReadonlyDb,
  signal?: AbortSignal,
): Promise<readonly OfficialWorkflowAcceptedRevision[]> {
  const rows = await db
    .select({
      authority: officialWorkflowDefinitionRevisions.authority,
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
    .where(
      eq(
        officialWorkflowDefinitionRevisions.authority,
        currentOfficialWorkflowCatalogAuthority(),
      ),
    )
    .orderBy(
      asc(officialWorkflowDefinitionRevisions.definitionName),
      asc(officialWorkflowDefinitionRevisions.revision),
    );
  signal?.throwIfAborted();
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
}
