import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { computeContentHashFromHashes } from "@okouai/api-contracts/contracts/storage-content-hash";
import {
  createPublicRunnerMemory,
  memoryArchive,
} from "./helpers/public-runner-memory";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { buildArtifactKeyV2 } from "../../../lib/file-url";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, joinAll, onRejection } from "../../utils";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { userPreferencesRoutes } from "../user-preferences";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const api = createBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const mocks = createRouteMocks(context);

async function completeOnboarding(actor: ApiTestUser): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected an organization member");
  }
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const client = setupApp({ context, routes: onboardingCompleteRoutes })(
    onboardingCompleteContract,
  );
  await accept(
    client.complete({
      headers: { authorization: "Bearer clerk-session" },
      body: {},
    }),
    [200],
  );
}

async function membershipCreated(actor: ApiTestUser): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected an organization member");
  }
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organizationMembership.created",
    data: {
      id: `membership-${actor.userId}-${actor.orgId}`,
      organization: { id: actor.orgId },
      public_user_data: { user_id: actor.userId },
      role: actor.orgRole ?? "org:member",
      created_at: now(),
    },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
}

/** Set normal preference fields without invoking the memory-initializing route. */
async function prepareReadablePreferences(actor: ApiTestUser): Promise<void> {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const preferences = setupApp({ context, routes: userPreferencesRoutes })(
    userPreferencesContract,
  );
  const updated = await accept(
    preferences.update({
      headers: { authorization: "Bearer clerk-session" },
      body: { timezone: "UTC", locale: "en-US" },
    }),
    [200],
  );
  expect(updated.body.memoryInitialized).toBeFalsy();
}

async function memoryInitialized(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const preferences = setupApp({ context, routes: userPreferencesRoutes })(
    userPreferencesContract,
  );
  return (
    await accept(
      preferences.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    )
  ).body.memoryInitialized;
}
async function observeMemory(
  owner: ReturnType<typeof createPublicComputerUseScenario>,
  actor: ApiTestUser,
) {
  const runs = createRunsApi(context);
  if (actor.orgRole === "org:member") {
    await owner.prepareActor(
      owner.user({ orgId: actor.orgId, orgRole: "org:admin" }),
    );
  }
  const { runnerGroup } = await owner.prepareActor(actor);
  const run = await runs.createThreadRun(actor, {
    prompt: "Observe this member's initialized Memory",
    model: "claude-fable-5-1",
  });
  await runs.heartbeatRunner(runnerGroup);
  const receivedExecution = await owner.executionInput(actor, run.runId);
  const memories =
    expectCanonicalStorageManifest(
      receivedExecution.storageManifest,
    )?.storageMounts.filter((mount) => {
      return mount.name === "memory";
    }) ?? [];
  expect(memories).toHaveLength(1);
  const memory = memories[0];
  if (!memory) {
    throw new Error("Expected the member's real Memory mount");
  }
  await owner.cancelRun(actor, run.runId);
  return memory;
}

describe("member memory account initialization", () => {
  it("mounts the same Memory in first Runs that both observed an uninitialized member", async () => {
    const owner = createPublicComputerUseScenario(context);
    const admin = owner.user({ orgRole: "org:admin" });
    const actor = owner.user({ orgId: admin.orgId, orgRole: "org:member" });
    await owner.run(async () => {
      await owner.prepareActor(admin);
      const runs = createRunsApi(context);
      await runs.ensurePersonalSubscriptionModel(actor);

      await prepareReadablePreferences(actor);

      const { sendChatRun } = createChatEventsFixture(context);
      const fileId = randomUUID();
      const filename = "first-run.txt";
      const key = buildArtifactKeyV2(fileId, filename);
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const originalSend = context.mocks.s3.send.getMockImplementation();
      context.mocks.s3.send.mockImplementation(async (command: unknown) => {
        if (command instanceof HeadObjectCommand && command.input.Key === key) {
          entered.resolve(undefined);
          await release.promise;
          return {
            ContentLength: 42,
            ContentType: "text/plain",
            LastModified: new Date(0),
            Metadata: {
              "artifact-id": fileId,
              filename: encodeURIComponent(filename),
              "user-id": encodeURIComponent(actor.userId),
            },
          };
        }
        return await originalSend?.(command);
      });
      const prompt = "Start my first Run with an attachment";
      const sending = onRejection(
        sendChatRun(actor, {
          prompt,
          userMessage: {
            version: 1,
            parts: [
              {
                type: "file",
                fileId,
                filenameSnapshot: filename,
                contentType: "text/plain",
              },
              { type: "text", text: prompt },
            ],
          },
        }),
        (error) => {
          if (!entered.settled()) {
            entered.reject(error);
          }
        },
      );
      const [waitingRun, firstMounts] = await joinAll([
        sending,
        (async () => {
          await entered.promise;
          // Drain the early reads while attachment verification holds the
          // send before enqueue. The other Run can initialize Memory first.
          await flushWaitUntilForTest();
          const run = await runs.createThreadRun(actor, {
            prompt: "Start my first Run without an attachment",
          });
          const execution = await owner.executionInput(actor, run.runId);
          await owner.cancelRun(actor, run.runId);
          return expectCanonicalStorageManifest(execution.storageManifest)
            ?.storageMounts;
        })().finally(() => {
          if (!release.settled()) {
            release.resolve(undefined);
          }
        }),
      ]);
      const execution = await owner.executionInput(actor, waitingRun.runId);
      const mounts = expectCanonicalStorageManifest(
        execution.storageManifest,
      )?.storageMounts;
      expect(mounts).toStrictEqual(firstMounts);
      expect(mounts).toHaveLength(1);
      const memory = mounts?.[0];
      expect(memory).toMatchObject({
        name: "memory",
        empty: true,
        writeback: true,
        missingRootPolicy: "preserveParentVersion",
      });
      if (!memory?.storageId) {
        throw new Error("Expected the initialized Memory");
      }
      expect(memory.versionId).toBe(
        computeContentHashFromHashes(memory.storageId, []),
      );
      await expect(memoryInitialized(actor)).resolves.toBeTruthy();
    });
  });

  it.each(["org:admin", "org:member"] as const)(
    "initializes and replays memory through authenticated %s preferences",
    async (orgRole) => {
      const owner = createPublicComputerUseScenario(context);
      const actor = owner.user({ orgRole });
      await owner.run(async () => {
        await prepareReadablePreferences(actor);
        await expect(memoryInitialized(actor)).resolves.toBeFalsy();
        mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
        const preferences = setupApp({
          context,
          routes: userPreferencesRoutes,
        })(userPreferencesContract);
        const initialized = await accept(
          preferences.initialize({
            headers: { authorization: "Bearer clerk-session" },
            body: { timezone: "Asia/Tokyo", locale: "ja-JP" },
          }),
          [200],
        );
        expect(initialized.body).toMatchObject({
          memoryInitialized: true,
          timezone: "UTC",
          locale: "en-US",
        });
        const replayed = await accept(
          preferences.initialize({
            headers: { authorization: "Bearer clerk-session" },
            body: { timezone: "America/Los_Angeles", locale: "fr-FR" },
          }),
          [200],
        );
        expect(replayed.body).toStrictEqual(initialized.body);
        // Both responses precede funding/onboarding that could also create Memory.
        await expect(memoryInitialized(actor)).resolves.toBeTruthy();
        const initial = await observeMemory(owner, actor);
        expect(initial).toMatchObject({
          empty: true,
          name: "memory",
          storageId: expect.any(String),
          versionId: expect.any(String),
        });
        expect(initial.versionId).toBe(
          computeContentHashFromHashes(initial.storageId, []),
        );
        await accept(
          preferences.initialize({
            headers: { authorization: "Bearer clerk-session" },
            body: { locale: "ja-JP" },
          }),
          [200],
        );
        const repeated = await observeMemory(owner, actor);
        expect(repeated).toMatchObject({
          empty: true,
          storageId: initial.storageId,
          versionId: initial.versionId,
        });
      });
    },
  );

  it("shares one memory across concurrent onboarding and membership delivery", async () => {
    const owner = createPublicComputerUseScenario(context);
    const actor = owner.user({ orgRole: "org:member" });
    await owner.run(async () => {
      api.acceptStorageWrites();
      await prepareReadablePreferences(actor);
      await expect(memoryInitialized(actor)).resolves.toBeFalsy();
      const deliveries = await Promise.allSettled([
        completeOnboarding(actor),
        membershipCreated(actor),
      ]);
      for (const result of deliveries) {
        if (result.status === "rejected") {
          throw result.reason;
        }
      }
      await expect(memoryInitialized(actor)).resolves.toBeTruthy();
      const initial = await observeMemory(owner, actor);
      expect(initial).toMatchObject({ empty: true, name: "memory" });
      await completeOnboarding(actor);
      await membershipCreated(actor);
      const repeated = await observeMemory(owner, actor);
      expect(repeated).toMatchObject({
        empty: true,
        storageId: initial.storageId,
        versionId: initial.versionId,
      });
    });
  });

  it.each(["org:admin", "org:member"] as const)(
    "synchronously initializes one memory for duplicate %s onboarding completions",
    async (orgRole) => {
      const owner = createPublicComputerUseScenario(context);
      const actor = owner.user({ orgRole });
      await owner.run(async () => {
        api.acceptStorageWrites();
        await prepareReadablePreferences(actor);
        await expect(memoryInitialized(actor)).resolves.toBeFalsy();
        const completions = await Promise.allSettled([
          completeOnboarding(actor),
          completeOnboarding(actor),
        ]);
        for (const result of completions) {
          if (result.status === "rejected") {
            throw result.reason;
          }
        }
        await expect(memoryInitialized(actor)).resolves.toBeTruthy();
        const initial = await observeMemory(owner, actor);
        expect(initial).toMatchObject({
          empty: true,
          name: "memory",
          storageId: expect.any(String),
          versionId: expect.any(String),
        });
        await completeOnboarding(actor);
        await expect(memoryInitialized(actor)).resolves.toBeTruthy();
        const repeated = await observeMemory(owner, actor);
        expect(repeated).toMatchObject({
          empty: true,
          storageId: initial.storageId,
          versionId: initial.versionId,
        });
      });
    },
  );

  it("initializes memory on a membership webhook without Web onboarding", async () => {
    const owner = createPublicComputerUseScenario(context);
    const actor = owner.user({ orgRole: "org:member" });
    await owner.run(async () => {
      await prepareReadablePreferences(actor);
      await expect(memoryInitialized(actor)).resolves.toBeFalsy();
      await membershipCreated(actor);
      await expect(memoryInitialized(actor)).resolves.toBeTruthy();
      // Observe webhook replay before any later funding/onboarding can initialize Memory.
      await membershipCreated(actor);
      await expect(memoryInitialized(actor)).resolves.toBeTruthy();
      const initial = await observeMemory(owner, actor);
      expect(initial).toMatchObject({
        empty: true,
        name: "memory",
        storageId: expect.any(String),
        versionId: expect.any(String),
      });
      await membershipCreated(actor);
      const repeated = await observeMemory(owner, actor);
      expect(repeated).toMatchObject({
        empty: true,
        storageId: initial.storageId,
        versionId: initial.versionId,
      });
    });
  });

  it("isolates memory by both organization and user", async () => {
    const owner = createPublicComputerUseScenario(context);
    const first = owner.user({ orgRole: "org:member" });
    const anotherOrg = owner.user({
      userId: first.userId,
      orgRole: "org:member",
    });
    const anotherMember = owner.user({
      orgId: first.orgId,
      orgRole: "org:member",
    });
    await owner.run(async () => {
      api.acceptStorageWrites();
      const memories = [];
      for (const actor of [first, anotherOrg, anotherMember]) {
        await prepareReadablePreferences(actor);
        await expect(memoryInitialized(actor)).resolves.toBeFalsy();
        await completeOnboarding(actor);
        await expect(memoryInitialized(actor)).resolves.toBeTruthy();
        const memory = await observeMemory(owner, actor);
        expect(memory.empty).toBeTruthy();
        memories.push(memory);
      }
      expect(
        new Set(
          memories.map((memory) => {
            return memory.storageId;
          }),
        ).size,
      ).toBe(3);
      expect(
        new Set(
          memories.map((memory) => {
            return memory.versionId;
          }),
        ).size,
      ).toBe(3);
    });
  });

  it("preserves publication racing a membership initialization replay", async () => {
    const fixture = createPublicRunnerMemory(context, {
      orgRole: "org:member",
    });
    await fixture.run(async () => {
      await fixture.initializeNative();
      const writer = await fixture.startExecution(
        "Publish while membership delivery is replayed",
      );
      fixture.installObjects();
      const content = "Publication survives concurrent member initialization";
      const [versionId] = await Promise.all([
        fixture.publish(writer, [{ path: "memory.md", content }]),
        membershipCreated(fixture.actor),
      ]);
      const reader = await fixture.startExecution(
        "Read the published Memory after membership replay",
      );
      expect(reader.memory).toMatchObject({
        storageId: writer.memory.storageId,
        versionId,
        archiveUrl: expect.any(String),
      });
      if (!reader.memory.archiveUrl) {
        throw new Error("Expected the published Memory archive URL");
      }
      const downloaded = await fetch(reader.memory.archiveUrl, {
        signal: context.signal,
      });
      expect(downloaded.status).toBe(200);
      expect(Buffer.from(await downloaded.arrayBuffer())).toStrictEqual(
        memoryArchive("memory.md", content),
      );
    });
  });

  it("preserves published memory when either initialization entry is repeated", async () => {
    const fixture = createPublicRunnerMemory(context, {
      orgRole: "org:member",
    });
    await fixture.run(async () => {
      const actor = fixture.actor;
      await fixture.initializeNative();
      const initial = await fixture.startExecution(
        "Publish existing member Memory",
      );
      const content = "Keep this existing memory";
      const files = [storageTextFile("memory.md", content)];
      const archive = memoryArchive("memory.md", content);
      fixture.installObjects();
      const prepared = await webhooks.requestAgentStoragePrepare(
        {
          runId: initial.run.runId,
          storageId: initial.memory.storageId,
          files,
        },
        initial.headers,
        [200],
      );
      if (prepared.status !== 200 || !prepared.body.uploads) {
        throw new Error("Expected real Memory uploads");
      }
      fixture.objects.set(prepared.body.uploads.archive.key, archive);
      fixture.objects.set(
        prepared.body.uploads.manifest.key,
        Buffer.from(
          JSON.stringify({
            version: 1,
            files,
            createdAt: new Date(0).toISOString(),
          }),
        ),
      );
      const published = await webhooks.requestAgentStorageCommit(
        {
          runId: initial.run.runId,
          storageId: initial.memory.storageId,
          versionId: prepared.body.versionId,
          files,
        },
        initial.headers,
        [200],
      );
      expect(published.body).toMatchObject({
        versionId: prepared.body.versionId,
        fileCount: 1,
      });
      await completeOnboarding(actor);
      await membershipCreated(actor);
      const repeated = await fixture.startExecution(
        "Read preserved member Memory",
      );
      expect(repeated.memory).toMatchObject({
        storageId: initial.memory.storageId,
        versionId: prepared.body.versionId,
        archiveUrl: expect.any(String),
      });
      expect(repeated.memory.empty).toBeUndefined();
      if (!repeated.memory.archiveUrl) {
        throw new Error("Expected the published Memory archive URL");
      }
      const downloaded = await fetch(repeated.memory.archiveUrl, {
        signal: context.signal,
      });
      expect(downloaded.status).toBe(200);
      const bytes = Buffer.from(await downloaded.arrayBuffer());
      expect(bytes).toStrictEqual(archive);
      const tar = gunzipSync(bytes);
      expect(
        tar.subarray(0, 100).toString("utf8").split(String.fromCharCode(0))[0],
      ).toBe("memory.md");
      expect(
        tar.subarray(512, 512 + Buffer.byteLength(content)).toString("utf8"),
      ).toBe(content);
    });
  });
});
