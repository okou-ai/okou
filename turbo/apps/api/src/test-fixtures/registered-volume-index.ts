import { VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { piResourceVersionIndexes } from "@okouai/db/schema/pi-resource-version-index";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../lib/db";
import { PI_RESOURCE_EXTRACTOR_VERSION } from "../lib/pi-resource-index";

/** Public publishers cannot create missing/other-generation/corrupt ready rows
 * or inconsistent registered keys. Model only those infrastructure states on
 * the exact org/name/version created by this test; publication and assertions
 * still use the production APIs. */
export async function alterRegisteredVolumeIndexFixture(
  args: {
    readonly orgId: string;
    readonly storageName: string;
    readonly versionId: string;
    readonly state:
      | "missing"
      | "other-extractor"
      | "corrupt-hash"
      | "corrupt-shape"
      | "conflicting-key";
  },
  signal: AbortSignal,
): Promise<void> {
  await db().transaction(async (tx) => {
    const [version] = await tx
      .select({ id: storageVersions.id, s3Key: storageVersions.s3Key })
      .from(storageVersions)
      .innerJoin(storages, eq(storages.id, storageVersions.storageId))
      .where(
        and(
          eq(storages.orgId, args.orgId),
          eq(storages.userId, VOLUME_ORG_USER_ID),
          eq(storages.name, args.storageName),
          eq(storageVersions.id, args.versionId),
        ),
      );
    signal.throwIfAborted();
    if (!version) {
      throw new Error("Expected an exact test-owned registered volume");
    }
    if (args.state === "conflicting-key") {
      await tx
        .update(storageVersions)
        .set({ s3Key: `${version.s3Key}/conflicting-key` })
        .where(eq(storageVersions.id, version.id));
      signal.throwIfAborted();
      return;
    }
    const condition = and(
      eq(piResourceVersionIndexes.storageVersionId, version.id),
      eq(
        piResourceVersionIndexes.extractorVersion,
        PI_RESOURCE_EXTRACTOR_VERSION,
      ),
      eq(piResourceVersionIndexes.status, "ready"),
    );
    const changed =
      args.state === "missing"
        ? await tx.delete(piResourceVersionIndexes).where(condition).returning({
            versionId: piResourceVersionIndexes.storageVersionId,
          })
        : await tx
            .update(piResourceVersionIndexes)
            .set(
              args.state === "other-extractor"
                ? { extractorVersion: PI_RESOURCE_EXTRACTOR_VERSION + 1 }
                : args.state === "corrupt-hash"
                  ? { projectionHash: "0".repeat(64) }
                  : {
                      projection: sql`${JSON.stringify({ schemaVersion: 2, files: [] })}::jsonb`,
                    },
            )
            .where(condition)
            .returning({
              versionId: piResourceVersionIndexes.storageVersionId,
            });
    signal.throwIfAborted();
    if (changed.length !== 1) {
      throw new Error("Expected one test-owned ready resource index");
    }
  });
  signal.throwIfAborted();
}
