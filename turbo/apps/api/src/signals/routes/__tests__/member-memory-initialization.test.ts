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
    const actor = api.user({ orgRole: "org:member" });
    await completeOnboarding(actor);
    const files = [storageTextFile("memory.md", "Keep this existing memory")];
    storages.mockStorageObjectsExist();
    const prepared = await storages.prepareStorage(actor, {
      storageName: "memory",
      storageOwner: "user",
      files,
    });
    await storages.commitStorage(actor, {
      storageName: "memory",
      storageOwner: "user",
      versionId: prepared.versionId,
      files,
    });
    const published = await memoryDownload(actor);
    expect(published).toMatchObject({
      versionId: prepared.versionId,
      fileCount: 1,
    });
    await completeOnboarding(actor);
    await membershipCreated(actor);
    await expect(memoryDownload(actor)).resolves.toStrictEqual(published);
  });
});
