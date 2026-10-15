import type { ConnectorCatalogSyncFailureCode } from "@okouai/api-contracts/contracts/connector-catalog-sync";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { and, eq, inArray } from "drizzle-orm";

import { command } from "ccstate";
import { db$, writeDb$ } from "../external/db";
import type {
  ConnectorCatalogArtifact,
  ConnectorCatalogArtifactConnector,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { enqueuePiResourceVersionIndexes$ } from "./pi-resource-version-index.service";

const SYSTEM_STORAGE_CREATOR = "system";

type BundledConnectorSkill = Extract<
  ConnectorCatalogArtifactConnector["skill"],
  { readonly kind: "bundled" }
>;

interface ExistingStorageVersion {
  readonly id: string;
  readonly storageId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly s3Prefix: string;
  readonly s3Key: string;
}

interface ConnectorSkillIdentity {
  readonly storageName: string;
  readonly versionId: string;
  readonly s3Prefix: string;
  readonly s3Key: string;
}

export interface PreparedConnectorSkillRegistration {
  readonly provenance: "catalog" | "existing";
  readonly storageName: string;
  readonly versionId: string;
  readonly s3Prefix: string;
  readonly s3Key: string;
  readonly size: number;
  readonly archiveSize: number;
  readonly fileCount: number;
}

export interface ConnectorCatalogSkillFailure {
  readonly code: ConnectorCatalogSyncFailureCode;
  readonly cacheable: boolean;
}

class ConnectorCatalogSkillError extends Error {
  constructor(readonly failure: ConnectorCatalogSkillFailure) {
    super(failure.code);
    this.name = "ConnectorCatalogSkillError";
  }
}

export function connectorCatalogSkillFailure(
  error: unknown,
): ConnectorCatalogSkillFailure | undefined {
  return error instanceof ConnectorCatalogSkillError
    ? error.failure
    : undefined;
}

function fail(
  code: ConnectorCatalogSyncFailureCode,
  cacheable: boolean,
): never {
  throw new ConnectorCatalogSkillError({ code, cacheable });
}

function skillIdentity(skill: BundledConnectorSkill): ConnectorSkillIdentity {
  const s3Prefix = `__system__/volume/${skill.storageName}`;
  return {
    storageName: skill.storageName,
    versionId: skill.versionId,
    s3Prefix,
    s3Key: `${s3Prefix}/${skill.versionId}`,
  };
}

function registrationFromSkill(
  skill: BundledConnectorSkill,
): PreparedConnectorSkillRegistration {
  return {
    ...skillIdentity(skill),
    provenance: "catalog",
    size: skill.size,
    archiveSize: skill.archiveSize,
    fileCount: skill.fileCount,
  };
}

function existingVersionMatchesRegistration(
  existing: ExistingStorageVersion,
  registration: PreparedConnectorSkillRegistration,
): boolean {
  return (
    existing.orgId === SYSTEM_ORG_ID &&
    existing.userId === VOLUME_ORG_USER_ID &&
    existing.name === registration.storageName &&
    existing.s3Prefix === registration.s3Prefix &&
    existing.id === registration.versionId &&
    existing.s3Key === registration.s3Key
  );
}

const readExistingVersions$ = command(
  async (
    { get },
    versionIds: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, ExistingStorageVersion>> => {
    if (versionIds.length === 0) {
      return new Map();
    }
    const rows = await get(db$)
      .select({
        id: storageVersions.id,
        storageId: storageVersions.storageId,
        orgId: storages.orgId,
        userId: storages.userId,
        name: storages.name,
        s3Prefix: storages.s3Prefix,
        s3Key: storageVersions.s3Key,
      })
      .from(storageVersions)
      .innerJoin(storages, eq(storageVersions.storageId, storages.id))
      .where(inArray(storageVersions.id, [...new Set(versionIds)]));
    signal.throwIfAborted();
    return new Map(
      rows.map((row) => {
        return [row.id, row] as const;
      }),
    );
  },
);

function connectorCatalogSkillRegistrationValues(
  artifact: ConnectorCatalogArtifact,
  existingVersions: readonly ExistingStorageVersion[],
): readonly PreparedConnectorSkillRegistration[] {
  const existingByVersion = new Map(
    existingVersions.map((row) => {
      return [row.id, row] as const;
    }),
  );
  return artifact.connectors.flatMap((connector) => {
    if (connector.skill.kind !== "bundled") {
      return [];
    }
    const registration = registrationFromSkill(connector.skill);
    const existing = existingByVersion.get(connector.skill.versionId);
    if (!existing) {
      return [registration];
    }
    if (!existingVersionMatchesRegistration(existing, registration)) {
      fail("invalid-reference", false);
    }
    return [{ ...registration, provenance: "existing" as const }];
  });
}

export const prepareConnectorCatalogSkills$ = command(
  async (
    { set },
    artifact: ConnectorCatalogArtifact,
    signal: AbortSignal,
  ): Promise<readonly PreparedConnectorSkillRegistration[]> => {
    const bundledSkills = artifact.connectors.flatMap((connector) => {
      return connector.skill.kind === "bundled" ? [connector.skill] : [];
    });
    const existingByVersion = await set(
      readExistingVersions$,
      bundledSkills.map((skill) => {
        return skill.versionId;
      }),
      signal,
    );
    return connectorCatalogSkillRegistrationValues(artifact, [
      ...existingByVersion.values(),
    ]);
  },
);

function missingRegistrations(
  registrations: readonly PreparedConnectorSkillRegistration[],
  existingByVersion: ReadonlyMap<string, ExistingStorageVersion>,
): readonly PreparedConnectorSkillRegistration[] {
  const missing: PreparedConnectorSkillRegistration[] = [];
  for (const registration of registrations) {
    const existing = existingByVersion.get(registration.versionId);
    if (existing) {
      if (!existingVersionMatchesRegistration(existing, registration)) {
        fail("invalid-reference", false);
      }
      continue;
    }
    if (registration.provenance === "existing") {
      fail("invalid-reference", false);
    }
    missing.push(registration);
  }
  return missing;
}

export const registerPreparedConnectorCatalogSkills$ = command(
  async (
    { get, set },
    registrations: readonly PreparedConnectorSkillRegistration[],
    signal: AbortSignal,
  ): Promise<void> => {
    if (registrations.length === 0) {
      return;
    }
    const existingByVersion = await set(
      readExistingVersions$,
      registrations.map((registration) => {
        return registration.versionId;
      }),
      signal,
    );
    const missing = missingRegistrations(registrations, existingByVersion);
    if (missing.length > 0) {
      const db = set(writeDb$);
      await db
        .insert(storages)
        .values(
          missing.map((registration) => {
            return {
              orgId: SYSTEM_ORG_ID,
              userId: VOLUME_ORG_USER_ID,
              name: registration.storageName,
              s3Prefix: registration.s3Prefix,
              size: registration.size,
              fileCount: registration.fileCount,
            };
          }),
        )
        .onConflictDoNothing();
      signal.throwIfAborted();

      const rows = await get(db$)
        .select({
          id: storages.id,
          name: storages.name,
          s3Prefix: storages.s3Prefix,
        })
        .from(storages)
        .where(
          and(
            eq(storages.orgId, SYSTEM_ORG_ID),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            inArray(
              storages.name,
              missing.map((registration) => {
                return registration.storageName;
              }),
            ),
          ),
        );
      signal.throwIfAborted();
      const storageByName = new Map(
        rows.map((row) => {
          return [row.name, row] as const;
        }),
      );
      for (const registration of missing) {
        const storage = storageByName.get(registration.storageName);
        if (!storage) {
          throw new Error("Connector skill storage was not created");
        }
        if (storage.s3Prefix !== registration.s3Prefix) {
          fail("invalid-reference", false);
        }
      }

      await db
        .insert(storageVersions)
        .values(
          missing.map((registration) => {
            const storage = storageByName.get(registration.storageName);
            if (!storage) {
              throw new Error("Connector skill storage is unavailable");
            }
            return {
              id: registration.versionId,
              storageId: storage.id,
              s3Key: registration.s3Key,
              size: registration.size,
              archiveSize: registration.archiveSize,
              fileCount: registration.fileCount,
              message: null,
              createdBy: SYSTEM_STORAGE_CREATOR,
            };
          }),
        )
        .onConflictDoNothing();
      signal.throwIfAborted();
      // A concurrent registrant may win the version INSERT. Reuse its metadata;
      // only the canonical owner/name/path identity must match this catalog skill.
      const registered = await set(
        readExistingVersions$,
        missing.map((registration) => {
          return registration.versionId;
        }),
        signal,
      );
      if (missingRegistrations(missing, registered).length > 0) {
        throw new Error("Connector skill storage version was not created");
      }
    }
    await set(
      enqueuePiResourceVersionIndexes$,
      registrations.map((registration) => {
        return registration.versionId;
      }),
      signal,
    );
  },
);
