import { command } from "ccstate";

import { writeDb$ } from "../external/db";
import {
  commitPreparedVolumeServerSide,
  prepareVolumeServerSide$,
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

export const uploadVolumeServerSide$ = command(
  async (
    { set },
    args: UploadVolumeServerSideInput,
    signal: AbortSignal,
  ): Promise<UploadedVolume> => {
    const volume = await set(prepareVolumeServerSide$, args, signal);
    const writeDb = set(writeDb$);
    await writeDb.transaction(async (tx) => {
      if (
        args.stableContextPublication &&
        !(await lockPiStableContextPublication(
          tx,
          args.stableContextPublication,
        ))
      ) {
        throw new StalePiStableContextPublicationError(
          "Stable-context publication was superseded before Storage HEAD commit",
        );
      }
      await commitPreparedVolumeServerSide({ db: tx, volume }, signal);
      if (args.stableContextPublication) {
        await refreshPiStableContextStorageDemands(
          tx,
          args.stableContextPublication,
          {
            storageId: volume.version.storageId,
            versionId: volume.version.versionId,
            archiveSize: volume.version.archiveSize,
            fileCount: volume.version.fileCount,
          },
        );
      }
      if (
        args.stableContextPublication &&
        !(await completePiStableContextPublication(
          tx,
          args.stableContextPublication,
        ))
      ) {
        throw new Error(
          "Stable-context publication fence changed while locked",
        );
      }
    });
    signal.throwIfAborted();
    return {
      storageName: volume.storageName,
      versionId: volume.version.versionId,
    };
  },
);
