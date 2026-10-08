import { command } from "ccstate";
import { repairVolumeIndexSql } from "./storage-volume-publication-sql";
import { eq } from "drizzle-orm";
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
  storageVersionMatches,
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
};
class StalePublicationFenceError extends Error {}
export function isStalePublicationFenceError(error: unknown): boolean {
  return error instanceof StalePublicationFenceError;
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

function preparedProjection(volume: PreparedServerSideVolume) {
  return volume.piResourceIndex?.kind === "prepared"
    ? piResourceProjectionValues(
        volume.piResourceIndex.projection,
        volume.version.archiveSize,
      )
    : undefined;
}

interface PreparedVolumePublication {
  readonly volume: PreparedServerSideVolume;
  readonly publicationFence?: StoragePublicationFence;
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
    const fence = args.publicationFence;
    const projection = preparedProjection(args.volume);
    await db.transaction(async (tx) => {
      // The version insert's FK check keeps the Storage parent from being
      // deleted, and the HEAD UPDATE below then owns that row implicitly.
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
      const [storage] = await tx
        .update(storages)
        .set(storageHeadValues(args.volume))
        .where(eq(storages.id, version.storageId))
        .returning({ id: storages.id });
      signal.throwIfAborted();
      if (!storage) {
        throw new Error("Prepared volume Storage no longer exists");
      }
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
      } else if (!args.volume.piResourceIndex) {
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
      // Own generation before token, matching reservation and cleanup order.
      const [generation] = await tx
        .update(storagePublicationGenerations)
        .set({ updatedAt: nowDate() })
        .where(generationScopeCondition(fence.scope))
        .returning({ generation: storagePublicationGenerations.generation });
      const [publication] = generation
        ? await tx
            .delete(storagePublicationTokens)
            .where(publicationScopeCondition(fence))
            .returning({ token: storagePublicationTokens.token })
        : [];
      if (!publication) {
        throw new StalePublicationFenceError(
          "Storage publication was superseded before Storage HEAD commit",
        );
      }
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
      { volume, publicationFence: args.publicationFence },
      signal,
    );
    signal.throwIfAborted();
    return {
      storageName: volume.storageName,
      versionId: volume.version.versionId,
    };
  },
);
