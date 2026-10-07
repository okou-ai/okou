import { piResourceSnapshots } from "@okouai/db/schema/pi-resource-snapshot";
import { command } from "ccstate";
import { lt } from "drizzle-orm";

import { now } from "../../lib/time";
import { writeDb$ } from "../external/db";
const PI_RESOURCE_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface PiLaunchArtifactsCleanupResult {
  readonly resourceSnapshotsDeleted: number;
}

function piResourceSnapshotExpirationCutoff(at: number): Date {
  return new Date(at - PI_RESOURCE_SNAPSHOT_RETENTION_MS);
}

/**
 * Resource snapshots are rebuildable preheat cache entries and expire weekly.
 * The current API no longer writes them; this drains rows written by the
 * previous API until the table is dropped.
 */
export const cleanupExpiredPiLaunchArtifacts$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<PiLaunchArtifactsCleanupResult> => {
    const currentTime = now();
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
    return { resourceSnapshotsDeleted: deletedSnapshots.length };
  },
);
