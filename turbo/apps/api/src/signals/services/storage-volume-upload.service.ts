import { command } from "ccstate";

import { testOverride } from "../../lib/singleton";
import { writeDb$, type Db } from "../external/db";
import {
  commitPreparedVolumeServerSide,
  prepareVolumeServerSide$,
  type PreparedServerSideVolume,
  type PrepareVolumeServerSideInput,
} from "./storage-volume-publication.service";
import {
  completePiStableContextPublication,
  lockPiStableContextPublication,
  refreshPiStableContextStorageDemands,
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

interface StorageVolumeUploadHooks {
  readonly afterStorageCommit?: (db: Db) => Promise<void>;
}

const storageVolumeUploadHooks = testOverride<StorageVolumeUploadHooks>(() => {
  return {};
});

export function setStorageVolumeUploadHooksForTest(
  hooks: StorageVolumeUploadHooks,
): void {
  storageVolumeUploadHooks.set(hooks);
}

export function clearStorageVolumeUploadHooksForTest(): void {
  storageVolumeUploadHooks.clear();
}

export async function commitPreparedVolumeUpload(
  args: {
    readonly db: Db;
    readonly volume: PreparedServerSideVolume;
    readonly stableContextPublication?: PiStableContextPublicationFence;
  },
  signal: AbortSignal,
): Promise<void> {
  // Every source publisher and aggregate publisher takes immutable Storage
  // parents before generation/head locks. A stale fence rolls this Storage
  // commit back with the transaction instead of introducing the reverse
  // generation → Storage order used by Workflow deletion.
  await commitPreparedVolumeServerSide(
    { db: args.db, volume: args.volume },
    signal,
  );
  await storageVolumeUploadHooks.get().afterStorageCommit?.(args.db);
  if (
    args.stableContextPublication &&
    !(await lockPiStableContextPublication(
      args.db,
      args.stableContextPublication,
    ))
  ) {
    throw new StalePiStableContextPublicationError(
      "Stable-context publication was superseded before Storage HEAD commit",
    );
  }
  if (args.stableContextPublication) {
    await refreshPiStableContextStorageDemands(
      args.db,
      args.stableContextPublication,
      {
        storageId: args.volume.version.storageId,
        versionId: args.volume.version.versionId,
        archiveSize: args.volume.version.archiveSize,
        fileCount: args.volume.version.fileCount,
      },
    );
  }
  if (
    args.stableContextPublication &&
    !(await completePiStableContextPublication(
      args.db,
      args.stableContextPublication,
    ))
  ) {
    throw new Error("Stable-context publication fence changed while locked");
  }
}

export const uploadVolumeServerSide$ = command(
  async (
    { set },
    args: UploadVolumeServerSideInput,
    signal: AbortSignal,
  ): Promise<UploadedVolume> => {
    const volume = await set(prepareVolumeServerSide$, args, signal);
    const writeDb = set(writeDb$);
    await writeDb.transaction(async (tx) => {
      await commitPreparedVolumeUpload(
        {
          db: tx,
          volume,
          ...(args.stableContextPublication
            ? { stableContextPublication: args.stableContextPublication }
            : {}),
        },
        signal,
      );
    });
    signal.throwIfAborted();
    return {
      storageName: volume.storageName,
      versionId: volume.version.versionId,
    };
  },
);
