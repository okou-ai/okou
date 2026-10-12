import { memoryArchive } from "./helpers/public-runner-memory";

import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { billingStatusRoutes } from "../billing-status";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { configureNativeCliArtifact } from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);

function objectStore() {
  const objects = new Map<string, Buffer>();
  let failure: "delete" | "partial-delete" | "lost-delete-receipt" | undefined;
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      const body = command.input.Key
        ? objects.get(command.input.Key)
        : undefined;
      if (!body) {
        return Promise.reject(
          Object.assign(new Error("Missing object"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      return Promise.resolve({ ContentLength: body.length });
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      const keys = [...objects.keys()]
        .filter((key) => {
          return key.startsWith(prefix);
        })
        .sort();
      const page = keys.slice(0, command.input.MaxKeys ?? 1000);
      return Promise.resolve({
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
      });
    }
    if (command instanceof DeleteObjectsCommand) {
      if (failure === "delete") {
        failure = undefined;
        return Promise.reject(
          new Error("R2 deletion failed before removing the object"),
        );
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
        return Promise.resolve({
          Errors: [
            {
              Key: remaining,
              Code: "InternalError",
              Message: "Partial delete failed",
            },
          ],
        });
      }
      for (const key of keys) {
        objects.delete(key);
      }
      if (failure === "lost-delete-receipt") {
        failure = undefined;
        return Promise.reject(
          new Error("Delete response was lost after R2 removed the objects"),
        );
      }
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
  return {
    objects,
    failNext(value: "delete" | "partial-delete" | "lost-delete-receipt") {
      failure = value;
    },
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
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://r2.example.com/storages/presigned?sig=bdd",
  );
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
  await deleteOwner(fixture.actor);
}

async function deleteOwner(actor: ApiTestUser) {
  webhooks.configureClerkWebhookSecret();
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [],
  });
  webhooks.verifyNextClerkWebhook({
    type: "user.deleted",
    data: { id: actor.userId },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
}

describe("Clerk Storage cleanup after reference deletion", () => {
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
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
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
