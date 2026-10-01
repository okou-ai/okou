import { randomUUID } from "node:crypto";

import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { testStorageObjectCleanupContract } from "@okouai/api-contracts/contracts/test-storage-object-cleanup";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { seedLegacyExportCleanupReferenceFixture } from "../../../test-fixtures/storage-object-cleanup";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { testStorageObjectCleanupRoutes } from "../test-storage-object-cleanup";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const storages = createStoragesBddApi(context);
const webhooks = createWebhookCallbackApi(context);

function objectStore() {
  const objects = new Map<string, Buffer>();
  let failure:
    | "list"
    | "delete"
    | "partial-delete"
    | "lost-delete-receipt"
    | undefined;
  let beforeList: (() => Promise<void>) | undefined;
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      const body = command.input.Key
        ? objects.get(command.input.Key)
        : undefined;
      if (!body) {
        throw Object.assign(new Error("Missing object"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        });
      }
      return { ContentLength: body.length };
    }
    if (command instanceof ListObjectsV2Command) {
      if (beforeList) {
        await beforeList();
      }
      if (failure === "list") {
        failure = undefined;
        throw new Error("R2 listing failed");
      }
      const prefix = command.input.Prefix ?? "";
      const keys = [...objects.keys()]
        .filter((key) => {
          return key.startsWith(prefix);
        })
        .sort();
      const page = keys.slice(0, command.input.MaxKeys ?? 1000);
      return {
        Contents: page.map((key) => {
          const body = objects.get(key);
          if (!body) {
            throw new Error("Expected a listed fixture object");
          }
          return {
            Key: key,
            Size: body.length,
            LastModified: new Date(0),
          };
        }),
        IsTruncated: page.length < keys.length,
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      if (failure === "delete") {
        failure = undefined;
        throw new Error("R2 deletion failed before removing the object");
      }
      const keys =
        command.input.Delete?.Objects?.flatMap((object) => {
          return object.Key ? [object.Key] : [];
        }) ?? [];
      if (failure === "partial-delete") {
        failure = undefined;
        const [removed, remaining] = keys;
        if (removed) {
          objects.delete(removed);
        }
        return {
          Errors: [
            {
              Key: remaining,
              Code: "InternalError",
              Message: "Partial delete failed",
            },
          ],
        };
      }
      for (const key of keys) {
        objects.delete(key);
      }
      if (failure === "lost-delete-receipt") {
        failure = undefined;
        throw new Error(
          "Delete response was lost after R2 removed the objects",
        );
      }
      return {};
    }
    return {};
  });
  return {
    objects,
    failNext(
      value: "list" | "delete" | "partial-delete" | "lost-delete-receipt",
    ) {
      failure = value;
    },
    beforeListing(callback: () => Promise<void>) {
      beforeList = callback;
    },
  };
}

async function publish(actor: ApiTestUser, objects: Map<string, Buffer>) {
  const storageName = `cleanup-${randomUUID()}`;
  storages.mockStoragePresignedUrls();
  const files = [storageTextFile("content.txt", "retained storage content")];
  const prepared = await storages.prepareStorage(actor, {
    storageName,
    storageOwner: "user",
    files,
  });
  if (!prepared.uploads) {
    throw new Error("Expected a new Storage upload");
  }
  const archiveKey = prepared.uploads.archive.key;
  const manifestKey = prepared.uploads.manifest.key;
  objects.set(archiveKey, Buffer.from("synthetic archive bytes"));
  objects.set(manifestKey, Buffer.from(JSON.stringify({ files })));
  await storages.commitStorage(actor, {
    storageName,
    storageOwner: "user",
    versionId: prepared.versionId,
    files,
  });
  return {
    storageName,
    archiveKey,
    manifestKey,
    prefix: archiveKey.slice(
      0,
      archiveKey.lastIndexOf(`/${prepared.versionId}/`),
    ),
  };
}

async function deleteOwner(actor: ApiTestUser, kind: "user" | "organization") {
  webhooks.configureClerkWebhookSecret();
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [],
  });
  webhooks.verifyNextClerkWebhook({
    type: kind === "user" ? "user.deleted" : "organization.deleted",
    data: { id: kind === "user" ? actor.userId : actor.orgId },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
}

async function retry(actor: ApiTestUser, kind: "user" | "organization") {
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  return await accept(
    setupApp({ context, routes: testStorageObjectCleanupRoutes })(
      testStorageObjectCleanupContract,
    ).retry({
      body:
        kind === "user"
          ? { kind, userId: actor.userId }
          : { kind, orgId: actor.orgId },
    }),
    [200],
  );
}

describe("Clerk Storage cleanup after reference deletion", () => {
  it.each(["user", "organization"] as const)(
    "resumes %s cleanup after R2 listing fails and the Storage references are gone",
    async (kind) => {
      const actor = bdd.user();
      const peer = bdd.user(kind === "user" ? { orgId: actor.orgId } : {});
      const s3 = objectStore();
      const target = await publish(actor, s3.objects);
      const retained = await publish(peer, s3.objects);
      const siblingKey = `${target.prefix}-sibling/keep.txt`;
      s3.objects.set(siblingKey, Buffer.from("outside the deleted prefix"));
      s3.beforeListing(async () => {
        await expect(
          storages.listStorages(actor, "user"),
        ).resolves.not.toContainEqual(
          expect.objectContaining({ name: target.storageName }),
        );
      });
      s3.failNext("list");
      await deleteOwner(actor, kind);
      await expect(
        storages.listStorages(actor, "user"),
      ).resolves.not.toContainEqual(
        expect.objectContaining({ name: target.storageName }),
      );
      expect(s3.objects.has(target.archiveKey)).toBeTruthy();
      // The retry resolves only durable cleanup inventory: no Storage row
      // remains from which to recover the prefix after a worker restart.
      await expect(retry(actor, kind)).resolves.toMatchObject({
        body: { processed: 1 },
      });
      expect(s3.objects.has(target.archiveKey)).toBeFalsy();
      expect(s3.objects.has(target.manifestKey)).toBeFalsy();
      expect(s3.objects.has(retained.archiveKey)).toBeTruthy();
      expect(s3.objects.has(retained.manifestKey)).toBeTruthy();
      expect(s3.objects.has(siblingKey)).toBeTruthy();
      await expect(storages.listStorages(peer, "user")).resolves.toContainEqual(
        expect.objectContaining({ name: retained.storageName }),
      );
      await expect(retry(actor, kind)).resolves.toMatchObject({
        body: { processed: 0 },
      });
    },
  );

  it("retains an exact legacy export key for retry after its source row is deleted", async () => {
    const actor = bdd.user();
    const peer = bdd.user();
    if (!actor.orgId || !peer.orgId) {
      throw new Error("Expected organization-scoped export owners");
    }
    const s3 = objectStore();
    const key = `exports/${randomUUID()}.zip`;
    const peerKey = `exports/${randomUUID()}.zip`;
    // The production endpoint no longer creates legacy one-call export rows.
    // Only this historical setup crosses the fixture boundary.
    await seedLegacyExportCleanupReferenceFixture(
      {
        userId: actor.userId,
        orgId: actor.orgId,
        s3Key: key,
      },
      context.signal,
    );
    await seedLegacyExportCleanupReferenceFixture(
      {
        userId: peer.userId,
        orgId: peer.orgId,
        s3Key: peerKey,
      },
      context.signal,
    );
    s3.objects.set(key, Buffer.from("legacy export"));
    s3.objects.set(peerKey, Buffer.from("peer export"));
    s3.failNext("delete");
    await deleteOwner(actor, "user");
    expect(s3.objects.has(key)).toBeTruthy();
    await expect(retry(actor, "user")).resolves.toMatchObject({
      body: { processed: 1 },
    });
    expect(s3.objects.has(key)).toBeFalsy();
    expect(s3.objects.has(peerKey)).toBeTruthy();
    await deleteOwner(peer, "user");
  });

  it.each(["user", "organization"] as const)(
    "drains a multi-batch %s export inventory exactly once and preserves peer outputs",
    async (kind) => {
      const actor = bdd.user();
      const peer = bdd.user();
      if (!actor.orgId || !peer.orgId) {
        throw new Error("Expected organization-scoped export owners");
      }
      const s3 = objectStore();
      const keys = Array.from({ length: 103 }, () => {
        return `exports/${randomUUID()}.zip`;
      });
      // Current production export APIs cannot construct completed legacy
      // one-call outputs, including historical rows sharing one output key.
      // Only that historical setup crosses the uniquely owned fixture boundary;
      // deletion/replay and retry still enter through the actual Clerk API.
      for (const key of keys) {
        await seedLegacyExportCleanupReferenceFixture(
          {
            userId: actor.userId,
            orgId: actor.orgId,
            s3Key: key,
          },
          context.signal,
        );
        s3.objects.set(key, Buffer.from("legacy output"));
      }
      const sharedKey = keys[0];
      if (!sharedKey) {
        throw new Error("Expected a repeated output key");
      }
      await seedLegacyExportCleanupReferenceFixture(
        {
          userId: actor.userId,
          orgId: actor.orgId,
          s3Key: sharedKey,
        },
        context.signal,
      );
      const peerKey = `exports/${randomUUID()}.zip`;
      await seedLegacyExportCleanupReferenceFixture(
        {
          userId: peer.userId,
          orgId: peer.orgId,
          s3Key: peerKey,
        },
        context.signal,
      );
      s3.objects.set(peerKey, Buffer.from("peer output"));
      s3.failNext("delete");
      await deleteOwner(actor, kind);
      const remaining = () => {
        return keys.filter((key) => {
          return s3.objects.has(key);
        });
      };
      // The first bounded worker call attempts eight unique targets: one
      // retryable failure and seven completed deletes. No target is lost when
      // reference removal and admission span more than one database batch.
      expect(remaining()).toHaveLength(96);
      await deleteOwner(actor, kind);
      expect(remaining()).toHaveLength(96);
      let processed = 0;
      for (let index = 0; index < 13; index++) {
        const result = await retry(actor, kind);
        processed += result.body.processed;
      }
      expect(processed).toBe(96);
      expect(remaining()).toHaveLength(0);
      expect(s3.objects.has(peerKey)).toBeTruthy();
      await expect(retry(actor, kind)).resolves.toMatchObject({
        body: { processed: 0 },
      });
      await deleteOwner(peer, "user");
    },
  );

  it("retries only the remaining objects after a partial DeleteObjects response", async () => {
    const actor = bdd.user();
    const s3 = objectStore();
    const target = await publish(actor, s3.objects);
    s3.failNext("partial-delete");
    await deleteOwner(actor, "user");
    expect(
      [...s3.objects.keys()].filter((key) => {
        return key.startsWith(`${target.prefix}/`);
      }),
    ).toHaveLength(1);
    await retry(actor, "user");
    expect(s3.objects.has(target.archiveKey)).toBeFalsy();
    expect(s3.objects.has(target.manifestKey)).toBeFalsy();
  });

  it("completes a retry after a successful R2 delete loses its response", async () => {
    const actor = bdd.user();
    const s3 = objectStore();
    const target = await publish(actor, s3.objects);
    s3.failNext("lost-delete-receipt");
    await deleteOwner(actor, "user");
    expect(s3.objects.has(target.archiveKey)).toBeFalsy();
    expect(s3.objects.has(target.manifestKey)).toBeFalsy();
    await expect(retry(actor, "user")).resolves.toMatchObject({
      body: { processed: 1 },
    });
    await expect(retry(actor, "user")).resolves.toMatchObject({
      body: { processed: 0 },
    });
  });

  it("continues a bounded prefix page from durable inventory", async () => {
    const actor = bdd.user();
    const s3 = objectStore();
    const target = await publish(actor, s3.objects);
    for (let index = 0; index < 1001; index++) {
      s3.objects.set(
        `${target.prefix}/extra-${index}.txt`,
        Buffer.from("extra"),
      );
    }
    await deleteOwner(actor, "user");
    expect(
      [...s3.objects.keys()].filter((key) => {
        return key.startsWith(`${target.prefix}/`);
      }),
    ).toHaveLength(3);
    await retry(actor, "user");
    expect(
      [...s3.objects.keys()].filter((key) => {
        return key.startsWith(`${target.prefix}/`);
      }),
    ).toHaveLength(0);
  });
});
