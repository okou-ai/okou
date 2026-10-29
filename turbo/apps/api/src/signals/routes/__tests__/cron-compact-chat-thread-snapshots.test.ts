import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { chatThreadSnapshotArchiveSchema } from "@okouai/api-contracts/contracts/chat-threads";
import { cronCompactChatThreadSnapshotsContract } from "@okouai/api-contracts/contracts/cron";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { cronCompactChatThreadSnapshotsRoutes } from "../cron-compact-chat-thread-snapshots";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();

test("publishes scoped sidebars with pinned and archived threads", async () => {
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
  if (!actor.orgId) {
    throw new Error("Expected the sidebar actor to belong to an organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId, orgRole: actor.orgRole },
    { [FeatureSwitchKey.ChatThreadArchiving]: true },
  );
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
              LastModified: nowDate(),
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

  await chat.renameThread(actor, ordinary.id, "Renamed sidebar thread");
  await accept(
    app(cronCompactChatThreadSnapshotsContract).compact({
      headers: { authorization: "Bearer test-cron-secret" },
    }),
    [200],
  );
  const updated = await chat.getThreadSnapshot(actor);
  expect(updated.chatThreads).toHaveLength(3);
  expect(updated.chatThreads[0]).toMatchObject({ id: pinned.id });
  expect(updated.chatThreads).toContainEqual(
    expect.objectContaining({
      id: ordinary.id,
      title: "Renamed sidebar thread",
    }),
  );
  expect(updated.chatThreads).toContainEqual(
    expect.objectContaining({ id: archived.id, archived: true }),
  );
  if (snapshot.latestSeqId === null || updated.latestSeqId === null) {
    throw new Error(
      "Expected a published sidebar sequence before and after rename",
    );
  }
  expect(updated.latestSeqId).toBeGreaterThan(snapshot.latestSeqId);
  await expect(chat.getThreadSnapshot(otherOrg)).resolves.toStrictEqual(
    otherSnapshot,
  );

  await accept(
    app(cronCompactChatThreadSnapshotsContract).compact({
      headers: { authorization: "Bearer test-cron-secret" },
    }),
    [200],
  );
  await expect(chat.getThreadSnapshot(actor)).resolves.toStrictEqual(updated);
  await expect(chat.getThreadSnapshot(otherOrg)).resolves.toStrictEqual(
    otherSnapshot,
  );
});
