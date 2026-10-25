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
import { workflows } from "@okouai/db/schema/workflow";
import type { WorkflowAttachments } from "@okouai/db/jsonb-contracts/workflow";
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
import {
  generationScopeCondition,
  publicationScopeCondition,
  type StoragePublicationFence,
} from "./storage-publication-fence.service";
import {
  storagePublicationGenerations,
  storagePublicationTokens,
} from "@okouai/db/schema/storage-publication-fence";

interface UploadedVolume {
  readonly storageName: string;
  readonly versionId: string;
}
type UploadVolumeServerSideInput = PrepareVolumeServerSideInput & {
  readonly publicationFence?: StoragePublicationFence;
  readonly workflowAttachments?: {
    readonly workflowId: string;
    readonly orgId: string;
    readonly attachments: WorkflowAttachments;
  };
};
class StalePublicationFenceError extends Error {}
export function isStalePublicationFenceError(error: unknown): boolean {
  return error instanceof StalePublicationFenceError;
}

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
  readonly publicationFence?: StoragePublicationFence;
  readonly workflowAttachments?: UploadVolumeServerSideInput["workflowAttachments"];
}

function uploadRowExists(source: WithSubquery) {
  return exists(new QueryBuilder().select({ value: sql`1` }).from(source));
}

function uploadMutationCompleted(source: WithSubquery) {
  return gte(new QueryBuilder().select({ value: count() }).from(source), 0);
}

function uploadAttachmentCondition(args: PreparedVolumePublication) {
  const descriptor = args.workflowAttachments;
  const fence = args.publicationFence;
  if (!descriptor || !fence) {
    throw new Error("Missing Workflow publication fence");
  }
  return and(
    eq(workflows.id, descriptor.workflowId),
    eq(workflows.orgId, descriptor.orgId),
    eq(workflows.agentId, fence.scope.agentId),
    isNull(workflows.officialDefinitionName),
  );
}

/** Locks are acquired in Workflow -> Storage -> generation -> token order. */
function preparedUploadAdmissionPlan(args: PreparedVolumePublication) {
  const query = new QueryBuilder();
  const workflow = args.workflowAttachments
    ? query
        .$with("retained_upload_workflow")
        .as(
          query
            .select({ id: workflows.id })
            .from(workflows)
            .where(uploadAttachmentCondition(args))
            .for("no key update", { of: workflows })
            .limit(1),
        )
    : undefined;
  const storage = query.$with("retained_upload_storage").as(
    query
      .select({ id: storages.id })
      .from(storages)
      .where(
        and(
          eq(storages.id, args.volume.version.storageId),
          workflow ? uploadRowExists(workflow) : undefined,
        ),
      )
      .for("key share", { of: storages })
      .limit(1),
  );
  const fence = args.publicationFence;
  const generation = fence
    ? query.$with("retained_upload_generation").as(
        query
          .select({ id: storagePublicationGenerations.generation })
          .from(storagePublicationGenerations)
          .where(
            and(
              generationScopeCondition(fence.scope),
              uploadRowExists(storage),
            ),
          )
          .for("no key update", { of: storagePublicationGenerations })
          .limit(1),
      )
    : undefined;
  const token =
    fence && generation
      ? query.$with("retained_upload_token").as(
          query
            .select({ id: storagePublicationTokens.token })
            .from(storagePublicationTokens)
            .where(
              and(
                publicationScopeCondition(fence),
                uploadRowExists(generation),
              ),
            )
            .for("update", { of: storagePublicationTokens })
            .limit(1),
        )
      : undefined;
  const source = query.$with("admitted_upload_source").as(
    query
      .select({ id: storage.id })
      .from(storage)
      .where(token ? uploadRowExists(token) : undefined),
  );
  const ctes: WithSubquery[] = [storage];
  if (workflow) {
    ctes.unshift(workflow);
  }
  if (generation && token) {
    ctes.push(generation, token);
  }
  ctes.push(source);
  return { workflow, storage, generation, token, source, ctes };
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
        readonly workflowPresent: boolean;
        readonly storagePresent: boolean;
        readonly fencePresent: boolean;
        readonly registered: boolean;
        readonly published: boolean;
        readonly settled: boolean;
      }
    | undefined,
) {
  if (!result) {
    throw new Error("Prepared volume publication returned no result");
  }
  if (!result.workflowPresent) {
    throw new StalePublicationFenceError(
      "Workflow was removed before attachment publication",
    );
  }
  if (!result.storagePresent) {
    throw new Error("Prepared volume Storage no longer exists");
  }
  if (!result.fencePresent) {
    throw new StalePublicationFenceError(
      "Storage publication was superseded before Storage HEAD commit",
    );
  }
  if (!result.registered) {
    throw new StorageVersionIdentityConflictError(version.versionId);
  }
  if (!result.published || !result.settled) {
    throw new Error("Locked prepared volume publication did not complete");
  }
}

function requirePreparedUploadDescriptor(args: PreparedVolumePublication) {
  const fence = args.publicationFence;
  if (
    args.workflowAttachments &&
    (!fence ||
      fence.publicationKey !==
        `workflow:${args.workflowAttachments.workflowId}` ||
      fence.scope.orgId !== args.workflowAttachments.orgId)
  ) {
    throw new Error(
      "Workflow attachment publication requires its exact Storage fence",
    );
  }
}

function preparedUploadSelection(
  plan: ReturnType<typeof preparedUploadAdmissionPlan>,
  registered: WithSubquery,
  published: WithSubquery,
  settled: SQL,
) {
  return {
    workflowPresent: (plan.workflow
      ? uploadRowExists(plan.workflow)
      : sql`true`
    ).mapWith(pgBooleanDecoder),
    storagePresent: uploadRowExists(plan.storage).mapWith(pgBooleanDecoder),
    fencePresent: (plan.token
      ? uploadRowExists(plan.token)
      : sql`true`
    ).mapWith(pgBooleanDecoder),
    registered: uploadRowExists(registered).mapWith(pgBooleanDecoder),
    published: uploadRowExists(published).mapWith(pgBooleanDecoder),
    settled: settled.mapWith(pgBooleanDecoder),
  };
}

/** One publication statement gates all writes on the real parent/token/version outcomes. */
const commitPreparedVolumeUpload$ = command(
  async (
    { set },
    args: PreparedVolumePublication,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const version = args.volume.version;
    const fence = args.publicationFence;
    requirePreparedUploadDescriptor(args);
    const projection =
      args.volume.piResourceIndex?.kind === "prepared"
        ? piResourceProjectionValues(
            args.volume.piResourceIndex.projection,
            version.archiveSize,
            nowDate(),
          )
        : undefined;
    const plan = preparedUploadAdmissionPlan(args);
    const ctes = [...plan.ctes];
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
    if (args.workflowAttachments) {
      const updated = db.$with("published_upload_attachments").as(
        db
          .update(workflows)
          .set({ attachments: args.workflowAttachments.attachments })
          .where(and(uploadAttachmentCondition(args), completed))
          .returning({ id: workflows.id }),
      );
      ctes.push(updated);
      completed = uploadRowExists(updated);
    }
    let settled = completed;
    if (fence) {
      const generation = db.$with("settled_upload_generation").as(
        db
          .update(storagePublicationGenerations)
          .set({ updatedAt: nowDate() })
          .where(and(generationScopeCondition(fence.scope), completed))
          .returning({ id: storagePublicationGenerations.agentId }),
      );
      const token = db.$with("settled_upload_token").as(
        db
          .delete(storagePublicationTokens)
          .where(
            and(publicationScopeCondition(fence), uploadRowExists(generation)),
          )
          .returning({ id: storagePublicationTokens.token }),
      );
      ctes.push(generation, token);
      settled = uploadRowExists(token);
    }
    signal.throwIfAborted();
    const [result] = await db
      .with(...ctes)
      .select(preparedUploadSelection(plan, registered, published, settled))
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
        publicationFence: args.publicationFence,
        workflowAttachments: args.workflowAttachments,
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
