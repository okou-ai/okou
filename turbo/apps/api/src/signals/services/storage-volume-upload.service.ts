import { command } from "ccstate";
import {
  and,
  count,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { WithSubquery } from "drizzle-orm/subquery";
import {
  pgBooleanDecoder,
  nullableDriverValueDecoder,
} from "../../lib/db-structured-result";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { piResourceVersionIndexes } from "@okouai/db/schema/pi-resource-version-index";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { PI_RESOURCE_EXTRACTOR_VERSION } from "../../lib/pi-resource-index";
import {
  prepareVolumeServerSide$,
  type PreparedServerSideVolume,
  type PrepareVolumeServerSideInput,
} from "./storage-volume-publication.service";
import {
  StorageVersionIdentityConflictError,
  type PreparedStorageVersion,
} from "./storage-version-registration.service";
import { piResourceProjectionValues } from "./pi-resource-version-index.service";
interface UploadedVolume {
  readonly storageName: string;
  readonly versionId: string;
}
type UploadVolumeServerSideInput = PrepareVolumeServerSideInput;

function storageHeadValues(volume: PreparedServerSideVolume) {
  return {
    headVersionId: volume.version.versionId,
    size: volume.version.size,
    fileCount: volume.version.fileCount,
    updatedAt: volume.updatedAt,
  };
}

interface PreparedVolumePublication {
  readonly volume: PreparedServerSideVolume;
}

function uploadRowExists(source: WithSubquery) {
  return exists(new QueryBuilder().select({ value: sql`1` }).from(source));
}

function uploadMutationCompleted(source: WithSubquery) {
  return gte(new QueryBuilder().select({ value: count() }).from(source), 0);
}

/** Real Storage ownership gates registration, HEAD and the resource index. */
function preparedUploadAdmissionPlan(args: PreparedVolumePublication) {
  const query = new QueryBuilder();
  const storage = query
    .$with("retained_upload_storage")
    .as(
      query
        .select({ id: storages.id })
        .from(storages)
        .where(eq(storages.id, args.volume.version.storageId))
        .for("key share", { of: storages })
        .limit(1),
    );
  const source = query
    .$with("admitted_upload_source")
    .as(query.select({ id: storage.id }).from(storage));
  return { storage, source, ctes: [storage, source] };
}

function uploadedVersionSource(version: PreparedStorageVersion) {
  return {
    id: sql`${sql.param(version.versionId, storageVersions.id)}`
      .mapWith(storageVersions.id)
      .as("id"),
    storageId: sql`${sql.param(version.storageId, storageVersions.storageId)}`
      .mapWith(storageVersions.storageId)
      .as("storage_id"),
    s3Key: sql`${sql.param(version.s3Key, storageVersions.s3Key)}`
      .mapWith(storageVersions.s3Key)
      .as("s3_key"),
    size: sql`${sql.param(version.size, storageVersions.size)}`
      .mapWith(storageVersions.size)
      .as("size"),
    archiveSize:
      sql`${sql.param(version.archiveSize, storageVersions.archiveSize)}`
        .mapWith(storageVersions.archiveSize)
        .as("archive_size"),
    fileCount: sql`${sql.param(version.fileCount, storageVersions.fileCount)}`
      .mapWith(storageVersions.fileCount)
      .as("file_count"),
    message: sql`${sql.param(version.message, storageVersions.message)}`
      .mapWith(nullableDriverValueDecoder(storageVersions.message))
      .as("message"),
    createdBy: sql`${sql.param(version.createdBy, storageVersions.createdBy)}`
      .mapWith(storageVersions.createdBy)
      .as("created_by"),
    createdAt: sql`now()`.mapWith(storageVersions.createdAt).as("created_at"),
  };
}

function uploadedVersionIdentity(version: PreparedStorageVersion) {
  return and(
    eq(storageVersions.storageId, version.storageId),
    eq(storageVersions.s3Key, version.s3Key),
    eq(storageVersions.size, version.size),
    eq(storageVersions.archiveSize, version.archiveSize),
    eq(storageVersions.fileCount, version.fileCount),
    version.message === null
      ? isNull(storageVersions.message)
      : eq(storageVersions.message, version.message),
    eq(storageVersions.createdBy, version.createdBy),
  );
}

function uploadedIndexSource(
  volume: PreparedServerSideVolume,
  projection: ReturnType<typeof piResourceProjectionValues> | undefined,
) {
  const index = piResourceVersionIndexes;
  return {
    storageVersionId:
      sql`${sql.param(volume.version.versionId, index.storageVersionId)}`
        .mapWith(index.storageVersionId)
        .as("storage_version_id"),
    extractorVersion:
      sql`${sql.param(PI_RESOURCE_EXTRACTOR_VERSION, index.extractorVersion)}`
        .mapWith(index.extractorVersion)
        .as("extractor_version"),
    status: sql`${sql.param(projection?.status ?? "pending", index.status)}`
      .mapWith(index.status)
      .as("status"),
    projection:
      sql`${sql.param(projection?.projection ?? null, index.projection)}`
        .mapWith(nullableDriverValueDecoder(index.projection))
        .as("projection"),
    sourceArchiveSize:
      sql`${sql.param(volume.version.archiveSize, index.sourceArchiveSize)}`
        .mapWith(nullableDriverValueDecoder(index.sourceArchiveSize))
        .as("source_archive_size"),
    projectionHash:
      sql`${sql.param(projection?.projectionHash ?? null, index.projectionHash)}`
        .mapWith(nullableDriverValueDecoder(index.projectionHash))
        .as("projection_hash"),
    leaseId: sql`NULL`
      .mapWith(nullableDriverValueDecoder(index.leaseId))
      .as("lease_id"),
    leaseExpiresAt: sql`NULL`
      .mapWith(nullableDriverValueDecoder(index.leaseExpiresAt))
      .as("lease_expires_at"),
    availableAt: sql`now()`.mapWith(index.availableAt).as("available_at"),
    attemptCount: sql`0`.mapWith(index.attemptCount).as("attempt_count"),
    createdAt: sql`now()`.mapWith(index.createdAt).as("created_at"),
    updatedAt: (projection
      ? sql`${sql.param(projection.updatedAt, index.updatedAt)}`
      : sql`now()`
    )
      .mapWith(index.updatedAt)
      .as("updated_at"),
  };
}

function uploadedIndexRepairValues(volume: PreparedServerSideVolume, at: Date) {
  return {
    status: "pending" as const,
    projection: null,
    projectionHash: null,
    sourceArchiveSize: volume.version.archiveSize,
    leaseId: null,
    leaseExpiresAt: null,
    availableAt: at,
    attemptCount: 0,
    updatedAt: at,
  };
}

function requirePreparedUploadPublication(
  version: PreparedStorageVersion,
  result:
    | {
        readonly storagePresent: boolean;
        readonly registered: boolean;
        readonly published: boolean;
        readonly settled: boolean;
      }
    | undefined,
) {
  if (!result) {
    throw new Error("Prepared volume publication returned no result");
  }
  if (!result.storagePresent) {
    throw new Error("Prepared volume Storage no longer exists");
  }
  if (!result.registered) {
    throw new StorageVersionIdentityConflictError(version.versionId);
  }
  if (!result.published || !result.settled) {
    throw new Error("Locked prepared volume publication did not complete");
  }
}

function preparedUploadSelection(
  plan: ReturnType<typeof preparedUploadAdmissionPlan>,
  registered: WithSubquery,
  published: WithSubquery,
  settled: SQL,
) {
  return {
    storagePresent: uploadRowExists(plan.storage).mapWith(pgBooleanDecoder),
    registered: uploadRowExists(registered).mapWith(pgBooleanDecoder),
    published: uploadRowExists(published).mapWith(pgBooleanDecoder),
    settled: settled.mapWith(pgBooleanDecoder),
  };
}

/** One publication statement gates all writes on the real Storage/version outcomes. */
const commitPreparedVolumeUpload$ = command(
  async (
    { set },
    args: PreparedVolumePublication,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const version = args.volume.version;
    const projection =
      args.volume.piResourceIndex?.kind === "prepared"
        ? piResourceProjectionValues(
            args.volume.piResourceIndex.projection,
            version.archiveSize,
            nowDate(),
          )
        : undefined;
    const plan = preparedUploadAdmissionPlan(args);
    const ctes: WithSubquery[] = [...plan.ctes];
    const registered = db.$with("registered_upload_version").as(
      db
        .insert(storageVersions)
        .select(db.select(uploadedVersionSource(version)).from(plan.source))
        .onConflictDoUpdate({
          target: storageVersions.id,
          set: { id: version.versionId },
          setWhere: uploadedVersionIdentity(version),
        })
        .returning({
          id: storageVersions.id,
          storageId: storageVersions.storageId,
        }),
    );
    const published = db.$with("published_upload_head").as(
      db
        .update(storages)
        .set(storageHeadValues(args.volume))
        .where(
          inArray(
            storages.id,
            db.select({ id: registered.storageId }).from(registered),
          ),
        )
        .returning({ id: storages.id }),
    );
    ctes.push(registered, published);
    let completed = uploadRowExists(published);
    if (args.volume.piResourceIndex?.kind !== "reused") {
      const index = db.$with("published_upload_index").as(
        db
          .insert(piResourceVersionIndexes)
          .select(
            db
              .select(uploadedIndexSource(args.volume, projection))
              .from(published),
          )
          .onConflictDoUpdate({
            target: [
              piResourceVersionIndexes.storageVersionId,
              piResourceVersionIndexes.extractorVersion,
            ],
            set:
              projection ?? uploadedIndexRepairValues(args.volume, nowDate()),
            setWhere: projection
              ? undefined
              : sql`${piResourceVersionIndexes.sourceArchiveSize} IS DISTINCT FROM ${version.archiveSize}`,
          })
          .returning({ id: piResourceVersionIndexes.storageVersionId }),
      );
      ctes.push(index);
      completed = exists(
        db
          .select({ id: published.id })
          .from(published)
          .where(uploadMutationCompleted(index)),
      );
    }
    signal.throwIfAborted();
    const [result] = await db
      .with(...ctes)
      .select(preparedUploadSelection(plan, registered, published, completed))
      .from(sql`(VALUES (1)) AS upload_result_source`);
    signal.throwIfAborted();
    requirePreparedUploadPublication(version, result);
  },
);

export const uploadVolumeServerSide$ = command(
  async (
    { set },
    args: UploadVolumeServerSideInput,
    signal: AbortSignal,
  ): Promise<UploadedVolume> => {
    const volume = await set(prepareVolumeServerSide$, args, signal);
    await set(
      commitPreparedVolumeUpload$,
      {
        volume,
      },
      signal,
    );
    signal.throwIfAborted();
    return {
      storageName: volume.storageName,
      versionId: volume.version.versionId,
    };
  },
);
