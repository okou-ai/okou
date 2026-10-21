import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { chatThreadSnapshotArchiveSchema } from "@okouai/api-contracts/contracts/chat-threads";
import { cronCompactChatThreadSnapshotsContract } from "@okouai/api-contracts/contracts/cron";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { cronCompactChatThreadSnapshotsRoutes } from "../cron-compact-chat-thread-snapshots";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";

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

it("publishes scoped sidebars with pinned and archived threads", async () => {
  mockEnv("CRON_SECRET", "test-cron-secret");
  mockEnv(
    "R2_USER_STORAGES_BUCKET_NAME",
    `snapshot-projection-${randomUUID()}`,
  );
  const app = await setupApp({
    context,
    routes: cronCompactChatThreadSnapshotsRoutes,
    isolatePg: true,
  });
  const bdd = createBddApi(context);
  const chat = createChatFilesBddApi(context);
  const runs = createRunsApi(context);
  const actor = bdd.user();
  const otherOrg = bdd.user({ userId: actor.userId });
  await runs.ensurePersonalSubscriptionModel(actor);
  await runs.ensurePersonalSubscriptionModel(otherOrg);
  const agent = await bdd.createAgent(actor, { displayName: "Sidebar Agent" });
  const otherAgent = await bdd.createAgent(otherOrg, {
    displayName: "Other organization Agent",
  });
  const pinned = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: "Pinned sidebar thread",
  });
  const archived = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: "Archived sidebar thread",
  });
  const ordinary = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: "Ordinary sidebar thread",
  });
  const foreign = await chat.createThread(otherOrg, {
    agentId: otherAgent.agentId,
    title: "Other organization thread",
  });
  await chat.pinThread(actor, pinned.id);
  await chat.requestSetThreadArchived(actor, archived.id, true, [204]);

  const objects = new Map<string, Buffer>();
  context.mocks.s3.send.mockImplementation((request: unknown) => {
    if (request instanceof PutObjectCommand) {
      const { Key, Body } = request.input;
      if (!Key || !(Body instanceof Uint8Array)) {
        throw new Error("Expected snapshot bytes and an object key");
      }
      objects.set(Key, Buffer.from(Body));
      return Promise.resolve({});
    }
    if (request instanceof ListObjectsV2Command) {
      return Promise.resolve({
        Contents: [...objects.keys()]
          .filter((key) => {
            return key.startsWith(request.input.Prefix ?? "");
          })
          .map((Key) => {
            return {
              Key,
              LastModified: new Date(),
              Size: objects.get(Key)?.length,
            };
          }),
        IsTruncated: false,
      });
    }
    throw new Error("Unexpected snapshot storage request");
  });
  context.mocks.s3.getSignedUrl.mockImplementation((_client, command) => {
    if (!(command instanceof GetObjectCommand) || !command.input.Key) {
      throw new Error("Expected a snapshot download");
    }
    return Promise.resolve(
      `https://snapshot-storage.example/${encodeURIComponent(command.input.Key)}`,
    );
  });
  server.use(
    http.get("https://snapshot-storage.example/*", ({ request }) => {
      const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
      const bytes = objects.get(key);
      if (!bytes) {
        return new HttpResponse(null, { status: 404 });
      }
      // Serve the decoded HTTP body from the gzip bytes uploaded by the API.
      return HttpResponse.json(
        chatThreadSnapshotArchiveSchema.parse(
          JSON.parse(gunzipSync(bytes).toString()),
        ),
      );
    }),
  );

  await accept(
    app(cronCompactChatThreadSnapshotsContract).compact({
      headers: { authorization: "Bearer test-cron-secret" },
    }),
    [200],
  );
  const snapshot = await chat.getThreadSnapshot(actor);
  expect(snapshot.chatThreads).toHaveLength(3);
  expect(snapshot.chatThreads[0]).toMatchObject({ id: pinned.id });
  expect(
    new Set(
      snapshot.chatThreads.map((thread) => {
        return thread.id;
      }),
    ),
  ).toStrictEqual(new Set([pinned.id, archived.id, ordinary.id]));
  expect(snapshot.chatThreads).toContainEqual(
    expect.objectContaining({ id: archived.id, archived: true }),
  );
  const otherSnapshot = await chat.getThreadSnapshot(otherOrg);
  expect(otherSnapshot.chatThreads).toMatchObject([{ id: foreign.id }]);
});

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
