import { piResourceSnapshots } from "@okouai/db/schema/pi-resource-snapshot";
import {
  piStableContextArtifacts,
  piStableContextHeads,
} from "@okouai/db/schema/pi-stable-context";
import { command } from "ccstate";
import { and, eq, lt, notExists } from "drizzle-orm";

import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { writeDb$ } from "../external/db";
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
    const writeDb = set(writeDb$);
    const deletedStableArtifacts = await writeDb
      .delete(piStableContextArtifacts)
      .where(
        and(
          lt(
            piStableContextArtifacts.createdAt,
            piResourceSnapshotExpirationCutoff(currentTime),
          ),
          notExists(
            writeDb
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
      .returning({ digest: piStableContextArtifacts.digest });
    signal.throwIfAborted();
    return {
      stagingObjectsDeleted: expiredKeys.length,
      resourceSnapshotsDeleted: deletedSnapshots.length,
      stableContextArtifactsDeleted: deletedStableArtifacts.length,
    };
  },
);
