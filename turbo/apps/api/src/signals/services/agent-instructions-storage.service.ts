import { command } from "ccstate";
import {
  getInstructionsFilename,
  SUPPORTED_FRAMEWORKS,
} from "@okouai/core/frameworks";
import {
  getInstructionsStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { agents } from "@okouai/db/schema/agent";
import { storages } from "@okouai/db/schema/storage";
import { and, eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { enqueueStorageObjectCleanup } from "./storage-object-cleanup.service";
import { purgeDeletedStoragePrefix$ } from "./storage-prefix-purge.service";
import {
  commitPreparedVolumeServerSide,
  prepareVolumeServerSide$,
  type PreparedServerSideVolume,
  type ServerSideVolumeStorage,
} from "./storage-volume-publication.service";
import { uploadVolumeServerSide$ } from "./storage-volume-upload.service";
import {
  completePiStableContextPublication,
  lockPiStableContextPublication,
  refreshPiStableContextStorageDemands,
  type PiStableContextPublicationFence,
} from "./pi-stable-context-generation.service";

interface WriteAgentInstructionsStorageArgs {
  readonly orgId: string;
  readonly agentName: string;
  readonly storageId?: string;
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
    ...(args.storageId === undefined ? {} : { storageId: args.storageId }),
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
export async function commitPreparedAgentInstructionsStorageInTransaction(
  args: {
    readonly tx: Tx;
    readonly volume: PreparedServerSideVolume;
    readonly stableContextPublication?: PiStableContextPublicationFence;
  },
  signal: AbortSignal,
): Promise<void> {
  // Own the immutable Storage parent before generation/index lifecycle locks.
  await commitPreparedVolumeServerSide(
    { db: args.tx, volume: args.volume },
    signal,
  );
  if (args.stableContextPublication) {
    if (
      !(await lockPiStableContextPublication(
        args.tx,
        args.stableContextPublication,
      ))
    ) {
      throw new Error(
        "Stable-context publication was superseded before Storage HEAD commit",
      );
    }
    await refreshPiStableContextStorageDemands(
      args.tx,
      args.stableContextPublication,
      args.volume.version,
    );
    signal.throwIfAborted();
    if (
      !(await completePiStableContextPublication(
        args.tx,
        args.stableContextPublication,
      ))
    ) {
      throw new Error("Stable-context publication fence changed while locked");
    }
  }
  signal.throwIfAborted();
}

export const deleteAgentInstructionsStorage$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly agentName: string;
      readonly storageId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const cleanupJobId = await writeDb.transaction(async (tx) => {
      const [storage] = await tx
        .select({ id: storages.id, s3Prefix: storages.s3Prefix })
        .from(storages)
        .where(
          and(
            eq(storages.id, args.storageId),
            eq(storages.orgId, args.orgId),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            eq(storages.name, getInstructionsStorageName(args.agentName)),
          ),
        )
        .for("update")
        .limit(1);
      signal.throwIfAborted();
      if (!storage) {
        return null;
      }
      // Creation can have committed even if its caller lost the receipt. Never
      // remove instructions belonging to an already published Agent.
      const [agent] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(eq(agents.orgId, args.orgId), eq(agents.name, args.agentName)),
        )
        .limit(1);
      signal.throwIfAborted();
      if (agent) {
        return null;
      }
      await tx.delete(storages).where(eq(storages.id, storage.id));
      return await enqueueStorageObjectCleanup(
        tx,
        {
          bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
          target: { kind: "prefix", value: storage.s3Prefix },
          userId: args.userId,
          orgId: args.orgId,
        },
        signal,
      );
    });
    signal.throwIfAborted();

    if (cleanupJobId) {
      await set(purgeDeletedStoragePrefix$, { jobIds: [cleanupJobId] }, signal);
    }
  },
);
