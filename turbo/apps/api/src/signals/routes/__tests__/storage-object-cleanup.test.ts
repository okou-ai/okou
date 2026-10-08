import { memoryArchive } from "./helpers/public-runner-memory";
import { randomUUID } from "node:crypto";

import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { testStorageObjectCleanupContract } from "@okouai/api-contracts/contracts/test-storage-object-cleanup";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { billingStatusRoutes } from "../billing-status";
import { testStorageObjectCleanupRoutes } from "../test-storage-object-cleanup";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { configureNativeCliArtifact } from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
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

async function publicCleanupFixture() {
  const actor = bdd.user();
  // The real first request owns isolation; testContext disposes it after
  // draining work, without authenticating a deleted user during teardown.
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  const billing = await setupApp({
    context,
    routes: billingStatusRoutes,
    isolatePg: true,
  });
  const initial = await accept(
    billing(billingStatusContract).get({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  expect(initial.body.credits).toBe(0);
  // This directory member keeps user deletion from implicitly deleting the org.
  const peer = bdd.user({ orgId: actor.orgId });
  return { actor, peer };
}

async function publishOwnedCleanupMemory(
  fixture: Awaited<ReturnType<typeof publicCleanupFixture>>,
) {
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  runs.configureRunnerGroup();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  configureNativeCliArtifact();
  createFirewallApi(context).seedClerkDirectory(fixture.actor);
  await runs.grantProEntitlement(fixture.actor);
  await runs.ensurePersonalSubscriptionModel(fixture.actor, {
    model: "claude-fable-5-1",
  });
  const agent = await bdd.createAgent(fixture.actor, {
    displayName: "Owned Memory carrier",
    visibility: "private",
  });
  const run = await runs.createThreadRun(fixture.actor, {
    agentId: agent.agentId,
    prompt: "Publish the deletion fixture",
    model: "claude-fable-5-1",
  });
  const execution = await runs.claimRunnerJob(run.runId);
  const manifest = expectCanonicalStorageManifest(execution.storageManifest);
  const memories =
    manifest?.storageMounts.filter((mount) => {
      return mount.name === "memory";
    }) ?? [];
  const memory = memories[0];
  if (memories.length !== 1 || !memory?.storageId) {
    throw new Error("Expected exactly one real Memory mount");
  }
  const headers = { authorization: `Bearer ${execution.sandboxToken}` };
  const s3 = objectStore();
  storages.mockStoragePresignedUrls();
  const files = [storageTextFile("content.txt", "retained storage content")];
  const prepared = await webhooks.requestAgentStoragePrepare(
    { runId: run.runId, storageId: memory.storageId, files },
    headers,
    [200],
  );
  if (prepared.status !== 200 || !prepared.body.uploads) {
    throw new Error("Expected owned Memory upload targets");
  }
  const archiveKey = prepared.body.uploads.archive.key;
  const manifestKey = prepared.body.uploads.manifest.key;
  s3.objects.set(
    archiveKey,
    memoryArchive("content.txt", "retained storage content"),
  );
  s3.objects.set(
    manifestKey,
    Buffer.from(
      JSON.stringify({
        version: 1,
        files,
        createdAt: new Date(0).toISOString(),
      }),
    ),
  );
  await webhooks.requestAgentStorageCommit(
    {
      runId: run.runId,
      storageId: memory.storageId,
      versionId: prepared.body.versionId,
      files,
    },
    headers,
    [200],
  );
  await runs.requestCancelRun(fixture.actor, run.runId, [200]);
  await webhooks.requestAgentComplete(
    {
      runId: run.runId,
      exitCode: 1,
      error: "Owned deletion carrier cancelled",
    },
    headers,
    [200],
  );
  await flushWaitUntilForTest();
  return {
    s3,
    target: {
      archiveKey,
      manifestKey,
      prefix: archiveKey.slice(
        0,
        archiveKey.lastIndexOf(`/${prepared.body.versionId}/`),
      ),
    },
  };
}

async function deletePublicCleanupOwner(
  fixture: Awaited<ReturnType<typeof publicCleanupFixture>>,
) {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          role: "org:member",
          publicUserData: { userId: fixture.peer.userId },
          organization: { id: fixture.actor.orgId },
        },
      ],
    },
  );
  await deleteOwner(fixture.actor, "user");
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

  it("retains owned objects when R2 deletion fails during public user deletion", async () => {
    const fixture = await publicCleanupFixture();
    const { s3, target } = await publishOwnedCleanupMemory(fixture);
    s3.failNext("delete");
    await deletePublicCleanupOwner(fixture);
    expect(context.mocks.s3.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Delete: expect.objectContaining({
            Objects: expect.arrayContaining([
              { Key: target.archiveKey },
              { Key: target.manifestKey },
            ]),
          }),
        }),
      }),
    );
    expect(s3.objects.has(target.archiveKey)).toBeTruthy();
    expect(s3.objects.has(target.manifestKey)).toBeTruthy();
  });

  it("retains the object rejected by R2 during public user deletion", async () => {
    const fixture = await publicCleanupFixture();
    const { s3, target } = await publishOwnedCleanupMemory(fixture);
    s3.failNext("partial-delete");
    await deletePublicCleanupOwner(fixture);
    expect(
      [...s3.objects.keys()].filter((key) => {
        return key.startsWith(`${target.prefix}/`);
      }),
    ).toHaveLength(1);
  });

  it("deletes owned objects when the R2 response is lost during public user deletion", async () => {
    const fixture = await publicCleanupFixture();
    const { s3, target } = await publishOwnedCleanupMemory(fixture);
    s3.failNext("lost-delete-receipt");
    await deletePublicCleanupOwner(fixture);
    expect(s3.objects.has(target.archiveKey)).toBeFalsy();
    expect(s3.objects.has(target.manifestKey)).toBeFalsy();
  });
});
