import type { ConnectorCatalogSyncFailureCode } from "@okouai/api-contracts/contracts/connector-catalog-diagnostics";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { and, eq, inArray, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import type {
  ConnectorCatalogArtifact,
  ConnectorCatalogArtifactConnector,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import {
  registerPreparedStorageVersions,
  storageVersionMatches,
  StorageVersionIdentityConflictError,
  type PreparedStorageVersion,
} from "./storage-version-registration.service";

import { enqueuePiResourceVersionIndexes } from "./pi-resource-version-index.service";

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
  readonly size: number;
  readonly archiveSize: number;
  readonly fileCount: number;
  readonly message: string | null;
  readonly createdBy: string;
}

interface CanonicalStorage {
  readonly id: string;
  readonly name: string;
  readonly s3Prefix: string;
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
  const versionSuffix = `/${skill.versionId}`;
  if (!skill.storageVersionPrefix.endsWith(versionSuffix)) {
    throw new Error("Connector skill storage version prefix is invalid");
  }
  const s3Prefix = skill.storageVersionPrefix.slice(0, -versionSuffix.length);
  return {
    storageName: skill.storageName,
    versionId: skill.versionId,
    s3Prefix,
    s3Key: skill.storageVersionPrefix,
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
    storageVersionMatches(
      {
        storageId: existing.storageId,
        versionId: existing.id,
        s3Key: existing.s3Key,
        size: existing.size,
        archiveSize: existing.archiveSize,
        fileCount: existing.fileCount,
        message: existing.message,
        createdBy: existing.createdBy,
      },
      preparedStorageVersion(registration, existing.storageId),
    )
  );
}

function preparedStorageVersion(
  registration: PreparedConnectorSkillRegistration,
  storageId: string,
): PreparedStorageVersion {
  return {
    storageId,
    versionId: registration.versionId,
    s3Key: registration.s3Key,
    size: registration.size,
    archiveSize: registration.archiveSize,
    fileCount: registration.fileCount,
    message: null,
    createdBy: SYSTEM_STORAGE_CREATOR,
  };
}

async function readExistingVersions(
  db: ReadonlyDb,
  versionIds: readonly string[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, ExistingStorageVersion>> {
  if (versionIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      id: storageVersions.id,
      storageId: storageVersions.storageId,
      orgId: storages.orgId,
      userId: storages.userId,
      name: storages.name,
      s3Prefix: storages.s3Prefix,
      s3Key: storageVersions.s3Key,
      size: storageVersions.size,
      archiveSize: storageVersions.archiveSize,
      fileCount: storageVersions.fileCount,
      message: storageVersions.message,
      createdBy: storageVersions.createdBy,
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
}

export async function prepareConnectorCatalogSkills(
  args: {
    readonly db: ReadonlyDb;
    readonly artifact: ConnectorCatalogArtifact;
  },
  signal: AbortSignal,
): Promise<readonly PreparedConnectorSkillRegistration[]> {
  const bundledSkills = args.artifact.connectors.flatMap((connector) => {
    return connector.skill.kind === "bundled" ? [connector.skill] : [];
  });
  const existingByVersion = await readExistingVersions(
    args.db,
    bundledSkills.map((skill) => {
      return skill.versionId;
    }),
    signal,
  );
  return bundledSkills.map((skill) => {
    const registration = registrationFromSkill(skill);
    const existing = existingByVersion.get(skill.versionId);
    if (!existing) {
      return registration;
    }
    if (!existingVersionMatchesRegistration(existing, registration)) {
      fail("invalid-reference", false);
    }
    return { ...registration, provenance: "existing" };
  });
}

async function missingRegistrations(
  db: Db,
  registrations: readonly PreparedConnectorSkillRegistration[],
  signal: AbortSignal,
): Promise<readonly PreparedConnectorSkillRegistration[]> {
  const existingByVersion = await readExistingVersions(
    db,
    registrations.map((registration) => {
      return registration.versionId;
    }),
    signal,
  );
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

async function createAndReadCanonicalStorages(
  db: Db,
  registrations: readonly PreparedConnectorSkillRegistration[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, CanonicalStorage>> {
  await db
    .insert(storages)
    .values(
      registrations.map((registration) => {
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

  const rows = await db
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
          registrations.map((registration) => {
            return registration.storageName;
          }),
        ),
      ),
    );
  signal.throwIfAborted();
  const byName = new Map(
    rows.map((row) => {
      return [row.name, row] as const;
    }),
  );
  for (const registration of registrations) {
    const storage = byName.get(registration.storageName);
    if (!storage) {
      throw new Error("Connector skill storage was not created");
    }
    if (storage.s3Prefix !== registration.s3Prefix) {
      fail("invalid-reference", false);
    }
  }
  return byName;
}

async function registerMissingStorageVersions(
  db: Db,
  registrations: readonly PreparedConnectorSkillRegistration[],
  storageByName: ReadonlyMap<string, CanonicalStorage>,
  signal: AbortSignal,
): Promise<ReadonlySet<string>> {
  const versions = registrations.map((registration) => {
    const storage = storageByName.get(registration.storageName);
    if (!storage) {
      throw new Error("Connector skill storage is unavailable");
    }
    return preparedStorageVersion(registration, storage.id);
  });
  const result = await settle(
    registerPreparedStorageVersions({ db, versions }, signal),
    signal,
  );
  if (result.ok) {
    return result.value;
  }
  if (result.error instanceof StorageVersionIdentityConflictError) {
    fail("invalid-reference", false);
  }
  throw result.error;
}

async function updateNewStorageHeads(
  db: Db,
  registrations: readonly PreparedConnectorSkillRegistration[],
  signal: AbortSignal,
): Promise<void> {
  const updatedAt = nowDate();
  const updated = await db
    .insert(storages)
    .values(
      registrations.map((registration) => {
        return {
          orgId: SYSTEM_ORG_ID,
          userId: VOLUME_ORG_USER_ID,
          name: registration.storageName,
          s3Prefix: registration.s3Prefix,
          size: registration.size,
          fileCount: registration.fileCount,
          headVersionId: registration.versionId,
          updatedAt,
        };
      }),
    )
    .onConflictDoUpdate({
      target: [storages.orgId, storages.userId, storages.name],
      set: {
        headVersionId: sql`excluded.head_version_id`,
        size: sql`excluded.size`,
        fileCount: sql`excluded.file_count`,
        updatedAt: sql`excluded.updated_at`,
      },
      setWhere: eq(storages.s3Prefix, sql`excluded.s3_prefix`),
    })
    .returning({ name: storages.name });
  signal.throwIfAborted();
  if (updated.length !== registrations.length) {
    fail("invalid-reference", false);
  }
}

async function registerConnectorCatalogSkills(
  db: Db,
  registrations: readonly PreparedConnectorSkillRegistration[],
  signal: AbortSignal,
): Promise<void> {
  const missing = await missingRegistrations(db, registrations, signal);
  if (missing.length === 0) {
    return;
  }
  const storageByName = await createAndReadCanonicalStorages(
    db,
    missing,
    signal,
  );
  const insertedVersionIds = await registerMissingStorageVersions(
    db,
    missing,
    storageByName,
    signal,
  );
  const newHeads = missing.filter((registration) => {
    return insertedVersionIds.has(registration.versionId);
  });
  if (newHeads.length === 0) {
    return;
  }
  await updateNewStorageHeads(db, newHeads, signal);
}

export async function registerPreparedConnectorCatalogSkills(
  args: {
    readonly db: Db;
    readonly registrations: readonly PreparedConnectorSkillRegistration[];
  },
  signal: AbortSignal,
): Promise<void> {
  if (args.registrations.length === 0) {
    return;
  }
  await registerConnectorCatalogSkills(args.db, args.registrations, signal);
  await enqueuePiResourceVersionIndexes(
    args.db,
    args.registrations.map((registration) => {
      return registration.versionId;
    }),
    signal,
  );
}
