import { nowDate } from "../../lib/time";
import { and, eq, asc, isNotNull } from "drizzle-orm";
import {
  piStableContextHeads,
  piStableContextPublications,
  piStableContextGenerations,
} from "@okouai/db/schema/pi-stable-context";
import {
  publicationScopeCondition,
  publicationScopePendingSql,
  publicationReadinessSql,
  piStableContextDemandInputSql,
  piStableContextStorageDemandValues,
  headScopeCondition,
  completePiStableContextPublicationSql,
  type PiStableContextPublicationFence,
} from "./pi-stable-context-generation.service";
import { command } from "ccstate";
import {
  getInstructionsFilename,
  SUPPORTED_FRAMEWORKS,
} from "@okouai/core/frameworks";
import { getInstructionsStorageName } from "@okouai/core/storage-names";

import type { Tx } from "../../lib/db-types";
import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { deleteS3Objects, listS3ObjectsUnderPrefix } from "../external/s3";
import {
  commitPreparedVolumeServerSide,
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
    await args.tx.execute(
      publicationScopePendingSql(
        args.stableContextPublication.scope,
        nowDate(),
      ),
    );
    signal.throwIfAborted();
    const [piMutation0Publication] = await args.tx
      .select({ token: piStableContextPublications.token })
      .from(piStableContextPublications)
      .innerJoin(
        piStableContextGenerations,
        and(
          eq(
            piStableContextGenerations.orgId,
            piStableContextPublications.orgId,
          ),
          eq(
            piStableContextGenerations.agentId,
            piStableContextPublications.agentId,
          ),
          eq(
            piStableContextGenerations.subject,
            piStableContextPublications.subject,
          ),
        ),
      )
      .where(publicationScopeCondition(args.stableContextPublication))
      .limit(1);
    signal.throwIfAborted();
    await args.tx.execute(
      publicationReadinessSql(args.stableContextPublication.scope, nowDate()),
    );
    signal.throwIfAborted();

    if (!(piMutation0Publication !== undefined)) {
      throw new Error(
        "Stable-context publication was superseded before Storage HEAD commit",
      );
    }
    const piMutation1Resource = args.volume.version;
    const piMutation1Heads = await args.tx
      .select({
        id: piStableContextHeads.id,
        generation: piStableContextHeads.generation,
        input: piStableContextDemandInputSql().mapWith(
          piStableContextHeads.input,
        ),
      })
      .from(piStableContextHeads)
      .where(
        and(
          headScopeCondition(args.stableContextPublication.scope),
          isNotNull(piStableContextHeads.input),
          isNotNull(piStableContextHeads.inputDigest),
        ),
      )
      .orderBy(asc(piStableContextHeads.id))
      .limit(16);
    signal.throwIfAborted();
    const piMutation1At = nowDate();
    for (const head of piMutation1Heads) {
      await args.tx
        .update(piStableContextHeads)
        .set(
          piStableContextStorageDemandValues(
            head,
            piMutation1Resource,
            piMutation1At,
          ),
        )
        .where(
          and(
            eq(piStableContextHeads.id, head.id),
            eq(piStableContextHeads.generation, head.generation),
          ),
        );
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    await args.tx.execute(
      publicationScopePendingSql(
        args.stableContextPublication.scope,
        nowDate(),
      ),
    );
    signal.throwIfAborted();
    const piMutation2Completed = await args.tx.execute(
      completePiStableContextPublicationSql(args.stableContextPublication),
    );
    signal.throwIfAborted();
    await args.tx.execute(
      publicationReadinessSql(args.stableContextPublication.scope, nowDate()),
    );
    signal.throwIfAborted();

    if (!(piMutation2Completed.rowCount === 1)) {
      throw new Error("Stable-context publication fence changed while locked");
    }
  }
  signal.throwIfAborted();
}

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
