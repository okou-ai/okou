import { randomUUID } from "node:crypto";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type ListObjectsV2CommandInput,
} from "@aws-sdk/client-s3";
import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { cronCompactChatThreadSnapshotsContract } from "@okouai/api-contracts/contracts/cron";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, nowDate } from "../../../lib/time";
import { createDeferredPromise } from "../../utils";
import { agentsRoutes } from "../agents";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { cronCompactChatThreadSnapshotsRoutes } from "../cron-compact-chat-thread-snapshots";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const cronHeaders = Object.freeze({
  authorization: "Bearer test-cron-secret",
});
const initialTime = "2026-10-10T00:00:00.000Z";
const oldTime = "2026-09-30T00:00:00.000Z";
const firstPrefix = "chat-thread-snapshots/v1/00";
const secondPrefix = "chat-thread-snapshots/v1/01";

function objectKey(prefix: string, version: number): string {
  return `${prefix}${"0".repeat(62)}/${version.toString().padStart(8, "0")}-snapshot.json.gz`;
}

function installStorage() {
  const objects = new Map<string, Date>();
  const lists: ListObjectsV2CommandInput[] = [];
  const deleteAttempts: string[][] = [];

  function list(input: ListObjectsV2CommandInput) {
    lists.push(input);
    const keys = [...objects.keys()]
      .filter((key) => {
        return (
          key.startsWith(input.Prefix ?? "") &&
          (input.StartAfter === undefined || key > input.StartAfter)
        );
      })
      .sort();
    const page = keys.slice(0, input.MaxKeys ?? 1000);
    return {
      Contents: page.map((Key) => {
        return { Key, LastModified: objects.get(Key), Size: 1 };
      }),
      IsTruncated: keys.length > page.length,
    };
  }

  function deleteObjects(request: DeleteObjectsCommand): string[] {
    const keys = (request.input.Delete?.Objects ?? []).map(({ Key }) => {
      if (Key === undefined) {
        throw new Error("Expected an S3 deletion key");
      }
      return Key;
    });
    deleteAttempts.push(keys);
    for (const key of keys) {
      objects.delete(key);
    }
    return keys;
  }

  function send(request: unknown): Promise<unknown> {
    if (request instanceof ListObjectsV2Command) {
      return Promise.resolve(list(request.input));
    }
    if (request instanceof DeleteObjectsCommand) {
      return Promise.resolve({
        Deleted: deleteObjects(request).map((Key) => {
          return { Key };
        }),
      });
    }
    if (request instanceof PutObjectCommand && request.input.Key) {
      objects.set(request.input.Key, nowDate());
      return Promise.resolve({});
    }
    throw new Error("Unexpected snapshot storage request");
  }

  context.mocks.s3.send.mockImplementation(send);
  return { objects, lists, deleteAttempts, list, deleteObjects, send };
}

async function initialize() {
  mockNow(new Date(initialTime));
  mockEnv("CRON_SECRET", "test-cron-secret");
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", `snapshot-gc-${randomUUID()}`);
  const storage = installStorage();
  const app = await setupApp({
    context,
    routes: [
      ...cronCompactChatThreadSnapshotsRoutes,
      ...agentsRoutes,
      ...chatThreadRoutes,
      ...chatThreadCreateRoutes,
    ],
    isolatePg: true,
  });
  async function compact() {
    return await accept(
      app(cronCompactChatThreadSnapshotsContract).compact({
        headers: cronHeaders,
      }),
      [200],
    );
  }
  return { app, storage, compact };
}

describe("chat thread snapshot garbage collection", () => {
  it("resumes a dense prefix beyond 1,000 objects after deleting its cursor key", async () => {
    const { storage, compact } = await initialize();
    const keys = Array.from({ length: 1101 }, (_, index) => {
      return objectKey(firstPrefix, index);
    });
    for (const key of keys) {
      storage.objects.set(key, new Date(oldTime));
    }

    for (let page = 0; page < 12; page += 1) {
      const listOffset = storage.lists.length;
      const response = await compact();
      const expectedDeleted = Math.min(100, keys.length - page * 100);
      expect(response.body.gc).toMatchObject({
        deleteAttempts: expectedDeleted,
        objectsDeleted: expectedDeleted,
        deferred: page < 11,
        failed: false,
      });
      const requests = storage.lists.slice(listOffset);
      expect(requests.length).toBeLessThanOrEqual(16);
      expect(requests[0]).toMatchObject({
        Prefix: firstPrefix,
        MaxKeys: 100,
      });
      expect(requests[0]?.StartAfter).toBe(
        page === 0 ? undefined : keys[page * 100 - 1],
      );
      if (page > 0) {
        expect(storage.objects.has(keys[page * 100 - 1]!)).toBeFalsy();
      }
    }

    expect(storage.objects.size).toBe(0);
    expect(storage.deleteAttempts.flat()).toStrictEqual(keys);
  });

  it("charges failed deletion attempts to the quota and replays their page", async () => {
    const { storage, compact } = await initialize();
    for (let index = 0; index < 110; index += 1) {
      storage.objects.set(
        objectKey(firstPrefix, index),
        new Date(index < 60 ? oldTime : initialTime),
      );
    }
    for (let index = 0; index < 80; index += 1) {
      storage.objects.set(objectKey(secondPrefix, index), new Date(oldTime));
    }
    let failDelete = true;
    context.mocks.s3.send.mockImplementation((request: unknown) => {
      if (request instanceof DeleteObjectsCommand && failDelete) {
        failDelete = false;
        const keys = storage.deleteObjects(request);
        const failedKey = keys.at(-1)!;
        storage.objects.set(failedKey, new Date(oldTime));
        return Promise.resolve({
          Errors: [{ Key: failedKey, Code: "InternalError" }],
        });
      }
      return storage.send(request);
    });

    const failed = await compact();
    expect(failed.body).toMatchObject({
      success: true,
      gc: {
        deleteAttempts: 100,
        objectsDeleted: 40,
        deferred: true,
        failed: true,
      },
    });
    expect(
      storage.deleteAttempts.map((keys) => {
        return keys.length;
      }),
    ).toStrictEqual([60, 40]);
    expect(storage.lists[1]).toMatchObject({
      Prefix: secondPrefix,
      MaxKeys: 40,
    });

    const listOffset = storage.lists.length;
    const recovered = await compact();
    expect(recovered.body.gc).toMatchObject({
      deleteAttempts: 41,
      objectsDeleted: 41,
      failed: false,
    });
    expect(storage.lists[listOffset]?.StartAfter).toBeUndefined();
    expect(
      storage.lists.slice(listOffset).find(({ Prefix }) => {
        return Prefix === secondPrefix;
      })?.StartAfter,
    ).toBe(objectKey(secondPrefix, 39));
    expect([...storage.objects.keys()]).toStrictEqual(
      Array.from({ length: 50 }, (_, index) => {
        return objectKey(firstPrefix, index + 60);
      }),
    );
  });

  it("continues other prefixes after a listing failure and retries the failed prefix", async () => {
    const { storage, compact } = await initialize();
    const failedKey = objectKey(firstPrefix, 1);
    const otherKey = objectKey(secondPrefix, 1);
    storage.objects.set(failedKey, new Date(oldTime));
    storage.objects.set(otherKey, new Date(oldTime));
    context.mocks.s3.send.mockImplementationOnce((request: unknown) => {
      if (!(request instanceof ListObjectsV2Command)) {
        throw new Error("Expected a snapshot listing");
      }
      storage.lists.push(request.input);
      return Promise.reject(new Error("Storage temporarily unavailable"));
    });

    const failed = await compact();
    expect(failed.body.gc).toMatchObject({
      objectsDeleted: 1,
      failed: true,
    });
    expect(storage.lists.length).toBeLessThanOrEqual(16);
    expect(storage.objects.has(failedKey)).toBeTruthy();
    expect(storage.objects.has(otherKey)).toBeFalsy();

    const recovered = await compact();
    expect(recovered.body.gc).toMatchObject({
      objectsDeleted: 1,
      failed: false,
    });
    expect(storage.objects.size).toBe(0);
  });

  it("gives another prefix the deletion quota when the hourly shard group returns", async () => {
    const { storage, compact } = await initialize();
    for (let index = 0; index < 200; index += 1) {
      storage.objects.set(objectKey(firstPrefix, index), new Date(oldTime));
    }
    const siblingKey = objectKey(secondPrefix, 1);
    storage.objects.set(siblingKey, new Date(oldTime));
    const first = await compact();
    expect(first.body.gc.objectsDeleted).toBe(100);
    expect(storage.objects.has(siblingKey)).toBeTruthy();

    mockNow(new Date(initialTime).getTime() + 16 * 60 * 60 * 1000);
    const listOffset = storage.lists.length;
    const next = await compact();
    expect(storage.lists[listOffset]?.Prefix).toBe(secondPrefix);
    expect(next.body.gc.objectsDeleted).toBe(100);
    expect(storage.objects.has(siblingKey)).toBeFalsy();
    expect(storage.objects.size).toBe(1);
  });

  it("does not let a late page overwrite a completed scan cycle", async () => {
    const { storage, compact } = await initialize();
    for (let index = 0; index < 101; index += 1) {
      storage.objects.set(objectKey(firstPrefix, index), new Date(initialTime));
    }
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    context.mocks.s3.send.mockImplementationOnce(async (request: unknown) => {
      if (!(request instanceof ListObjectsV2Command)) {
        throw new Error("Expected a snapshot listing");
      }
      const page = storage.list(request.input);
      entered.resolve();
      await release.promise;
      return page;
    });
    const slow = compact();
    onTestFinished(async () => {
      if (!release.settled()) {
        release.resolve();
      }
      await Promise.allSettled([slow]);
    });
    await entered.promise;

    await compact();
    const completed = await compact();
    expect(completed.body.gc).toMatchObject({
      objectsScanned: 1,
      deferred: false,
      failed: false,
    });
    release.resolve();
    await slow;

    // A newly retained object before the previous cursor belongs to the next
    // cycle. A stale null-cursor writer must not skip it after the wrap.
    const earlierKey = objectKey(firstPrefix, -1);
    storage.objects.set(earlierKey, new Date(oldTime));
    const listOffset = storage.lists.length;
    const next = await compact();
    expect(storage.lists[listOffset]?.StartAfter).toBeUndefined();
    expect(next.body.gc.objectsDeleted).toBe(1);
    expect(storage.objects.has(earlierKey)).toBeFalsy();
  });

  it("propagates application cancellation without committing scan progress", async () => {
    const { storage, compact } = await initialize();
    const key = objectKey(firstPrefix, 1);
    storage.objects.set(key, new Date(oldTime));
    const controller = new AbortController();
    const cancelled = setupApp({
      context,
      routes: cronCompactChatThreadSnapshotsRoutes,
      signal: AbortSignal.any([context.signal, controller.signal]),
      rethrowErrors: true,
    })(cronCompactChatThreadSnapshotsContract);
    context.mocks.s3.send.mockImplementationOnce((request: unknown) => {
      if (!(request instanceof ListObjectsV2Command)) {
        throw new Error("Expected a snapshot listing");
      }
      const page = storage.list(request.input);
      controller.abort(new DOMException("Cron owner cancelled", "AbortError"));
      return Promise.resolve(page);
    });

    await expect(
      cancelled.compact({ headers: cronHeaders }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(storage.deleteAttempts).toStrictEqual([]);
    expect(storage.objects.has(key)).toBeTruthy();

    const recovered = await compact();
    expect(storage.lists[1]?.StartAfter).toBeUndefined();
    expect(recovered.body.gc).toMatchObject({
      objectsDeleted: 1,
      failed: false,
    });
  });

  it("retains the published snapshot and objects inside the seven-day grace period", async () => {
    const { app, storage, compact } = await initialize();
    createRouteMocks(context).clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
    );
    const headers = { authorization: "Bearer clerk-session" };
    const agent = await accept(
      app(agentsMainContract).create({
        headers,
        body: { displayName: "Snapshot retention" },
      }),
      [201],
    );
    await accept(
      app(chatThreadsContract).create({
        headers,
        body: { agentId: agent.body.agentId, title: "Retained", model: null },
      }),
      [201],
    );
    await compact();
    const published = await accept(
      app(chatThreadsContract).snapshot({ headers }),
      [200],
    );
    expect(published.body).toHaveProperty("url");
    const headKey = [...storage.objects.keys()].find((key) => {
      return key.startsWith("chat-thread-snapshots/v1/");
    });
    if (!headKey) {
      throw new Error("Expected a published snapshot upload");
    }
    const prefix = headKey.slice(0, "chat-thread-snapshots/v1/".length + 2);
    const oldKey = `${headKey}-orphan`;
    const youngKey = `${headKey}-young`;
    const atBoundaryKey = `${headKey}-grace-boundary`;
    storage.objects.set(oldKey, new Date(oldTime));
    const future = new Date(initialTime).getTime() + 8 * 24 * 60 * 60 * 1000;
    storage.objects.set(youngKey, new Date(future));

    // The operator's hourly schedule visits all 256 prefixes in sixteen hours.
    // Set the exact grace boundary when the owning prefix is first requested.
    let visited = false;
    context.mocks.s3.send.mockImplementation((request: unknown) => {
      if (
        request instanceof ListObjectsV2Command &&
        request.input.Prefix === prefix
      ) {
        visited = true;
        storage.objects.set(
          atBoundaryKey,
          new Date(nowDate().getTime() - 7 * 24 * 60 * 60 * 1000),
        );
      }
      return storage.send(request);
    });
    for (let hour = 0; hour < 16 && !visited; hour += 1) {
      mockNow(future + hour * 60 * 60 * 1000);
      const response = await compact();
      expect(response.body.gc.failed).toBeFalsy();
    }

    expect(visited).toBeTruthy();
    expect(storage.objects.has(oldKey)).toBeFalsy();
    expect(storage.objects.has(headKey)).toBeTruthy();
    expect(storage.objects.has(youngKey)).toBeTruthy();
    expect(storage.objects.has(atBoundaryKey)).toBeTruthy();
    const retained = await accept(
      app(chatThreadsContract).snapshot({ headers }),
      [200],
    );
    expect(retained.body).toStrictEqual(published.body);
  });
});
