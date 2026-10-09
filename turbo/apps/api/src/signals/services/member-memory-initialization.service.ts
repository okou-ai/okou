import { computeContentHashFromHashes } from "@okouai/api-contracts/contracts/storage-content-hash";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { memorySummaryProjectionValues } from "./memory-summary-projection.service";
import { piResourceProjectionValues } from "./pi-resource-version-index.service";
import { memorySummaryProjections } from "@okouai/db/schema/memory-summary-projection";
import { piResourceVersionIndexes } from "@okouai/db/schema/pi-resource-version-index";
import { PI_RESOURCE_EXTRACTOR_VERSION } from "../../lib/pi-resource-index";
import { newStorageS3Location } from "./storage-s3-prefix.utils";

/** Establish the member's memory before any run can require its mount. */
export const initializeMemberMemory$ = command(
  async (
    { set },
    identity: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      const location = newStorageS3Location(identity.orgId);
      await tx
        .insert(storages)
        .values({
          id: location.storageId,
          orgId: identity.orgId,
          userId: identity.userId,
          name: MEMORY_ARTIFACT_NAME,
          s3Prefix: location.s3Prefix,
        })
        .onConflictDoNothing({
          target: [storages.orgId, storages.userId, storages.name],
        });
      signal.throwIfAborted();
      // Serialize duplicate onboarding/webhook deliveries and preserve a HEAD
      // already published by a storage writer while this transaction waited.
      const [storage] = await tx
        .select({
          id: storages.id,
          s3Prefix: storages.s3Prefix,
          headVersionId: storages.headVersionId,
        })
        .from(storages)
        .where(
          and(
            eq(storages.orgId, identity.orgId),
            eq(storages.userId, identity.userId),
            eq(storages.name, MEMORY_ARTIFACT_NAME),
          ),
        )
        .limit(1)
        .for("update");
      signal.throwIfAborted();
      if (!storage) {
        throw new Error(
          "Member memory storage disappeared during initialization",
        );
      }
      if (storage.headVersionId !== null) {
        return;
      }
      const versionId = computeContentHashFromHashes(storage.id, []);
      await tx
        .insert(storageVersions)
        .values({
          id: versionId,
          storageId: storage.id,
          s3Key: `${storage.s3Prefix}/${versionId}`,
          size: 0,
          archiveSize: 0,
          fileCount: 0,
          message: "Initial empty artifact",
          createdBy: identity.userId,
        })
        .onConflictDoNothing();
      signal.throwIfAborted();
      const projection = piResourceProjectionValues(
        { schemaVersion: 1, files: [] },
        0,
        nowDate(),
      );
      await tx
        .insert(piResourceVersionIndexes)
        .values({
          storageVersionId: versionId,
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
      signal.throwIfAborted();
      const summary = memorySummaryProjectionValues({
        storage: { id: storage.id, ...identity, name: MEMORY_ARTIFACT_NAME },
        storageVersionId: versionId,
      });
      if (!summary) {
        throw new Error("Member memory has no summary projection identity");
      }
      await tx
        .insert(memorySummaryProjections)
        .values(summary)
        .onConflictDoNothing();
      signal.throwIfAborted();
      await tx
        .update(storages)
        .set({
          headVersionId: versionId,
          size: 0,
          fileCount: 0,
          updatedAt: nowDate(),
        })
        .where(
          and(eq(storages.id, storage.id), isNull(storages.headVersionId)),
        );
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);
