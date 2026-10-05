import { randomUUID } from "node:crypto";

import { DeleteObjectsCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { onTestFinished } from "vitest";
import {
  agentInstructionsContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { SEED_INSTRUCTIONS } from "@okouai/core/seed-instructions";
import { getInstructionsStorageName } from "@okouai/core/storage-names";
import { testStorageObjectCleanupContract } from "@okouai/api-contracts/contracts/test-storage-object-cleanup";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { agentInstructionsRoutes } from "../agent-instructions";
import { agentsRoutes } from "../agents";
import { billingStatusRoutes } from "../billing-status";
import { onboardingStatusRoutes } from "../onboarding-status";
import { runModelsRoutes } from "../run-models";
import { SEEDED_SYSTEM_DEFAULT_MODEL } from "./helpers/seeded-system-default";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import { tarGz } from "./helpers/template-publish-fixture";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { testStorageObjectCleanupRoutes } from "../test-storage-object-cleanup";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function clients(
  options: { readonly rethrowErrors?: boolean } = {},
  signal: AbortSignal = context.signal,
) {
  const app = setupApp({
    context,
    signal,
    rethrowErrors: options.rethrowErrors,
    routes: [
      ...onboardingStatusRoutes,
      ...agentsRoutes,
      ...agentInstructionsRoutes,
      ...billingStatusRoutes,
      ...runModelsRoutes,
    ],
  });
  return {
    status: app(onboardingStatusContract),
    agents: app(agentsMainContract),
    instructions: app(agentInstructionsContract),
    billing: app(billingStatusContract),
    models: app(runModelsMainContract),
  };
}

function authenticateAdmin(): string {
  const orgId = `org_${randomUUID()}`;
  mocks.clerk.session(`user_${randomUUID()}`, orgId, "org:admin");
  return orgId;
}

function pausedSeedUpload(orgId: string) {
  const started = createDeferredPromise<string>(context.signal);
  const released = createDeferredPromise<"success" | "failure">(context.signal);
  let paused = false;
  const storage = installDurableUserExportStorage(context, {
    prefixes: [`${orgId}/`],
    afterWrite: async (command) => {
      if (
        !paused &&
        command instanceof PutObjectCommand &&
        command.input.Key?.endsWith("/archive.tar.gz")
      ) {
        paused = true;
        started.resolve(command.input.Key);
        const outcome = await released.promise;
        if (outcome === "failure") {
          throw new Error("Seed upload response failed after persisting bytes");
        }
      }
    },
  });
  onTestFinished(() => {
    if (!released.settled()) {
      released.resolve("success");
    }
  });
  return {
    storage,
    started: started.promise,
    release(outcome: "success" | "failure") {
      if (!released.settled()) {
        released.resolve(outcome);
      }
    },
  };
}

async function readDefaultId(api: ReturnType<typeof clients>): Promise<string> {
  const response = await accept(api.status.getStatus({ headers }), [200]);
  const agentId = response.body.defaultAgentId;
  if (!agentId) {
    throw new Error("Expected a usable default Agent");
  }
  return agentId;
}

async function expectInstructions(
  api: ReturnType<typeof clients>,
  agentId: string,
  content: string,
): Promise<void> {
  const instructions = await accept(
    api.instructions.get({ headers, params: { id: agentId } }),
    [200],
  );
  expect(instructions.body.content).toBe(content);
}

async function expectSingleOnboardingGrant(
  api: ReturnType<typeof clients>,
): Promise<void> {
  const billing = await accept(api.billing.get({ headers }), [200]);
  expect(billing.body.credits).toBe(1000);
  expect(billing.body.creditGrants).toStrictEqual([
    expect.objectContaining({
      source: "onboarding",
      amount: 1000,
      remaining: 1000,
    }),
  ]);
}

async function retryOwnedCleanup(orgId: string): Promise<void> {
  // Only the infrastructure retry clock is unavailable through production APIs.
  // This route advances backoff for this uniquely owned organization's jobs.
  await accept(
    setupApp({ context, routes: testStorageObjectCleanupRoutes })(
      testStorageObjectCleanupContract,
    ).retry({ body: { kind: "organization", orgId } }),
    [200],
  );
}

async function deleteOrganization(orgId: string): Promise<void> {
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureClerkWebhookSecret();
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [],
  });
  webhooks.verifyNextClerkWebhook({
    type: "organization.deleted",
    data: { id: orgId },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
}

function joinPendingRequest(
  pending: Promise<unknown>,
  release: () => void,
): void {
  const joined = Promise.allSettled([pending]);
  onTestFinished(async () => {
    release();
    await joined;
  });
}

// Bootstrap, Agent, instruction, billing and deletion interactions use production
// APIs. The two explicitly historical parent setups use the existing named
// Storage fixture; that generic production prepare API was retired in #23143.
describe("default Agent bootstrap", () => {
  it("publishes one usable default and one grant for concurrent status requests", async () => {
    const orgId = authenticateAdmin();
    installDurableUserExportStorage(context, { prefixes: [`${orgId}/`] });
    const api = clients();
    const responses = await Promise.all([
      accept(api.status.getStatus({ headers }), [200]),
      accept(api.status.getStatus({ headers }), [200]),
      accept(api.status.getStatus({ headers }), [200]),
    ]);
    const agentId = responses[0]?.body.defaultAgentId;
    if (!agentId) {
      throw new Error("Expected a usable default Agent");
    }
    for (const response of responses) {
      expect(response.body).toMatchObject({
        hasDefaultAgent: true,
        defaultAgentId: agentId,
      });
    }
    const listed = await accept(api.agents.list({ headers }), [200]);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]?.agentId).toBe(agentId);
    const instructions = await accept(
      api.instructions.get({ headers, params: { id: agentId } }),
      [200],
    );
    expect(instructions.body.content).toBe(SEED_INSTRUCTIONS);
    const policies = await accept(api.models.list({ headers }), [200]);
    expect(policies.body.defaultModel).toBe("okou-1.0");
    expect(policies.body.models).toStrictEqual([
      expect.objectContaining({
        model: SEEDED_SYSTEM_DEFAULT_MODEL,
        defaultProviderType: "built-in",
        credentialScope: "org",
      }),
    ]);

    const edited = "Keep the workspace's edited instructions.";
    await accept(
      api.instructions.update({
        headers,
        params: { id: agentId },
        body: { content: edited },
      }),
      [200],
    );
    await accept(api.status.getStatus({ headers }), [200]);
    const after = await accept(
      api.instructions.get({ headers, params: { id: agentId } }),
      [200],
    );
    expect(after.body.content).toBe(edited);
    const billing = await accept(api.billing.get({ headers }), [200]);
    expect(billing.body.credits).toBe(1000);
    expect(billing.body.creditGrants).toStrictEqual([
      expect.objectContaining({
        source: "onboarding",
        amount: 1000,
        remaining: 1000,
      }),
    ]);
  });

  it.each(["archive.tar.gz", "manifest.json"])(
    "recovers a usable default after %s upload fails without granting twice",
    async (filename) => {
      const orgId = authenticateAdmin();
      let rejectArchiveUpload = true;
      installDurableUserExportStorage(context, {
        prefixes: [`${orgId}/`],
        afterWrite: (command) => {
          if (
            rejectArchiveUpload &&
            command instanceof PutObjectCommand &&
            command.input.Key?.endsWith(`/${filename}`)
          ) {
            rejectArchiveUpload = false;
            // Model an object store that persisted the bytes before the response
            // failed, so bootstrap must compensate even though its row rolls back.
            return Promise.reject(
              new Error("Object store upload response failed"),
            );
          }
          return Promise.resolve();
        },
      });
      const api = clients();
      const failed = await accept(api.status.getStatus({ headers }), [200]);
      expect(failed.body).toMatchObject({
        hasDefaultAgent: false,
        defaultAgentId: null,
      });
      const beforeRetry = await accept(api.agents.list({ headers }), [200]);
      expect(beforeRetry.body).toStrictEqual([]);

      const retries = await Promise.all([
        accept(api.status.getStatus({ headers }), [200]),
        accept(api.status.getStatus({ headers }), [200]),
      ]);
      const agentId = retries[0]?.body.defaultAgentId;
      if (!agentId) {
        throw new Error("Expected bootstrap retry to publish a default Agent");
      }
      for (const retry of retries) {
        expect(retry.body.defaultAgentId).toBe(agentId);
      }
      const instructions = await accept(
        api.instructions.get({ headers, params: { id: agentId } }),
        [200],
      );
      expect(instructions.body.content).toBe(SEED_INSTRUCTIONS);
      const billing = await accept(api.billing.get({ headers }), [200]);
      expect(billing.body.credits).toBe(1000);
      expect(billing.body.creditGrants).toHaveLength(1);
    },
  );

  it.each(["success", "failure", "cancel"] as const)(
    "lets a peer finish during stalled seed IO and preserves edits after the late %s",
    async (outcome) => {
      const orgId = authenticateAdmin();
      const upload = pausedSeedUpload(orgId);
      const controller = new AbortController();
      onTestFinished(() => {
        controller.abort();
      });
      const api = clients();
      const pending = clients(
        { rethrowErrors: outcome === "cancel" },
        AbortSignal.any([context.signal, controller.signal]),
      ).status.getStatus({ headers });
      joinPendingRequest(pending, () => {
        upload.release("success");
      });
      const losingArchiveKey = await upload.started;

      // Completion before releasing the provider proves preparation does not
      // hold bootstrap's canonical publication boundary across network work.
      const agentId = await readDefaultId(api);
      await expectInstructions(api, agentId, SEED_INSTRUCTIONS);
      const edited = `Instructions edited while the ${outcome} upload is pending.`;
      await accept(
        api.instructions.update({
          headers,
          params: { id: agentId },
          body: { content: edited },
        }),
        [200],
      );
      if (outcome === "cancel") {
        controller.abort(new DOMException("Request cancelled", "AbortError"));
      }
      upload.release(outcome === "failure" ? "failure" : "success");
      if (outcome === "cancel") {
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      } else {
        const late = await accept(pending, [200]);
        if (outcome === "success") {
          expect(late.body.defaultAgentId).toBe(agentId);
        }
      }
      await expect(readDefaultId(api)).resolves.toBe(agentId);
      await expectInstructions(api, agentId, edited);
      const listed = await accept(api.agents.list({ headers }), [200]);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0]?.agentId).toBe(agentId);
      await expectSingleOnboardingGrant(api);
      expect(upload.storage.hasObject(losingArchiveKey)).toBeFalsy();
    },
  );

  it.each(["unregistered", "registered"] as const)(
    "recovers a historical %s canonical parent without rewriting committed content",
    async (state) => {
      const actor = createBddApi(context).user();
      if (!actor.orgId) {
        throw new Error("Expected an organization-owned historical fixture");
      }
      mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
      const storage = installDurableUserExportStorage(context, {
        prefixes: [`${actor.orgId}/`],
      });
      const legacy = createStoragesBddApi(context);
      const storageName = getInstructionsStorageName("default-agent");
      const edited =
        "Instructions retained from the historical canonical parent.";
      const files = [storageTextFile("CLAUDE.md", edited)];
      // Historical exception: current production APIs cannot reserve an arbitrary
      // named org-owned container without its Agent. #23143 retired that prepare
      // endpoint, but those persisted containers keep the same nullable HEAD.
      // Only this legacy setup crosses the fixture boundary; bootstrap and all
      // user-visible verification below call production endpoints.
      const prepared = await legacy.prepareStorage(actor, {
        storageName,
        storageOwner: "organization",
        files,
      });
      if (!prepared.uploads) {
        throw new Error("Expected an unregistered historical Storage upload");
      }
      const archiveKey = prepared.uploads.archive.key;
      storage.seedObject(
        archiveKey,
        state === "registered"
          ? tarGz([{ path: "CLAUDE.md", content: edited }])
          : Buffer.from("An unfinished, unregistered historical upload"),
      );
      if (state === "registered") {
        storage.seedObject(
          prepared.uploads.manifest.key,
          Buffer.from(
            JSON.stringify({
              version: prepared.versionId,
              createdAt: new Date(0).toISOString(),
              totalSize: files.reduce((sum, file) => {
                return sum + file.size;
              }, 0),
              fileCount: files.length,
              files,
            }),
          ),
        );
        await legacy.commitStorage(actor, {
          storageName,
          storageOwner: "organization",
          versionId: prepared.versionId,
          files,
        });
      }
      const api = clients();
      const agentId = await readDefaultId(api);
      await expectInstructions(
        api,
        agentId,
        state === "registered" ? edited : SEED_INSTRUCTIONS,
      );
      // A committed generation is retained; only the never-published parent is
      // retired and cleaned up, without trying to decode its partial archive.
      expect(storage.hasObject(archiveKey)).toBe(state === "registered");
      await expectSingleOnboardingGrant(api);
    },
  );

  it("leaves no default on first-attempt cancellation and recovers with one grant", async () => {
    const orgId = authenticateAdmin();
    const upload = pausedSeedUpload(orgId);
    const controller = new AbortController();
    onTestFinished(() => {
      controller.abort();
    });
    const pending = clients(
      { rethrowErrors: true },
      AbortSignal.any([context.signal, controller.signal]),
    ).status.getStatus({ headers });
    joinPendingRequest(pending, () => {
      upload.release("success");
    });
    const archiveKey = await upload.started;
    controller.abort(new DOMException("Request cancelled", "AbortError"));
    upload.release("success");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const api = clients();
    const beforeRetry = await accept(api.agents.list({ headers }), [200]);
    expect(beforeRetry.body).toStrictEqual([]);
    expect(upload.storage.hasObject(archiveKey)).toBeFalsy();
    const agentId = await readDefaultId(api);
    await expectInstructions(api, agentId, SEED_INSTRUCTIONS);
    await expectSingleOnboardingGrant(api);
  });

  it.each(["pro", "team"] as const)(
    "preserves a %s purchase racing final bootstrap publication",
    async (tier) => {
      const actor = createBddApi(context).user();
      if (!actor.orgId) {
        throw new Error("Expected a paid organization fixture");
      }
      mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
      const upload = pausedSeedUpload(actor.orgId);
      const api = clients();
      const pending = api.status.getStatus({ headers });
      joinPendingRequest(pending, () => {
        upload.release("success");
      });
      await upload.started;

      // Allow the real Stripe write and bootstrap publication to compete. The
      // purchase must remain authoritative whether it commits before or after
      // the bootstrap's earlier tier read; no database pause point is exposed.
      const purchase = createRunsApi(context).grantProEntitlement(actor, {
        tier,
      });
      const completed = Promise.all([accept(pending, [200]), purchase]);
      joinPendingRequest(completed, () => {
        upload.release("success");
      });
      upload.release("success");
      await completed;

      const agentId = await readDefaultId(api);
      const billing = await accept(api.billing.get({ headers }), [200]);
      expect(billing.body.tier).toBe(tier);
      const listed = await accept(api.agents.list({ headers }), [200]);
      expect(listed.body).toStrictEqual([
        expect.objectContaining({
          agentId,
          ownerId: actor.userId,
          isDefaultAgent: true,
          visibility: "public",
        }),
      ]);
      await expectInstructions(api, agentId, SEED_INSTRUCTIONS);
    },
  );

  it.each(["pro", "team"] as const)(
    "preserves a %s purchase during stalled bootstrap IO without a free grant",
    async (tier) => {
      const actor = createBddApi(context).user();
      if (!actor.orgId) {
        throw new Error("Expected a paid organization fixture");
      }
      mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
      const upload = pausedSeedUpload(actor.orgId);
      const api = clients();
      const pending = api.status.getStatus({ headers });
      joinPendingRequest(pending, () => {
        upload.release("success");
      });
      await upload.started;
      // The real Stripe invoice endpoint grants the tier, and its subsequent
      // onboarding request publishes the paid default before this upload ends.
      await createRunsApi(context).grantProEntitlement(actor, { tier });
      const agentId = await readDefaultId(api);
      const before = await accept(api.billing.get({ headers }), [200]);
      expect(before.body.tier).toBe(tier);
      expect(before.body.creditGrants).not.toContainEqual(
        expect.objectContaining({ source: "onboarding" }),
      );
      upload.release("success");
      const late = await accept(pending, [200]);
      expect(late.body.defaultAgentId).toBe(agentId);
      const after = await accept(api.billing.get({ headers }), [200]);
      expect(after.body.tier).toBe(tier);
      expect(after.body.credits).toBe(before.body.credits);
      expect(after.body.creditGrants).toStrictEqual(before.body.creditGrants);
      const listed = await accept(api.agents.list({ headers }), [200]);
      expect(listed.body).toStrictEqual([
        expect.objectContaining({
          agentId,
          ownerId: actor.userId,
          isDefaultAgent: true,
          visibility: "public",
        }),
      ]);
      await expectInstructions(api, agentId, SEED_INSTRUCTIONS);
    },
  );

  it("retains a failed candidate cleanup for retry without damaging the winner", async () => {
    const orgId = authenticateAdmin();
    const upload = pausedSeedUpload(orgId);
    const api = clients();
    const pending = api.status.getStatus({ headers });
    joinPendingRequest(pending, () => {
      upload.release("success");
    });
    const losingArchiveKey = await upload.started;
    const losingPrefix = losingArchiveKey.slice(
      0,
      losingArchiveKey.lastIndexOf("/"),
    );
    const agentId = await readDefaultId(api);
    const durableSend = context.mocks.s3.send.getMockImplementation();
    let failCleanup = true;
    context.mocks.s3.send.mockImplementation(async (command: unknown) => {
      if (
        failCleanup &&
        command instanceof DeleteObjectsCommand &&
        command.input.Delete?.Objects?.some((object) => {
          return object.Key?.startsWith(`${losingPrefix}/`);
        })
      ) {
        failCleanup = false;
        throw new Error("R2 cleanup unavailable");
      }
      return (await durableSend?.(command)) ?? {};
    });
    upload.release("failure");
    expect((await pending).status).toBe(200);
    expect(upload.storage.hasObject(losingArchiveKey)).toBeTruthy();
    await expectInstructions(api, agentId, SEED_INSTRUCTIONS);
    await retryOwnedCleanup(orgId);
    expect(upload.storage.hasObject(losingArchiveKey)).toBeFalsy();
    await expect(readDefaultId(api)).resolves.toBe(agentId);
    await expectInstructions(api, agentId, SEED_INSTRUCTIONS);
    await expectSingleOnboardingGrant(api);
  });

  it("does not adopt or erase a replacement generation when an older upload fails late", async () => {
    const orgId = authenticateAdmin();
    const upload = pausedSeedUpload(orgId);
    const api = clients();
    const pending = api.status.getStatus({ headers });
    joinPendingRequest(pending, () => {
      upload.release("success");
    });
    const losingArchiveKey = await upload.started;
    const firstAgentId = await readDefaultId(api);
    await deleteOrganization(orgId);
    const deleted = await accept(api.agents.list({ headers }), [200]);
    expect(deleted.body).toStrictEqual([]);

    // Recreate through the same lazy production bootstrap, not by replacing
    // database rows. Its canonical Storage has a new UUID/prefix.
    const replacementId = await readDefaultId(api);
    expect(replacementId).not.toBe(firstAgentId);
    const edited = "Replacement generation's edited instructions.";
    await accept(
      api.instructions.update({
        headers,
        params: { id: replacementId },
        body: { content: edited },
      }),
      [200],
    );
    const billingBeforeLateFailure = await accept(
      api.billing.get({ headers }),
      [200],
    );
    // Organization deletion removes the balance, not its grant idempotency
    // receipt. Recreating the same external org identity cannot earn it again.
    expect(billingBeforeLateFailure.body.credits).toBe(0);
    expect(billingBeforeLateFailure.body.creditGrants).toHaveLength(1);
    upload.release("failure");
    expect((await pending).status).toBe(200);
    expect(upload.storage.hasObject(losingArchiveKey)).toBeFalsy();
    await expect(readDefaultId(api)).resolves.toBe(replacementId);
    await expectInstructions(api, replacementId, edited);
    const billingAfterLateFailure = await accept(
      api.billing.get({ headers }),
      [200],
    );
    expect(billingAfterLateFailure.body.credits).toBe(0);
    expect(billingAfterLateFailure.body.creditGrants).toStrictEqual(
      billingBeforeLateFailure.body.creditGrants,
    );
  });
});
