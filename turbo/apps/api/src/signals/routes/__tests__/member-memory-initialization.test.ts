import { gunzipSync } from "node:zlib";
import {
  createPublicRunnerMemory,
  memoryArchive,
} from "./helpers/public-runner-memory";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const api = createBddApi(context);
const storages = createStoragesBddApi(context);
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

async function memoryDownload(actor: ApiTestUser) {
  return await storages.downloadStorage(actor, {
    name: "memory",
    owner: "user",
  });
}

describe("member memory account initialization", () => {
  it.each(["org:admin", "org:member"] as const)(
    "synchronously initializes one memory for duplicate %s onboarding completions",
    async (orgRole) => {
      const actor = api.user({ orgRole });
      api.acceptAgentStorageWrites();
      await Promise.all([completeOnboarding(actor), completeOnboarding(actor)]);
      const initial = await memoryDownload(actor);
      expect(initial).toMatchObject({ empty: true, fileCount: 0, size: 0 });
      await completeOnboarding(actor);
      await expect(memoryDownload(actor)).resolves.toStrictEqual(initial);
      expect(
        (await storages.listStorages(actor, "user")).filter((storage) => {
          return storage.name === "memory";
        }),
      ).toHaveLength(1);
    },
  );

  it("initializes memory on a membership webhook without Web onboarding", async () => {
    const actor = api.user({ orgRole: "org:member" });
    await expect(storages.listStorages(actor, "user")).resolves.toStrictEqual(
      [],
    );
    await membershipCreated(actor);
    const initial = await memoryDownload(actor);
    expect(initial).toMatchObject({ empty: true, fileCount: 0, size: 0 });
    await membershipCreated(actor);
    await expect(memoryDownload(actor)).resolves.toStrictEqual(initial);
  });

  it("isolates memory by both organization and user", async () => {
    const first = api.user({ orgRole: "org:member" });
    const anotherOrg = api.user({
      userId: first.userId,
      orgRole: "org:member",
    });
    const anotherMember = api.user({
      orgId: first.orgId,
      orgRole: "org:member",
    });
    const versions = [];
    for (const actor of [first, anotherOrg, anotherMember]) {
      await completeOnboarding(actor);
      versions.push((await memoryDownload(actor)).versionId);
    }
    expect(new Set(versions).size).toBe(3);
  });

  it("preserves published memory when either initialization entry is repeated", async () => {
    const fixture = createPublicRunnerMemory(context, {
      orgRole: "org:member",
    });
    await fixture.run(async () => {
      const actor = fixture.actor;
      const agentId = await fixture.initializeNative();
      const initial = await fixture.claim(
        agentId,
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
      const repeated = await fixture.claim(
        agentId,
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
