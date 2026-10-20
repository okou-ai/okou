import { randomUUID } from "node:crypto";
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { cronCompactChatThreadSnapshotsContract } from "@okouai/api-contracts/contracts/cron";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { cronCompactChatThreadSnapshotsRoutes } from "../cron-compact-chat-thread-snapshots";

const context = testContext();
const initialTime = "2026-10-10T00:00:00.000Z";
const oldTime = "2026-09-30T00:00:00.000Z";

function objectKey(version: number): string {
  return `chat-thread-snapshots/v1/${"0".repeat(64)}/${version.toString().padStart(8, "0")}-snapshot.json.gz`;
}

async function initialize() {
  mockNow(new Date(initialTime));
  mockEnv("CRON_SECRET", "test-cron-secret");
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", `snapshot-gc-${randomUUID()}`);
  const objects = new Map<string, Date>();
  function send(request: unknown): Promise<unknown> {
    if (request instanceof ListObjectsV2Command) {
      const { Prefix, StartAfter, MaxKeys } = request.input;
      const keys = [...objects.keys()]
        .filter((key) => {
          return (
            key.startsWith(Prefix ?? "") &&
            (StartAfter === undefined || key > StartAfter)
          );
        })
        .sort();
      const page = keys.slice(0, MaxKeys ?? 1000);
      return Promise.resolve({
        Contents: page.map((Key) => {
          return { Key, LastModified: objects.get(Key), Size: 1 };
        }),
        IsTruncated: keys.length > page.length,
      });
    }
    if (request instanceof DeleteObjectsCommand) {
      for (const { Key } of request.input.Delete?.Objects ?? []) {
        if (Key === undefined) {
          throw new Error("Expected an S3 deletion key");
        }
        objects.delete(Key);
      }
      return Promise.resolve({});
    }
    throw new Error("Unexpected snapshot storage request");
  }
  context.mocks.s3.send.mockImplementation(send);
  const app = await setupApp({
    context,
    routes: cronCompactChatThreadSnapshotsRoutes,
    isolatePg: true,
  });
  async function compact() {
    return await accept(
      app(cronCompactChatThreadSnapshotsContract).compact({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [200],
    );
  }
  return { objects, send, compact };
}

describe("chat thread snapshot garbage collection", () => {
  it("continues a dense prefix past retained objects across cron invocations", async () => {
    const { objects, compact } = await initialize();
    const keys = Array.from({ length: 1101 }, (_, index) => {
      return objectKey(index);
    });
    for (const [index, key] of keys.entries()) {
      objects.set(key, new Date(index < 100 ? initialTime : oldTime));
    }

    // Retained objects at the front prevent a scan from progressing merely by
    // deleting the first page repeatedly.
    for (let page = 0; page < 12; page += 1) {
      const response = await compact();
      expect(response.body.gc.failed).toBeFalsy();
      expect(response.body.gc.deleteAttempts).toBeLessThanOrEqual(100);
    }

    expect([...objects.keys()]).toStrictEqual(keys.slice(0, 100));
  });

  it("reports a failed deletion and processes that page on the next invocation", async () => {
    const { objects, send, compact } = await initialize();
    const keys = Array.from({ length: 101 }, (_, index) => {
      return objectKey(index);
    });
    for (const key of keys) {
      objects.set(key, new Date(oldTime));
    }
    let failDelete = true;
    context.mocks.s3.send.mockImplementation((request: unknown) => {
      if (request instanceof DeleteObjectsCommand && failDelete) {
        failDelete = false;
        return Promise.reject(new Error("Storage temporarily unavailable"));
      }
      return send(request);
    });

    const failed = await compact();
    expect(failed.body.gc).toMatchObject({
      failed: true,
      deleteAttempts: 100,
      objectsDeleted: 0,
    });
    expect([...objects.keys()]).toStrictEqual(keys);

    const recovered = await compact();
    expect(recovered.body.gc).toMatchObject({
      failed: false,
      objectsDeleted: 100,
    });
    expect([...objects.keys()]).toStrictEqual(keys.slice(100));
    await compact();
    expect(objects.size).toBe(0);
  });
});
