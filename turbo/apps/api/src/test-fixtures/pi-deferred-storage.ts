/** Exact readonly versions captured before capacity becomes available. */
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { onTestFinished } from "vitest";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { db } from "../lib/db";

export async function captureDeferredStorage(owner: {
  orgId: string;
  userId: string;
}) {
  const storageId = randomUUID();
  const name = `consumer-${storageId}`;
  const [version, newer] = ["captured", "newer"].map((suffix) => {
    return createHash("sha256").update(`${storageId}:${suffix}`).digest("hex");
  });
  if (!version || !newer) {
    throw new Error("Missing fixture versions");
  }
  await db()
    .insert(storages)
    .values({
      ...owner,
      id: storageId,
      name,
      s3Prefix: `${owner.orgId}/${storageId}`,
    });
  for (const id of [version, newer]) {
    await db()
      .insert(storageVersions)
      .values({
        id,
        storageId,
        s3Key: `${owner.orgId}/${storageId}/${id}`,
        size: 12,
        archiveSize: 8,
        fileCount: 1,
        createdBy: owner.userId,
      });
  }
  await db()
    .update(storages)
    .set({ headVersionId: newer })
    .where(eq(storages.id, storageId));
  onTestFinished(async () => {
    await db()
      .update(storages)
      .set({ headVersionId: null })
      .where(eq(storages.id, storageId));
    await db()
      .delete(storageVersions)
      .where(eq(storageVersions.storageId, storageId));
    await db().delete(storages).where(eq(storages.id, storageId));
  });
  return {
    orgId: owner.orgId,
    userId: owner.userId,
    storageId,
    name,
    version,
    mountPath: "/home/user/workspace/captured",
    writeback: false,
  };
}
