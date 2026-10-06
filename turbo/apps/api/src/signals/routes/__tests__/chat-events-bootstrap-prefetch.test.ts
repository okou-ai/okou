import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { getCustomSkillStorageName } from "@okouai/core/storage-names";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { manualHttpCustomConnectorCreateBody } from "./helpers/api-bdd-connectors";
import { expectCanonicalStorageManifest } from "./helpers/api-bdd-runs";
import { testContext } from "../../../__tests__/test-context";
import { buildArtifactKeyV2 } from "../../../lib/file-url";
import { createDeferredPromise } from "../../utils";
import { withAgentBootstrapFailureFixture } from "../../../test-fixtures/agent-bootstrap-failure";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
} from "../../../test-fixtures/database-transaction-barrier";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  connectors,
  chatCallbacks,
  entitledNativeChatActor,
  sendChatRun,
  claimChatRun,
  cancelChatRun,
  waitForThreadMessages,
  requestSendEventWithBearer,
} = createChatEventsFixture(context);

describe("chat agent bootstrap prefetch", () => {
  it("mounts user memory published through the Sandbox API in matching and independent picks", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const webhooks = createWebhookCallbackApi(context);
    const seed = await sendChatRun(actor, {
      agentId,
      prompt: "publish my memory",
    });
    const seedClaim = await claimChatRun(runnerGroup, seed.runId);
    const initialMemory = expectCanonicalStorageManifest(
      seedClaim.claim.storageManifest,
    )?.storageMounts.find((mount) => {
      return mount.name === "memory";
    });
    if (!initialMemory) {
      throw new Error("Expected a writable memory root");
    }
    const file = storageTextFile("MEMORY.md", `owned memory ${randomUUID()}`);
    context.mocks.s3.send.mockResolvedValue({ ContentLength: 4096 });
    const prepared = await webhooks.requestAgentStoragePrepare(
      {
        runId: seed.runId,
        storageId: initialMemory.storageId,
        baseVersion: initialMemory.versionId,
        changes: { added: [file.path], modified: [], deleted: [] },
        files: [file],
      },
      seedClaim.sandboxHeaders,
      [200],
    );
    if (prepared.status !== 200) {
      throw new Error("Expected memory preparation");
    }
    await webhooks.requestAgentStorageCommit(
      {
        runId: seed.runId,
        storageId: initialMemory.storageId,
        versionId: prepared.body.versionId,
        files: [file],
      },
      seedClaim.sandboxHeaders,
      [200],
    );
    await cancelChatRun(actor, seed.runId, seedClaim.sandboxHeaders);
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "mount the published memory",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    const memory = expectCanonicalStorageManifest(
      firstClaim.claim.storageManifest,
    )?.storageMounts.find((mount) => {
      return mount.name === "memory";
    });
    expect(memory).toMatchObject({
      storageId: initialMemory.storageId,
      versionId: prepared.body.versionId,
    });
    const eventId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        clientEventId: eventId,
        prompt: "independent memory pick",
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });
    await cancelChatRun(actor, first.runId, firstClaim.sandboxHeaders);
    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === eventId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((message) => {
      return message.revokesEventId === eventId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected independent memory promotion");
    }
    const nextClaim = await claimChatRun(runnerGroup, promoted.runId);
    const nextMemory = expectCanonicalStorageManifest(
      nextClaim.claim.storageManifest,
    )?.storageMounts.find((mount) => {
      return mount.name === "memory";
    });
    expect(nextMemory).toMatchObject({
      storageId: initialMemory.storageId,
      versionId: prepared.body.versionId,
    });
    await cancelChatRun(actor, promoted.runId, nextClaim.sandboxHeaders);
  });
  it("preserves a non-default member model preference through prefetch and an independent pick", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const { providerId } = await api.ensureOrgModelProvider(actor, {
      model: "claude-fable-5-1",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        preferred: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "claude-sonnet-5",
        preferred: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    await api.updateUserModelPreference(actor, "claude-sonnet-5");
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "use my saved non-default model",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(firstClaim.claim.modelUsageProvider).toBe("claude-sonnet-5");
    const eventId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        clientEventId: eventId,
        prompt: "independent pick keeps my selected model",
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });
    await cancelChatRun(actor, first.runId, firstClaim.sandboxHeaders);
    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === eventId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((message) => {
      return message.revokesEventId === eventId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the independent queued pick");
    }
    const nextClaim = await claimChatRun(runnerGroup, promoted.runId);
    expect(nextClaim.claim.modelUsageProvider).toBe("claude-sonnet-5");
    await cancelChatRun(actor, promoted.runId, nextClaim.sandboxHeaders);
  });

  it("mounts the same exact workflow version from prefetch and a later independent pick", async () => {
    context.mocks.s3.getSignedUrl.mockImplementation(() => {
      const url = `https://storage.example.com/context/${randomUUID()}`;
      return Promise.resolve(url);
    });
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const workflow = await createMiscRoutesApi(context).createWorkflow(
      actor,
      agentId,
      `context-${randomUUID().slice(0, 8)}`,
      { content: "# Context storage\nKeep this published skill mounted." },
      [201],
    );
    if (workflow.status !== 201) {
      throw new Error("Expected workflow publication");
    }
    const name = getCustomSkillStorageName(workflow.body.id);
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "prefetched skill",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    const firstMount = expectCanonicalStorageManifest(
      firstClaim.claim.storageManifest,
    )?.storageMounts.find((mount) => {
      return mount.name === name;
    });
    expect(firstMount).toMatchObject({ name });
    expect(firstMount?.writeback).toBeUndefined();
    expect(firstMount?.mountPath).toStrictEqual(expect.any(String));
    expect(firstMount?.archiveUrl).toStrictEqual(expect.any(String));
    expect(firstMount?.versionId).toMatch(/^[0-9a-f]{64}$/);
    const queuedId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        clientEventId: queuedId,
        prompt: "independent skill context",
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });
    await cancelChatRun(actor, first.runId, firstClaim.sandboxHeaders);
    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected independently prepared queued run");
    }
    const nextClaim = await claimChatRun(runnerGroup, promoted.runId);
    const nextMount = expectCanonicalStorageManifest(
      nextClaim.claim.storageManifest,
    )?.storageMounts.find((mount) => {
      return mount.name === name;
    });
    expect(nextMount).toMatchObject({
      name,
      mountPath: firstMount?.mountPath,
      versionId: firstMount?.versionId,
      archiveUrl: firstMount?.archiveUrl,
    });
    expect(nextMount?.writeback).toBeUndefined();
    await cancelChatRun(actor, promoted.runId, nextClaim.sandboxHeaders);
  });
  it("does not substitute the newer send's payload or capture flag for an earlier queue head", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const olderId = randomUUID();
    const newerId = randomUUID();
    const launched = createDeferredPromise<string>(context.signal);
    let observedThreadId: string | undefined;
    context.mocks.ably.publish.mockImplementation(
      async (...args: unknown[]) => {
        if (
          args[0] === `chatThreadMessageCreated:${observedThreadId}` &&
          observedThreadId
        ) {
          // Observe the same post-commit notification and public GET used by
          // the client, without flushing the deliberately paused first pick.
          const page = await chat.listThreadEvents(actor, observedThreadId);
          const runId = userMessages(page.events).find((message) => {
            return message.revokesEventId === olderId;
          })?.runId;
          if (runId && !launched.settled()) {
            launched.resolve(runId);
          }
        }
        return undefined;
      },
    );
    const result = await withDatabaseTransactionBarrierFixture(
      {
        // Infrastructure exception: pause the real reader, without replacing
        // its result, so another API request can take an expired queue lease.
        select: (args) => {
          return barrierQueryText(args).includes('"picked_input_revoker"');
        },
        stopAt: (_args, selecting) => {
          return selecting;
        },
        work: async (barrier) => {
          const older = await chat.requestSendEvent(
            actor,
            {
              agentId,
              clientEventId: olderId,
              prompt: "older queue head",
              captureNetworkBodies: true,
            },
            [201],
          );
          if (older.status !== 201) {
            throw new Error("Expected the older input to be accepted");
          }
          observedThreadId = older.body.threadId;
          await barrier.entered;
          mockNow(now() + 11_000);
          onTestFinished(clearMockNow);
          const newer = await chat.requestSendEvent(
            actor,
            {
              agentId,
              threadId: older.body.threadId,
              clientEventId: newerId,
              prompt: "newer enqueue request",
            },
            [201],
          );
          if (newer.status !== 201) {
            throw new Error("Expected the newer input to be accepted");
          }
          expect(newer.body.threadId).toBe(older.body.threadId);
          const runId = await launched.promise;
          const messages = await chat.listThreadEvents(
            actor,
            older.body.threadId,
          );
          expect((await api.readRun(actor, runId)).prompt).toBe(
            "older queue head",
          );
          expect(userMessages(messages.events)).toContainEqual(
            expect.objectContaining({
              id: newerId,
              eventType: "input.prompt",
            }),
          );
          barrier.release();
          await expect(flushWaitUntilForTest()).rejects.toThrow(
            "Chat thread claim was lost before the pending commit",
          );
          return { threadId: older.body.threadId, runId };
        },
      },
      context.signal,
    );
    clearMockNow();
    const claimed = await claimChatRun(runnerGroup, result.runId);
    expect(claimed.claim.captureNetworkBodies).toBeTruthy();
    await cancelChatRun(actor, result.runId, claimed.sandboxHeaders);
    const messages = await waitForThreadMessages(
      actor,
      result.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === newerId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const next = userMessages(messages.events).find((message) => {
      return message.revokesEventId === newerId;
    });
    if (!next?.runId) {
      throw new Error("Expected the later request to drain the newer input");
    }
    expect((await api.readRun(actor, next.runId)).prompt).toBe(
      "newer enqueue request",
    );
    const nextClaim = await claimChatRun(runnerGroup, next.runId);
    expect(nextClaim.claim.captureNetworkBodies).toBeFalsy();
    await cancelChatRun(actor, next.runId, nextClaim.sandboxHeaders);
  }, 90_000);
  it("loads the same read-only context when a later request drains queued input", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "context anchor",
    });
    const queuedId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        clientEventId: queuedId,
        prompt: "context without the enqueue request",
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });
    // Cancellation is a separate API request: its pick cannot receive the send's signals.
    await cancelChatRun(actor, first.runId);
    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected a run from the local context factory");
    }
    expect((await api.readRun(actor, promoted.runId)).source).toMatchObject({
      model: "claude-fable-5-1",
      providerType: "anthropic-api-key",
    });
    const claimed = await claimChatRun(runnerGroup, promoted.runId);
    await cancelChatRun(actor, promoted.runId, claimed.sandboxHeaders);
  });
  it("preserves the custom account through prefetch and a later independent pick", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const connector = await connectors.createCustomConnector(
      actor,
      manualHttpCustomConnectorCreateBody({
        slug: `_context-custom-${randomUUID()}`,
        displayName: "Shared context custom connector",
        prefixTemplates: ["https://context-custom.example.test/v1/"],
      }),
    );
    await connectors.setCustomConnectorSecret(
      actor,
      connector.id,
      "synthetic-context-secret",
    );
    await connectors.updateAgentCustomConnectors(actor, agentId, [
      connector.id,
    ]);
    const [account] = await connectors.listCustomConnectorAccounts(
      actor,
      connector.id,
    );
    if (!account) {
      throw new Error("Expected the API-created custom account");
    }
    const target = {
      kind: "custom",
      customConnectorId: connector.id,
      sourceId: account.id,
      baseUrlVars: {},
    };
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "prefetched custom account",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(firstClaim.claim.connectorRuntimeTargets).toContainEqual(target);
    const queuedId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        clientEventId: queuedId,
        prompt: "custom account without the enqueue context",
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });
    // This separate API request cannot reuse the queued send's context signals.
    await cancelChatRun(actor, first.runId, firstClaim.sandboxHeaders);
    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const next = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedId;
    });
    if (!next?.runId) {
      throw new Error("Expected the independent custom-account pick");
    }
    const nextClaim = await claimChatRun(runnerGroup, next.runId);
    expect(nextClaim.claim.connectorRuntimeTargets).toContainEqual(target);
    await cancelChatRun(actor, next.runId, nextClaim.sandboxHeaders);
  });

  it("keeps the captured model policy when it changes during attachment resolution", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const fileId = randomUUID();
    const filename = "model-snapshot.txt";
    const key = buildArtifactKeyV2(fileId, filename);
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const originalSend = context.mocks.s3.send.getMockImplementation();
    if (!originalSend) {
      throw new Error("Expected the fixture's S3 implementation");
    }
    context.mocks.s3.send.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand && command.input.Key === key) {
        entered.resolve(undefined);
        await release.promise;
        return {
          ContentLength: 42,
          ContentType: "text/plain",
          LastModified: new Date("2026-10-02T00:00:00Z"),
          Metadata: {
            "artifact-id": fileId,
            filename: encodeURIComponent(filename),
            "user-id": encodeURIComponent(actor.userId),
          },
        };
      }
      return await originalSend(command);
    });
    const sending = sendChatRun(actor, {
      agentId,
      model: "claude-fable-5-1",
      prompt: "use the captured model policy",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: filename,
            contentType: "text/plain",
          },
          { type: "text", text: "use the captured model policy" },
        ],
      },
    });
    await entered.promise;
    // Attachment metadata is an external response awaited after model capture.
    // Change the real policy through its API before enqueue and admission.
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        preferred: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    release.resolve(undefined);
    const sent = await sending;
    expect((await api.readRun(actor, sent.runId)).source).toMatchObject({
      model: "claude-fable-5-1",
      providerType: "anthropic-api-key",
      credentialScope: "org",
    });
    const claimed = await claimChatRun(runnerGroup, sent.runId);
    await cancelChatRun(actor, sent.runId, claimed.sandboxHeaders);
  });
  it("returns the accepted input while bootstrap is still reading", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const clientEventId = randomUUID();
    const sent = await withDatabaseTransactionBarrierFixture(
      {
        select: (queryArgs) => {
          const text = barrierQueryText(queryArgs);
          return (
            text.includes('from "user_permission_grants"') &&
            barrierQueryBinds(queryArgs, actor.userId) &&
            barrierQueryBinds(queryArgs, orgId) &&
            barrierQueryBinds(queryArgs, agentId)
          );
        },
        stopAt: (_queryArgs, selecting) => {
          return selecting;
        },
        work: async (barrier) => {
          const sending = chat.requestSendEvent(
            actor,
            {
              agentId,
              prompt: "overlap bootstrap with enqueue",
              clientEventId,
            },
            [201],
          );
          await barrier.entered;
          const response = await sending;
          if (response.status !== 201) {
            throw new Error("Expected the direct send to be accepted");
          }
          expect(response.body.runId).toBeNull();
          const queued = await chat.listThreadEvents(
            actor,
            response.body.threadId,
          );
          expect(userMessages(queued.events)).toContainEqual(
            expect.objectContaining({
              id: clientEventId,
              eventType: "input.prompt",
            }),
          );
          expect(
            userMessages(queued.events).every((message) => {
              return message.runId === undefined;
            }),
          ).toBeTruthy();
          barrier.release();
          await flushWaitUntilForTest();
          return response;
        },
      },
      context.signal,
    );
    const messages = userMessages(
      (await chat.listThreadEvents(actor, sent.body.threadId)).events,
    );
    const runId = messages.find((message) => {
      return message.revokesEventId === clientEventId;
    })?.runId;
    if (!runId) {
      throw new Error(
        "Expected preparation to finish after releasing bootstrap",
      );
    }
    const claimed = await claimChatRun(runnerGroup, runId);
    await cancelChatRun(actor, runId, claimed.sandboxHeaders);
  });
  it.each(["web", "cli"] as const)(
    "preserves the queued input and claimable run through %s",
    async (entry) => {
      const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
      chatCallbacks.failIfChatCallbackRouteIsFetched();
      const clientEventId = randomUUID();
      const body = { agentId, prompt: "prepare my agent", clientEventId };
      const sent =
        entry === "web"
          ? await chat.requestSendEvent(actor, body, [201])
          : await requestSendEventWithBearer(
              (await api.createCliToken(actor)).token,
              body,
              [201],
            );
      if (sent.status !== 201) {
        throw new Error("Expected the direct send to be accepted");
      }
      expect(sent.body.runId).toBeNull();
      await flushWaitUntilForTest();
      const messages = userMessages(
        (await chat.listThreadEvents(actor, sent.body.threadId)).events,
      );
      const associated = messages.find((message) => {
        return message.revokesEventId === clientEventId;
      });
      expect(associated).toMatchObject({ eventType: "input.prompt" });
      if (!associated?.runId) {
        throw new Error("Expected a run-associated replacement");
      }
      const run = await api.readRun(actor, associated.runId);
      expect(run).toMatchObject({ prompt: "prepare my agent" });
      const metadata = await chat.readThreadMetadata(actor, sent.body.threadId);
      expect(metadata.agentId).toBe(agentId);
      const claimed = await claimChatRun(runnerGroup, associated.runId);
      expect(claimed.claim.platformEnvironment).toHaveProperty("OKOU_TOKEN");
      await cancelChatRun(actor, associated.runId, claimed.sandboxHeaders);
    },
  );

  it("keeps the captured default account for one pick and observes the next default on the next pick", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    const first = await connectors.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: `first-${randomUUID()}` },
      agentId,
    );
    const second = await connectors.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: `second-${randomUUID()}` },
      agentId,
    );
    await connectors.setDefaultBuiltinConnectorAccount(
      actor,
      "openai",
      first.id,
    );
    const clientEventId = randomUUID();
    const sent = await withDatabaseTransactionBarrierFixture(
      {
        select: (queryArgs) => {
          return (
            barrierQueryText(queryArgs).includes('"bootstrap_variables"') &&
            barrierQueryBinds(queryArgs, actor.userId) &&
            barrierQueryBinds(queryArgs, orgId)
          );
        },
        stopAt: (_queryArgs, selecting) => {
          return selecting;
        },
        pauseAfter: true,
        work: async (barrier) => {
          const sending = chat.requestSendEvent(
            actor,
            { agentId, prompt: "use the captured default", clientEventId },
            [201],
          );
          await barrier.entered;
          const response = await sending;
          if (response.status !== 201) {
            throw new Error("Expected enqueue to accept the input");
          }
          await connectors.setDefaultBuiltinConnectorAccount(
            actor,
            "openai",
            second.id,
          );
          barrier.release();
          await flushWaitUntilForTest();
          return response;
        },
      },
      context.signal,
    );
    const runId = userMessages(
      (await chat.listThreadEvents(actor, sent.body.threadId)).events,
    ).find((message) => {
      return message.revokesEventId === clientEventId;
    })?.runId;
    if (!runId) {
      throw new Error("Expected a run prepared from the captured account");
    }
    const claimed = await claimChatRun(runnerGroup, runId);
    expect(
      claimed.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({ sourceId: first.id });
    await cancelChatRun(actor, runId, claimed.sandboxHeaders);
    const next = await sendChatRun(actor, {
      agentId,
      threadId: sent.body.threadId,
      prompt: "use the next default",
    });
    const nextClaim = await claimChatRun(runnerGroup, next.runId);
    expect(
      nextClaim.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({ sourceId: second.id });
    await cancelChatRun(actor, next.runId, nextClaim.sandboxHeaders);
  });

  it("rejects the input when a matching prefetch fails instead of rereading", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const clientEventId = randomUUID();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    const sent = await withAgentBootstrapFailureFixture(
      { userId: actor.userId, orgId: actor.orgId, agentId },
      async () => {
        const response = await chat.requestSendEvent(
          actor,
          { agentId, prompt: "fail fast during preparation", clientEventId },
          [201],
        );
        if (response.status !== 201) {
          throw new Error("Expected enqueue to accept the input");
        }
        expect(response.body.runId).toBeNull();
        await expect(flushWaitUntilForTest()).rejects.toThrow("Failed query");
        return response;
      },
    );
    const events = (await chat.listThreadEvents(actor, sent.body.threadId))
      .events;
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        revokesEventId: clientEventId,
        error: "internal_error",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "output.error",
        error: "internal_error",
      }),
    );
    expect(
      userMessages(events).some((message) => {
        return (
          message.revokesEventId === clientEventId &&
          message.runId !== undefined
        );
      }),
    ).toBeFalsy();
  });

  it("keeps an active run steerable when its unused speculative read fails", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const active = await sendChatRun(actor, {
      agentId,
      prompt: "keep working",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const clientEventId = randomUUID();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    await withAgentBootstrapFailureFixture(
      { userId: actor.userId, orgId: actor.orgId, agentId },
      async () => {
        const sent = await chat.requestSendEvent(
          actor,
          {
            agentId,
            threadId: active.threadId,
            prompt: "steer the existing run",
            clientEventId,
          },
          [201],
        );
        if (sent.status !== 201) {
          throw new Error("Expected the steer input to be accepted");
        }
        expect(sent.body.runId).toBeNull();
        await flushWaitUntilForTest();
      },
    );
    await expect(
      api.nextSteerableInput(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({
      input: { eventId: clientEventId, prompt: "steer the existing run" },
    });
    await cancelChatRun(actor, active.runId, claimed.sandboxHeaders);
  });
});
