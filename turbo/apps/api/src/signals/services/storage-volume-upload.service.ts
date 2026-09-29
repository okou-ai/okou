import { command } from "ccstate";
import { repairVolumeIndexSql } from "./storage-volume-publication-sql";
import { z } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { piResourceVersionIndexes } from "@okouai/db/schema/pi-resource-version-index";
import {
  piStableContextGenerations,
  piStableContextHeads,
  piStableContextPublications,
} from "@okouai/db/schema/pi-stable-context";
import type { PiStableContextBuildInput } from "@okouai/db/jsonb-contracts/pi-stable-context";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { PI_RESOURCE_EXTRACTOR_VERSION } from "../../lib/pi-resource-index";
import {
  prepareVolumeServerSide$,
  type PreparedServerSideVolume,
  type PrepareVolumeServerSideInput,
} from "./storage-volume-publication.service";
import {
  storageVersionMatches,
  StorageVersionIdentityConflictError,
  type PreparedStorageVersion,
} from "./storage-version-registration.service";
import { piResourceProjectionValues } from "./pi-resource-version-index.service";
import { piStableContextInputDigest } from "./pi-stable-context-digest.service";
import {
  generationScopeCondition,
  publicationScopeCondition,
  headScopeCondition,
  rebindStorageMount,
  subjectForScope,
  type PiStableContextPublicationFence,
} from "./pi-stable-context-generation.service";

interface UploadedVolume {
  readonly storageName: string;
  readonly versionId: string;
}
type UploadVolumeServerSideInput = PrepareVolumeServerSideInput & {
  readonly stableContextPublication?: PiStableContextPublicationFence;
};
class StalePiStableContextPublicationError extends Error {}
export function isStalePiStableContextPublicationError(
  error: unknown,
): boolean {
  return error instanceof StalePiStableContextPublicationError;
}

const preparedStorageVersionColumns = Object.freeze({
  storageId: storageVersions.storageId,
  versionId: storageVersions.id,
  s3Key: storageVersions.s3Key,
  size: storageVersions.size,
  archiveSize: storageVersions.archiveSize,
  fileCount: storageVersions.fileCount,
  message: storageVersions.message,
  createdBy: storageVersions.createdBy,
});
function storageVersionValues(version: PreparedStorageVersion) {
  return {
    id: version.versionId,
    storageId: version.storageId,
    s3Key: version.s3Key,
    size: version.size,
    archiveSize: version.archiveSize,
    fileCount: version.fileCount,
    message: version.message,
    createdBy: version.createdBy,
  };
}
function storageHeadValues(volume: PreparedServerSideVolume) {
  return {
    headVersionId: volume.version.versionId,
    size: volume.version.size,
    fileCount: volume.version.fileCount,
    updatedAt: volume.updatedAt,
  };
}

function reboundHeadValues(
  head: {
    readonly generation: number;
    readonly input: PiStableContextBuildInput | null;
  },
  version: PreparedStorageVersion,
) {
  if (
    !head.input ||
    !head.input.storageMounts.some((mount) => {
      return mount.storageId === version.storageId;
    })
  ) {
    return null;
  }
  const resource = {
    storageId: version.storageId,
    versionId: version.versionId,
    archiveSize: version.archiveSize,
    fileCount: version.fileCount,
  };
  const input: PiStableContextBuildInput = {
    ...head.input,
    storageMounts: head.input.storageMounts.map((mount) => {
      return rebindStorageMount(mount, resource);
    }),
    persistedStorageMounts: head.input.persistedStorageMounts.map((mount) => {
      return mount.storageId === version.storageId
        ? { ...mount, version: version.versionId }
        : mount;
    }),
  };
  const at = nowDate();
  return {
    generation: head.generation + 1,
    status: "pending" as const,
    input,
    inputDigest: piStableContextInputDigest(input),
    artifactDigest: null,
    validityHorizon: input.source.validityHorizon
      ? new Date(input.source.validityHorizon)
      : null,
    leaseId: null,
    leaseExpiresAt: null,
    availableAt: at,
    attemptCount: 0,
    lastErrorClass: null,
    updatedAt: at,
  };
}
const publicationCompletionSchema = z.object({ completed: z.literal(1) });
function completeVolumePublicationSql(fence: PiStableContextPublicationFence) {
  const scope = fence.scope;
  return sql`WITH completed AS (
    DELETE FROM ${piStableContextPublications} WHERE ${publicationScopeCondition(fence)} RETURNING token
  ) UPDATE ${piStableContextGenerations} SET publication_state = CASE WHEN EXISTS (
    SELECT 1 FROM ${piStableContextPublications} WHERE org_id = ${scope.orgId} AND agent_id = ${scope.agentId}
      AND subject = ${subjectForScope(scope)} AND token NOT IN (SELECT token FROM completed)
  ) THEN 'pending' ELSE 'ready' END, updated_at = ${nowDate().toISOString()}::timestamp
    WHERE ${generationScopeCondition(scope)} AND EXISTS (SELECT 1 FROM completed)
    RETURNING 1::integer AS completed`;
}

function preparedProjection(volume: PreparedServerSideVolume) {
  return volume.piResourceIndex
    ? piResourceProjectionValues(
        volume.piResourceIndex.projection,
        volume.version.archiveSize,
      )
    : undefined;
}

interface PreparedVolumePublication {
  readonly volume: PreparedServerSideVolume;
  readonly stableContextPublication?: PiStableContextPublicationFence;
}

/** Prepared objects are immutable inputs. The transaction never leaves this command. */
const commitPreparedVolumeUpload$ = command(
  async (
    { set },
    args: PreparedVolumePublication,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const version = args.volume.version;
    const fence = args.stableContextPublication;
    const projection = preparedProjection(args.volume);
    await db.transaction(async (tx) => {
      // Own the existing Storage parent before its immutable version, index and
      // publication generation. This is the same order as every source publisher.
      const [storage] = await tx
        .select({ id: storages.id })
        .from(storages)
        .where(eq(storages.id, version.storageId))
        .for("update");
      signal.throwIfAborted();
      if (!storage) {
        throw new Error("Prepared volume Storage no longer exists");
      }
      await tx
        .insert(storageVersions)
        .values(storageVersionValues(version))
        .onConflictDoNothing();
      const [stored] = await tx
        .select(preparedStorageVersionColumns)
        .from(storageVersions)
        .where(eq(storageVersions.id, version.versionId));
      if (!stored || !storageVersionMatches(stored, version)) {
        throw new StorageVersionIdentityConflictError(version.versionId);
      }
      await tx
        .update(storages)
        .set(storageHeadValues(args.volume))
        .where(eq(storages.id, version.storageId));
      if (projection) {
        await tx
          .insert(piResourceVersionIndexes)
          .values({
            storageVersionId: version.versionId,
            extractorVersion: PI_RESOURCE_EXTRACTOR_VERSION,
            ...projection,
          })
          .onConflictDoUpdate({
            target: [
              piResourceVersionIndexes.storageVersionId,
              piResourceVersionIndexes.extractorVersion,
            ],
            set: projection,
          });
      } else {
        await tx
          .insert(piResourceVersionIndexes)
          .values({
            storageVersionId: version.versionId,
            extractorVersion: PI_RESOURCE_EXTRACTOR_VERSION,
            sourceArchiveSize: version.archiveSize,
          })
          .onConflictDoNothing();
        await tx.execute(repairVolumeIndexSql(version));
      }
      signal.throwIfAborted();
      if (!fence) {
        return;
      }
      const [generation] = await tx
        .select({ generation: piStableContextGenerations.generation })
        .from(piStableContextGenerations)
        .where(generationScopeCondition(fence.scope))
        .for("update")
        .limit(1);
      const [publication] = generation
        ? await tx
            .select({ token: piStableContextPublications.token })
            .from(piStableContextPublications)
            .where(publicationScopeCondition(fence))
            .for("update")
            .limit(1)
        : [];
      if (!publication) {
        throw new StalePiStableContextPublicationError(
          "Stable-context publication was superseded before Storage HEAD commit",
        );
      }
      const heads = await tx
        .select({
          id: piStableContextHeads.id,
          generation: piStableContextHeads.generation,
          input: piStableContextHeads.input,
        })
        .from(piStableContextHeads)
        .where(
          and(
            headScopeCondition(fence.scope),
            isNotNull(piStableContextHeads.input),
            isNotNull(piStableContextHeads.inputDigest),
          ),
        )
        .orderBy(asc(piStableContextHeads.id))
        .limit(16)
        .for("update");
      for (const head of heads) {
        const values = reboundHeadValues(head, version);
        if (!values) {
          continue;
        }
        await tx
          .update(piStableContextHeads)
          .set(values)
          .where(
            and(
              eq(piStableContextHeads.id, head.id),
              eq(piStableContextHeads.generation, head.generation),
            ),
          );
      }
      const [completed] = parseRawRows(
        publicationCompletionSchema,
        await tx.execute(completeVolumePublicationSql(fence)),
      );
      if (!completed) {
        throw new Error(
          "Stable-context publication fence changed while locked",
        );
      }
      signal.throwIfAborted();
    });
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
      { volume, stableContextPublication: args.stableContextPublication },
      signal,
    );
    signal.throwIfAborted();
    return {
      storageName: volume.storageName,
      versionId: volume.version.versionId,
    };
  },
);
