import { piResourceSnapshots } from "@okouai/db/schema/pi-resource-snapshot";
import {
  piStableContextArtifacts,
  piStableContextHeads,
} from "@okouai/db/schema/pi-stable-context";
import { command } from "ccstate";
import { and, asc, eq, inArray, lt, notExists } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  deleteS3Objects,
  listS3ObjectsUnderPrefix,
  type S3Object,
} from "../external/s3";
import { PI_API_FIRST_TURN_URL_TTL_SECONDS } from "./pi-api-first-turn-config";

const PI_API_FIRST_TURN_PREFIX = "pi-api-first-turn";
const PI_API_FIRST_TURN_STAGING_RETENTION_MS =
  PI_API_FIRST_TURN_URL_TTL_SECONDS * 1000;
const PI_RESOURCE_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PI_STABLE_CONTEXT_ARTIFACT_GC_BATCH_SIZE = 256;

interface PiApiFirstTurnCleanupResult {
  readonly stagingObjectsDeleted: number;
  readonly resourceSnapshotsDeleted: number;
  readonly stableContextArtifactsDeleted: number;
}

function expiredPiApiFirstTurnObjectKeys(
  objects: readonly S3Object[],
  at: number,
): readonly string[] {
  const cutoff = at - PI_API_FIRST_TURN_STAGING_RETENTION_MS;
  return objects.flatMap((object) => {
    return object.lastModified.getTime() < cutoff ? [object.key] : [];
  });
}

function piResourceSnapshotExpirationCutoff(at: number): Date {
  return new Date(at - PI_RESOURCE_SNAPSHOT_RETENTION_MS);
}

export async function deleteExpiredPiStableContextArtifacts(
  db: Db,
  cutoff: Date,
  hooks?: { readonly afterCandidatesLocked?: (tx: Tx) => Promise<void> },
): Promise<readonly { readonly digest: string }[]> {
  return await db.transaction(async (tx) => {
    // Coordinate with exact-digest re-publication. Publisher conflict updates
    // retain a row lock through head attachment; SKIP LOCKED leaves those live
    // artifacts for a later sweep. If GC owns the row first, the publisher
    // waits, observes the committed deletion, and inserts the artifact anew.
    const candidates = await tx
      .select({ digest: piStableContextArtifacts.digest })
      .from(piStableContextArtifacts)
      .where(
        and(
          lt(piStableContextArtifacts.createdAt, cutoff),
          notExists(
            tx
              .select({ id: piStableContextHeads.id })
              .from(piStableContextHeads)
              .where(
                eq(
                  piStableContextHeads.artifactDigest,
                  piStableContextArtifacts.digest,
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(piStableContextArtifacts.digest))
      .limit(PI_STABLE_CONTEXT_ARTIFACT_GC_BATCH_SIZE)
      .for("update", { skipLocked: true });
    if (candidates.length === 0) {
      return [];
    }
    await hooks?.afterCandidatesLocked?.(tx);
    return await tx
      .delete(piStableContextArtifacts)
      .where(
        inArray(
          piStableContextArtifacts.digest,
          candidates.map((candidate) => {
            return candidate.digest;
          }),
        ),
      )
      .returning({ digest: piStableContextArtifacts.digest });
  });
}

/**
 * The sandbox cleanup cron owns orphaned first-turn staging data. Normal run
 * completion releases its two objects immediately; this sweep covers partial
 * writes and processes that terminate before a completion side effect runs.
 * Resource snapshots are rebuildable preheat cache entries and expire weekly.
 */
export const cleanupExpiredPiApiFirstTurnData$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<PiApiFirstTurnCleanupResult> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const currentTime = now();
    const stagingObjects = await get(
      listS3ObjectsUnderPrefix(bucket, PI_API_FIRST_TURN_PREFIX),
    );
    signal.throwIfAborted();
    const expiredKeys = expiredPiApiFirstTurnObjectKeys(
      stagingObjects,
      currentTime,
    );
    await get(deleteS3Objects(bucket, expiredKeys));
    signal.throwIfAborted();

    const deletedSnapshots = await set(writeDb$)
      .delete(piResourceSnapshots)
      .where(
        lt(
          piResourceSnapshots.createdAt,
          piResourceSnapshotExpirationCutoff(currentTime),
        ),
      )
      .returning({ digest: piResourceSnapshots.digest });
    signal.throwIfAborted();
    const deletedStableArtifacts = await deleteExpiredPiStableContextArtifacts(
      set(writeDb$),
      piResourceSnapshotExpirationCutoff(currentTime),
    );
    signal.throwIfAborted();
    return {
      stagingObjectsDeleted: expiredKeys.length,
      resourceSnapshotsDeleted: deletedSnapshots.length,
      stableContextArtifactsDeleted: deletedStableArtifacts.length,
    };
  },
);
