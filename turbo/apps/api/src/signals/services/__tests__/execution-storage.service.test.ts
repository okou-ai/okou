import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { describe, expect, it, onTestFinished } from "vitest";
import { systemStoragePresignedUrlCache } from "@okouai/db/schema/system-storage-presigned-url-cache";
import { testContext } from "../../../__tests__/test-context";
import { db } from "../../../lib/db";
import { nowDate } from "../../../lib/time";
import {
  updateExecutionStoragePresignedUrlCache$,
  type ExecutionStorageRequest,
  type PreparedExecutionStorageMount,
  type PresignedUrlCacheWrite,
} from "../execution-storage.service";

const context = testContext();
const { console: consoleOutput } = context.mocks;

function readOnlyMount(): {
  readonly request: ExecutionStorageRequest;
  readonly identity: Omit<ExecutionStorageRequest, "mode">;
} {
  const identity = {
    orgId: randomUUID(),
    userId: randomUUID(),
    storageId: randomUUID(),
    versionId: randomUUID().replaceAll("-", ""),
    name: `cache-${randomUUID()}`,
    mountPath: "/home/user/.cache-test",
  };
  return { request: { ...identity, mode: "readonly" }, identity };
}

function cacheWrite(
  mount: ReturnType<typeof readOnlyMount>,
  cacheKey: string,
): PresignedUrlCacheWrite {
  const issuedAt = nowDate();
  return {
    cacheKey,
    scope: "readonly_storage",
    bucket: "test-bucket",
    objectKey: `${mount.identity.storageId}/archive.tar.gz`,
    storageVersionId: mount.identity.versionId,
    resolvedOrgId: mount.identity.orgId,
    publicEndpoint: true,
    ttlSeconds: 3600,
    presignedUrl: `https://storage.test/${mount.identity.storageId}`,
    expiresAt: new Date(issuedAt.getTime() + 3_600_000),
    refreshAfter: new Date(issuedAt.getTime() + 1_800_000),
    lastRequestedAt: issuedAt,
    updatedAt: issuedAt,
  };
}

function prepared(
  mount: ReturnType<typeof readOnlyMount>,
  write: PresignedUrlCacheWrite,
): PreparedExecutionStorageMount {
  return {
    ...mount.identity,
    writeback: false,
    archiveUrl: write.presignedUrl,
    archiveSize: 10,
    presignedUrlCacheWrite: write,
  };
}

async function cachedUrls(objectKey: string) {
  return await db()
    .select({ presignedUrl: systemStoragePresignedUrlCache.presignedUrl })
    .from(systemStoragePresignedUrlCache)
    .where(eq(systemStoragePresignedUrlCache.objectKey, objectKey));
}

describe("updateExecutionStoragePresignedUrlCache$", () => {
  it("stores the URLs a preparation signed fresh", async () => {
    const mount = readOnlyMount();
    const write = cacheWrite(mount, randomUUID().replaceAll("-", ""));
    onTestFinished(async () => {
      await db()
        .delete(systemStoragePresignedUrlCache)
        .where(eq(systemStoragePresignedUrlCache.cacheKey, write.cacheKey));
    });

    await expect(
      createStore().set(
        updateExecutionStoragePresignedUrlCache$,
        [mount.request],
        [prepared(mount, write)],
        context.signal,
      ),
    ).resolves.toBeUndefined();

    await expect(cachedUrls(write.objectKey)).resolves.toStrictEqual([
      { presignedUrl: write.presignedUrl },
    ]);
  });

  it("only logs a failed cache write", async () => {
    // A cache key longer than the column rejects the write in the database,
    // the one failure the post-commit owner must absorb.
    const mount = readOnlyMount();
    const write = cacheWrite(mount, "k".repeat(65));
    const restoreConsole = consoleOutput.capture();
    onTestFinished(restoreConsole);

    await expect(
      createStore().set(
        updateExecutionStoragePresignedUrlCache$,
        [mount.request],
        [prepared(mount, write)],
        context.signal,
      ),
    ).resolves.toBeUndefined();

    expect(consoleOutput.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Failed to update execution storage presigned URL cache",
      ),
      expect.objectContaining({ cacheEntryCount: 1 }),
    );
    await expect(cachedUrls(write.objectKey)).resolves.toStrictEqual([]);
  });
});
