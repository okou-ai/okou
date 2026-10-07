import { createHash, randomUUID } from "node:crypto";

import type { StoredStorageMountEntry } from "@okouai/api-contracts/contracts/runners";
import { VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { piResourceVersionIndexes } from "@okouai/db/schema/pi-resource-version-index";
import { storageVersions, storages } from "@okouai/db/schema/storage";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";
import {
  prepareVolumeServerSide$,
  type PrepareVolumeServerSideInput,
} from "../signals/services/storage-volume-publication.service";
import { preparePiResourceSnapshot } from "../signals/services/pi-resource-snapshot.service";
import { enqueuePiResourceVersionIndexes } from "../signals/services/pi-resource-version-index.service";

export async function prepareUnpublishedPiVolumeFixture(
  input: PrepareVolumeServerSideInput,
  signal: AbortSignal,
): Promise<void> {
  const store = createStore();
  await store.set(prepareVolumeServerSide$, input, signal);
}

/** No public API creates an isolated archive-less empty writeback version.
 * Seed only that immutable Storage boundary; enqueue, worker, read and snapshot
 * composition all execute their production paths. */
export async function publishEmptyPiVolumeFixture(
  args: { readonly orgId: string; readonly storageName: string },
  signal: AbortSignal,
): Promise<string> {
  const nonce = randomUUID();
  const versionId = createHash("sha256").update(nonce).digest("hex");
  await db().transaction(async (tx) => {
    const [storage] = await tx
      .insert(storages)
      .values({
        orgId: args.orgId,
        userId: VOLUME_ORG_USER_ID,
        name: args.storageName,
        s3Prefix: `test/pi-resource-index/${nonce}`,
      })
      .returning({ id: storages.id });
    if (!storage) {
      throw new Error("Failed to create the empty Storage fixture");
    }
    await tx.insert(storageVersions).values({
      id: versionId,
      storageId: storage.id,
      s3Key: `test/pi-resource-index/${nonce}/${versionId}`,
      archiveSize: 0,
      size: 0,
      fileCount: 0,
      createdBy: "pi-resource-index-test",
    });
    await tx
      .update(storages)
      .set({ headVersionId: versionId })
      .where(eq(storages.id, storage.id));
    await enqueuePiResourceVersionIndexes(tx, [versionId], signal);
    await tx
      .update(piResourceVersionIndexes)
      .set({ availableAt: new Date(0) })
      .where(eq(piResourceVersionIndexes.storageVersionId, versionId));
  });
  signal.throwIfAborted();
  return versionId;
}

/** Production has no public snapshot-preparation endpoint. This narrow fixture
 * derives the canonical empty writeback mount from a test-owned real Storage
 * version, then executes the production PostgreSQL/index-backed loader. */
export async function prepareEmptyPiWritebackSnapshotFixture(
  versionId: string,
  mountPath: string,
  signal: AbortSignal,
) {
  const [version] = await db()
    .select({
      archiveSize: storageVersions.archiveSize,
      fileCount: storageVersions.fileCount,
      storageId: storages.id,
      name: storages.name,
      orgId: storages.orgId,
      userId: storages.userId,
    })
    .from(storageVersions)
    .innerJoin(storages, eq(storages.id, storageVersions.storageId))
    .where(eq(storageVersions.id, versionId))
    .limit(1);
  signal.throwIfAborted();
  if (!version || version.archiveSize !== 0 || version.fileCount !== 0) {
    throw new Error("Expected one empty test-owned Storage version");
  }
  const mount: StoredStorageMountEntry = {
    name: version.name,
    storageId: version.storageId,
    versionId,
    mountPath,
    orgId: version.orgId,
    userId: version.userId,
    writeback: true,
    empty: true,
  };
  return await createStore().get(
    preparePiResourceSnapshot({ db: db(), mounts: [mount] }, signal),
  );
}

/** No public endpoint prepares a resource snapshot in isolation. Resolve only
 * a test-owned committed version, then exercise the production snapshot loader
 * with a captured archive length that may differ from the R2 response. */
export async function prepareRegisteredPiResourceSnapshotFixture(
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly storageName: string;
    readonly versionId: string;
    readonly mountPath: string;
    readonly archiveUrl: string;
    readonly archiveSize: number;
  },
  signal: AbortSignal,
) {
  const [version] = await db()
    .select({
      storageId: storages.id,
      name: storages.name,
      orgId: storages.orgId,
      userId: storages.userId,
    })
    .from(storageVersions)
    .innerJoin(storages, eq(storages.id, storageVersions.storageId))
    .where(
      and(
        eq(storageVersions.id, args.versionId),
        eq(storages.orgId, args.orgId),
        eq(storages.userId, args.userId),
        eq(storages.name, args.storageName),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!version) {
    throw new Error("Expected a test-owned committed Storage version");
  }
  const mount: StoredStorageMountEntry = {
    name: version.name,
    storageId: version.storageId,
    versionId: args.versionId,
    mountPath: args.mountPath,
    orgId: version.orgId,
    userId: version.userId,
    archiveUrl: args.archiveUrl,
    archiveSize: args.archiveSize,
  };
  return await createStore().get(
    preparePiResourceSnapshot({ db: db(), mounts: [mount] }, signal),
  );
}
