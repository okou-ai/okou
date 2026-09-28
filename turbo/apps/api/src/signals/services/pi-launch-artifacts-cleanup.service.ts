import { piResourceSnapshots } from "@okouai/db/schema/pi-resource-snapshot";
import {
  piStableContextArtifactResources,
  piStableContextArtifacts,
  piStableContextHeads,
} from "@okouai/db/schema/pi-stable-context";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { and, asc, eq, inArray, lt, notExists } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { now } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
const PI_RESOURCE_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PI_STABLE_CONTEXT_ARTIFACT_GC_BATCH_SIZE = 256;

interface PiLaunchArtifactsCleanupResult {
  readonly resourceSnapshotsDeleted: number;
  readonly stableContextArtifactsDeleted: number;
}

function piResourceSnapshotExpirationCutoff(at: number): Date {
  return new Date(at - PI_RESOURCE_SNAPSHOT_RETENTION_MS);
}

export async function deleteExpiredPiStableContextArtifacts(
  db: Db,
  cutoff: Date,
  options?: {
    readonly beforeStorageLocks?: (tx: Tx) => Promise<void>;
    readonly afterCandidatesLocked?: (tx: Tx) => Promise<void>;
    readonly artifactDigests?: readonly string[];
  },
): Promise<readonly { readonly digest: string }[]> {
  if (options?.artifactDigests?.length === 0) {
    return [];
  }
  return await db.transaction(async (tx) => {
    const eligible = and(
      lt(piStableContextArtifacts.createdAt, cutoff),
      options?.artifactDigests
        ? inArray(piStableContextArtifacts.digest, options.artifactDigests)
        : undefined,
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
    );
    const candidateRows = await tx
      .select({ digest: piStableContextArtifacts.digest })
      .from(piStableContextArtifacts)
      .where(eligible)
      .orderBy(asc(piStableContextArtifacts.digest))
      .limit(PI_STABLE_CONTEXT_ARTIFACT_GC_BATCH_SIZE);
    const candidateDigests = candidateRows.map((candidate) => {
      return candidate.digest;
    });
    if (candidateDigests.length === 0) {
      return [];
    }

    // Every publisher owns Storage/version parents before artifact and edge
    // rows. GC follows the same order so Clerk Storage deletion cannot hold a
    // retention edge while waiting on an artifact already owned by GC.
    const resources = await tx
      .select({
        storageId: piStableContextArtifactResources.storageId,
        versionId: piStableContextArtifactResources.storageVersionId,
      })
      .from(piStableContextArtifactResources)
      .where(
        inArray(
          piStableContextArtifactResources.artifactDigest,
          candidateDigests,
        ),
      );
    const storageIds = [
      ...new Set(
        resources.map((resource) => {
          return resource.storageId;
        }),
      ),
    ].sort();
    const versionIds = [
      ...new Set(
        resources.map((resource) => {
          return resource.versionId;
        }),
      ),
    ].sort();
    await options?.beforeStorageLocks?.(tx);
    if (storageIds.length > 0) {
      await tx
        .select({ id: storages.id })
        .from(storages)
        .where(inArray(storages.id, storageIds))
        .orderBy(asc(storages.id))
        .for("key share");
    }
    if (versionIds.length > 0) {
      await tx
        .select({ id: storageVersions.id })
        .from(storageVersions)
        .where(inArray(storageVersions.id, versionIds))
        .orderBy(asc(storageVersions.id))
        .for("key share");
    }

    // Coordinate with exact-digest re-publication only after parent locks.
    // SKIP LOCKED leaves publisher-owned artifacts for a later sweep. If GC
    // owns the row first, the publisher waits and reinserts after deletion.
    const candidates = await tx
      .select({ digest: piStableContextArtifacts.digest })
      .from(piStableContextArtifacts)
      .where(
        and(
          eligible,
          inArray(piStableContextArtifacts.digest, candidateDigests),
        ),
      )
      .orderBy(asc(piStableContextArtifacts.digest))
      .for("update", { skipLocked: true });
    if (candidates.length === 0) {
      return [];
    }
    await options?.afterCandidatesLocked?.(tx);
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
 * Resource snapshots are rebuildable preheat cache entries and expire weekly.
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
    const deletedStableArtifacts = await deleteExpiredPiStableContextArtifacts(
      set(writeDb$),
      piResourceSnapshotExpirationCutoff(currentTime),
    );
    signal.throwIfAborted();
    return {
      resourceSnapshotsDeleted: deletedSnapshots.length,
      stableContextArtifactsDeleted: deletedStableArtifacts.length,
    };
  },
);
