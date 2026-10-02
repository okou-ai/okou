import type { PiStableContextPublicationFence } from "./pi-stable-context-generation.service";
import { command } from "ccstate";
import {
  getInstructionsFilename,
  SUPPORTED_FRAMEWORKS,
} from "@okouai/core/frameworks";
import { getInstructionsStorageName } from "@okouai/core/storage-names";

import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { deleteS3Objects, listS3ObjectsUnderPrefix } from "../external/s3";
import {
  prepareVolumeServerSide$,
  type PreparedServerSideVolume,
  type ServerSideVolumeStorage,
} from "./storage-volume-publication.service";
import { uploadVolumeServerSide$ } from "./storage-volume-upload.service";
import { removeAgentInstructionsStorageInTransaction } from "./agent-instructions-storage-transaction.service";

interface WriteAgentInstructionsStorageArgs {
  readonly orgId: string;
  readonly agentName: string;
  readonly instructions: string;
  readonly framework?: string;
  readonly stableContextPublication?: PiStableContextPublicationFence;
}

function instructionFilesForFramework(args: {
  readonly content: string;
  readonly framework?: string;
}): readonly { readonly path: string; readonly content: string }[] {
  const filenames = [
    getInstructionsFilename(args.framework),
    ...SUPPORTED_FRAMEWORKS.map((framework) => {
      return getInstructionsFilename(framework);
    }),
  ].filter((entry, index, all) => {
    return all.indexOf(entry) === index;
  });

  return filenames.map((path) => {
    return { path, content: args.content };
  });
}

function instructionVolumeInput(args: WriteAgentInstructionsStorageArgs) {
  return {
    orgId: args.orgId,
    storageName: getInstructionsStorageName(args.agentName.toLowerCase()),
    piResourceIndex: true as const,
    ...(args.stableContextPublication
      ? { stableContextPublication: args.stableContextPublication }
      : {}),
    files: instructionFilesForFramework({
      content: args.instructions,
      framework: args.framework,
    }),
  };
}

/** Persist application-owned Agent instructions without composing a version. */
export const writeAgentInstructionsStorage$ = command(
  async (
    { set },
    args: WriteAgentInstructionsStorageArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(uploadVolumeServerSide$, instructionVolumeInput(args), signal);
    signal.throwIfAborted();
  },
);

/** Prepare and upload without borrowing a caller's transaction. */
export const prepareAgentInstructionsStorage$ = command(
  async (
    { set },
    args: Omit<
      WriteAgentInstructionsStorageArgs,
      "stableContextPublication"
    > & {
      readonly storage?: ServerSideVolumeStorage;
    },
    signal: AbortSignal,
  ): Promise<PreparedServerSideVolume> => {
    return await set(
      prepareVolumeServerSide$,
      {
        ...instructionVolumeInput(args),
        ...(args.storage ? { storage: args.storage } : {}),
      },
      signal,
    );
  },
);

/** DB-only publication; the caller revalidates source authority and Storage. */

export const deleteAgentInstructionsStorage$ = command(
  async (
    { get, set },
    args: { readonly orgId: string; readonly agentName: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const s3Prefix = await writeDb.transaction(async (tx) => {
      return await removeAgentInstructionsStorageInTransaction(tx, args);
    });
    signal.throwIfAborted();

    if (s3Prefix) {
      const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
      const objects = await get(listS3ObjectsUnderPrefix(bucket, s3Prefix));
      signal.throwIfAborted();
      await get(
        deleteS3Objects(
          bucket,
          objects.map((object) => {
            return object.key;
          }),
        ),
      );
      signal.throwIfAborted();
    }
  },
);
