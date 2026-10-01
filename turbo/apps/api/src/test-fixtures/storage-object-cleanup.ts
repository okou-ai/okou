import { randomUUID } from "node:crypto";

import { exportJobs } from "@okouai/db/schema/export-job";
import { storages } from "@okouai/db/schema/storage";
import { VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { nowDate } from "../lib/time";

/** The current export endpoint cannot create a completed legacy one-call job.
 * This test-owned historical pointer exercises deletion without running an
 * unrelated full export or reaching into its tables from the route test. */
export async function seedLegacyExportCleanupReferenceFixture(
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly s3Key: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await db()
    .insert(exportJobs)
    .values({
      id: randomUUID(),
      userId: args.userId,
      orgId: args.orgId,
      status: "completed",
      s3Key: args.s3Key,
      completedAt: nowDate(),
      expiresAt: new Date(nowDate().getTime() + 24 * 60 * 60_000),
    });
  signal.throwIfAborted();
}

/** Infrastructure can replace an unpublished canonical generation, but no
 * production endpoint accepts that mutation. This fixture is restricted to
 * the exact test-owned generation observed at its external upload boundary. */
export async function replaceUnpublishedStorageGenerationFixture(
  args: { readonly orgId: string; readonly objectKey: string },
  signal: AbortSignal,
): Promise<{ readonly storageName: string; readonly s3Prefix: string }> {
  const [orgId, storageId] = args.objectKey.split("/");
  if (orgId !== args.orgId) {
    throw new Error("Replacement fixture escaped its owned organization");
  }
  const id = z.uuid().parse(storageId);
  return await db().transaction(async (tx) => {
    const [removed] = await tx
      .delete(storages)
      .where(
        and(
          eq(storages.id, id),
          eq(storages.orgId, args.orgId),
          eq(storages.userId, VOLUME_ORG_USER_ID),
          isNull(storages.headVersionId),
        ),
      )
      .returning({ name: storages.name });
    signal.throwIfAborted();
    if (!removed) {
      throw new Error("Expected this test's unpublished Storage generation");
    }
    const replacementId = randomUUID();
    const s3Prefix = `${args.orgId}/${replacementId}`;
    await tx.insert(storages).values({
      id: replacementId,
      orgId: args.orgId,
      userId: VOLUME_ORG_USER_ID,
      name: removed.name,
      s3Prefix,
      size: 0,
      fileCount: 0,
    });
    signal.throwIfAborted();
    return { storageName: removed.name, s3Prefix };
  });
}

/** Current producers cannot create legacy shared-prefix rows. Both identities
 * here must belong to this test's organization and match observed upload keys. */
export async function retainLegacySharedStoragePrefixFixture(
  args: {
    readonly orgId: string;
    readonly targetObjectKey: string;
    readonly retainedObjectKey: string;
  },
  signal: AbortSignal,
): Promise<void> {
  const [targetOrgId, targetId] = args.targetObjectKey.split("/");
  const [retainedOrgId, retainedId] = args.retainedObjectKey.split("/");
  if (targetOrgId !== args.orgId || retainedOrgId !== args.orgId) {
    throw new Error("Shared-prefix fixture escaped its owned organization");
  }
  const targetStorageId = z.uuid().parse(targetId);
  const retainedStorageId = z.uuid().parse(retainedId);
  const [target] = await db()
    .select({ s3Prefix: storages.s3Prefix })
    .from(storages)
    .where(
      and(eq(storages.id, targetStorageId), eq(storages.orgId, args.orgId)),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!target) {
    throw new Error("Expected this test's captured Storage prefix");
  }
  const [retained] = await db()
    .update(storages)
    .set({ s3Prefix: target.s3Prefix })
    .where(
      and(eq(storages.id, retainedStorageId), eq(storages.orgId, args.orgId)),
    )
    .returning({ id: storages.id });
  signal.throwIfAborted();
  if (!retained) {
    throw new Error("Expected this test's retained Storage reference");
  }
}
