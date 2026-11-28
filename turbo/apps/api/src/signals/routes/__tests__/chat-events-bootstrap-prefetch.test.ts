import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { manualHttpCustomConnectorCreateBody } from "./helpers/api-bdd-connectors";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { readExecutionContentBundle } from "./helpers/execution-content-bundle";
import { testContext } from "../../../__tests__/test-context";
import { createDeferredPromise } from "../../utils";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";
import { commitMemoryVersion } from "./helpers/memory";
import { installS3Fixture } from "./helpers/template-publish-fixture";

const context = testContext();
const {
  api,
  chat,
  connectors,
  entitledNativeChatActor,
  sendChatRun,
  runExecution,
  completeChatRunOk,
  cancelAndCompleteChatRun,
  cancelChatRun,
  waitForThreadMessages,
  requestSendEventWithBearer,
} = createChatEventsFixture(context);

async function deferAttachmentMetadata(actor: ApiTestUser, filename: string) {
  const storage = installS3Fixture(context);
  const contentType = "text/plain";
  const bytes = Buffer.from("Attachment contents");
  const upload = await chat.prepareUpload(actor, {
    filename,
    contentType,
    size: bytes.length,
  });
  if (!("uploadUrl" in upload)) {
    throw new Error("Expected a single-part upload");
  }
  // Leave the upload uncompleted so the Chat send verifies the object.
  storage.put(upload.uploadUrl, bytes, contentType);
  const key = storage.signedKey(upload.uploadUrl);
  if (!key) {
    throw new Error("Expected the signed attachment key");
  }
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  const originalSend = context.mocks.s3.send.getMockImplementation();
  if (!originalSend) {
    throw new Error("Expected the fixture's S3 implementation");
  }
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (
      command instanceof HeadObjectCommand &&
      command.input.Key === key &&
      !entered.settled()
    ) {
      entered.resolve(undefined);
      await release.promise;
    }
    return await originalSend(command);
  });
  return {
    part: {
      type: "file" as const,
      fileId: upload.id,
      filenameSnapshot: filename,
      contentType,
    },
    entered: entered.promise,
    release: () => {
      release.resolve(undefined);
    },
  };
}

describe("chat agent bootstrap prefetch", () => {
  it("mounts user memory published through the Sandbox API in matching and independent picks", async () => {
    const { actor } = await entitledNativeChatActor();
    const webhooks = createWebhookCallbackApi(context);
    const seed = await sendChatRun(actor, {
      prompt: "publish my memory",
    });
    const seedExecution = await runExecution(seed.runId);
    const initialMemory = seedExecution.execution.startupInputs.memory;
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
      seedExecution.sandboxHeaders,
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
      seedExecution.sandboxHeaders,
      [200],
    );
    await cancelChatRun(actor, seed.runId, seedExecution.sandboxHeaders);
    const first = await sendChatRun(actor, {
      prompt: "mount the published memory",
    });
    const firstExecution = await runExecution(first.runId);
    const memory = firstExecution.execution.startupInputs.memory;
    expect(memory).toMatchObject({
      storageId: initialMemory.storageId,
      versionId: prepared.body.versionId,
    });
    const eventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        threadId: first.threadId,
        clientEventId: eventId,
        prompt: "independent memory pick",
      },
      [201],
    );
    await cancelChatRun(actor, first.runId, firstExecution.sandboxHeaders);
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
    const nextExecution = await runExecution(promoted.runId);
    const nextMemory = nextExecution.execution.startupInputs.memory;
    expect(nextMemory).toMatchObject({
      storageId: initialMemory.storageId,
      versionId: prepared.body.versionId,
    });
    await cancelChatRun(actor, promoted.runId, nextExecution.sandboxHeaders);
  });
  it("preserves a non-default member model preference through prefetch and an independent pick", async () => {
    const { actor } = await entitledNativeChatActor();
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    await api.updateUserModelPreference(actor, "claude-sonnet-5-5");
    const first = await sendChatRun(actor, {
      prompt: "use my saved non-default model",
    });
    const firstExecution = await runExecution(first.runId);
    expect(firstExecution.execution.modelUsageProvider).toBe(
      "claude-sonnet-5-5",
    );
    const eventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        threadId: first.threadId,
        clientEventId: eventId,
        prompt: "independent pick keeps my selected model",
      },
      [201],
    );
    await cancelChatRun(actor, first.runId, firstExecution.sandboxHeaders);
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
    const nextExecution = await runExecution(promoted.runId);
    expect(nextExecution.execution.modelUsageProvider).toBe(
      "claude-sonnet-5-5",
    );
    await cancelChatRun(actor, promoted.runId, nextExecution.sandboxHeaders);
  });

  it("uses the captured Workflow for the sending pick and the newer version for an independent pick", async () => {
    const { actor } = await entitledNativeChatActor();
    const misc = createMiscRoutesApi(context);
    const attachment = await deferAttachmentMetadata(
      actor,
      "workflow-snapshot.txt",
    );
    const s3 = installWorkflowVolumeS3Fixture(context, new Map(), {
      bundlesOnly: true,
    });
    const workflow = await misc.createWorkflow(
      actor,
      `context-${randomUUID().slice(0, 8)}`,
      { content: "# Context storage\nKeep this published skill mounted." },
      [201],
    );
    if (workflow.status !== 201) {
      throw new Error("Expected workflow publication");
    }
    const sending = sendChatRun(actor, {
      prompt: "prefetched skill",
      userMessage: {
        version: 1,
        parts: [attachment.part, { type: "text", text: "prefetched skill" }],
      },
    });
    const [first] = await Promise.all([
      sending,
      (async () => {
        await attachment.entered;
        await flushWaitUntilForTest();
        await misc.updateWorkflow(
          actor,
          workflow.body.id,
          "# Context storage\nMount the newer Workflow on the next independent pick.",
          [200],
        );
      })().finally(attachment.release),
    ]);
    const firstExecution = await runExecution(first.runId);
    const firstMount =
      firstExecution.execution.startupInputs.contentBundles.skills.find(
        (mount) => {
          return mount.name === workflow.body.name;
        },
      );
    if (!firstMount) {
      throw new Error("Expected the prefetched Workflow bundle");
    }
    const firstDownload = readExecutionContentBundle(
      s3.objects,
      firstMount.bundle,
    );
    expect(firstDownload.get("SKILL.md")?.toString()).toContain(
      "Keep this published skill mounted.",
    );
    expect([...firstDownload.keys()]).toStrictEqual(["SKILL.md"]);
    const queuedId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        threadId: first.threadId,
        clientEventId: queuedId,
        prompt: "independent skill context",
      },
      [201],
    );
    await cancelChatRun(actor, first.runId, firstExecution.sandboxHeaders);
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
    const nextExecution = await runExecution(promoted.runId);
    const nextMount =
      nextExecution.execution.startupInputs.contentBundles.skills.find(
        (mount) => {
          return mount.name === firstMount.name;
        },
      );
    if (!nextMount) {
      throw new Error("Expected the independently selected Workflow bundle");
    }
    expect(nextMount.bundle.sha256).not.toBe(firstMount.bundle.sha256);
    expect(
      readExecutionContentBundle(s3.objects, nextMount.bundle)
        .get("SKILL.md")
        ?.toString(),
    ).toContain("Mount the newer Workflow on the next independent pick.");
    await cancelChatRun(actor, promoted.runId, nextExecution.sandboxHeaders);
  });

  it("loads the same read-only context when a later request drains queued input", async () => {
    const { actor } = await entitledNativeChatActor();
    const first = await sendChatRun(actor, {
      prompt: "context anchor",
    });
    const queuedId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        threadId: first.threadId,
        clientEventId: queuedId,
        prompt: "context without the enqueue request",
      },
      [201],
    );
    // Cancellation is a separate API request: its pick cannot receive the send's signals.
    await cancelAndCompleteChatRun(actor, first.runId);
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
      providerType: "claude-code-oauth-token",
    });
    const execution = await runExecution(promoted.runId);
    await cancelChatRun(actor, promoted.runId, execution.sandboxHeaders);
  });
  it("preserves the custom account through prefetch and a later independent pick", async () => {
    const { actor } = await entitledNativeChatActor();
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
      prompt: "prefetched custom account",
    });
    const firstExecution = await runExecution(first.runId);
    expect(firstExecution.execution.connectorRuntimeTargets).toContainEqual(
      target,
    );
    const queuedId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        threadId: first.threadId,
        clientEventId: queuedId,
        prompt: "custom account without the enqueue context",
      },
      [201],
    );
    // This separate API request cannot reuse the queued send's context signals.
    await cancelChatRun(actor, first.runId, firstExecution.sandboxHeaders);
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
    const nextExecution = await runExecution(next.runId);
    expect(nextExecution.execution.connectorRuntimeTargets).toContainEqual(
      target,
    );
    await cancelChatRun(actor, next.runId, nextExecution.sandboxHeaders);
  });

  it("keeps the captured model selection when the member preference changes during attachment resolution", async () => {
    const { actor } = await entitledNativeChatActor();
    const attachment = await deferAttachmentMetadata(
      actor,
      "model-snapshot.txt",
    );
    const sending = sendChatRun(actor, {
      model: "claude-fable-5-1",
      prompt: "use the captured model selection",
      userMessage: {
        version: 1,
        parts: [
          attachment.part,
          { type: "text", text: "use the captured model selection" },
        ],
      },
    });
    // Object lookup starts with the member settings already captured.
    const [sent] = await Promise.all([
      sending,
      attachment.entered.then(() => {
        return api
          .updateUserModelPreference(actor, null)
          .finally(attachment.release);
      }),
    ]);
    expect((await api.readRun(actor, sent.runId)).source).toMatchObject({
      model: "claude-fable-5-1",
      providerType: "claude-code-oauth-token",
      credentialScope: "member",
    });
    const execution = await runExecution(sent.runId);
    await cancelChatRun(actor, sent.runId, execution.sandboxHeaders);
  });

  it("continues the predecessor session with the Memory it published during follow-up preparation", async () => {
    const { actor } = await entitledNativeChatActor();
    const model = "claude-fable-5-1";
    const first = await sendChatRun(actor, {
      model,
      prompt: "Start a session",
    });
    const { execution, sandboxHeaders } = await runExecution(first.runId);
    const attachment = await deferAttachmentMetadata(actor, "follow-up.txt");
    const clientEventId = randomUUID();
    const prompt = "Continue this session with the attachment";
    const sending = chat.requestSendEvent(
      actor,
      {
        threadId: first.threadId,
        clientEventId,
        model,
        prompt,
        userMessage: {
          version: 1,
          parts: [attachment.part, { type: "text", text: prompt }],
        },
      },
      [201],
      {},
    );
    const sessionId = `bdd-cli-${first.runId}`;
    const [, memory] = await Promise.all([
      sending,
      (async () => {
        await attachment.entered;
        await flushWaitUntilForTest();
        const memory = await commitMemoryVersion(
          context,
          {
            runId: first.runId,
            sandboxHeaders,
            memory: execution.startupInputs.memory,
          },
          [
            {
              path: "MEMORY.md",
              content: "Written while preparing the follow-up",
            },
          ],
        );
        await completeChatRunOk(first.runId, sandboxHeaders, {
          cliAgentSessionId: sessionId,
        });
        return memory;
      })().finally(attachment.release),
    ]);
    await flushWaitUntilForTest();
    const { events } = await chat.listThreadEvents(actor, first.threadId);
    const successor = userMessages(events).find((message) => {
      return message.revokesEventId === clientEventId;
    });
    expect(successor).toMatchObject({
      eventType: "input.prompt",
      runId: expect.any(String),
    });
    if (!successor?.runId) {
      throw new Error("Expected the follow-up Run");
    }
    const next = await runExecution(successor.runId);
    expect(next.execution.sessionContinuation).toMatchObject({
      continueNative: true,
      expectedSourceRunId: first.runId,
    });
    expect(next.execution.startupInputs.memory).toMatchObject({
      storageId: memory.storageId,
      versionId: memory.versionId,
    });
    await cancelChatRun(actor, successor.runId, next.sandboxHeaders);
  });

  it.each(["web", "cli"] as const)(
    "preserves the queued input and claimable run through %s",
    async (entry) => {
      const { actor } = await entitledNativeChatActor();
      const clientEventId = randomUUID();
      const body = { prompt: "prepare my agent", clientEventId };
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
      expect(metadata.id).toBe(sent.body.threadId);
      const execution = await runExecution(associated.runId);
      expect(execution.execution.platformEnvironment).toHaveProperty(
        "OKOU_TOKEN",
      );
      await cancelChatRun(actor, associated.runId, execution.sandboxHeaders);
    },
  );

  it("uses the selected default account for each successive pick", async () => {
    const { actor } = await entitledNativeChatActor();
    const first = await connectors.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: `first-${randomUUID()}` },
    );
    const second = await connectors.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: `second-${randomUUID()}` },
    );
    await connectors.setDefaultBuiltinConnectorAccount(
      actor,
      "openai",
      first.id,
    );
    const sent = await sendChatRun(actor, {
      prompt: "use the first default",
    });
    const execution = await runExecution(sent.runId);
    expect(
      execution.execution.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({ sourceId: first.id });
    await cancelChatRun(actor, sent.runId, execution.sandboxHeaders);
    await connectors.setDefaultBuiltinConnectorAccount(
      actor,
      "openai",
      second.id,
    );
    const next = await sendChatRun(actor, {
      threadId: sent.threadId,
      prompt: "use the next default",
    });
    const nextExecution = await runExecution(next.runId);
    expect(
      nextExecution.execution.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({ sourceId: second.id });
    await cancelChatRun(actor, next.runId, nextExecution.sandboxHeaders);
  });

  it("delivers a steer input to the active authenticated Runner", async () => {
    const { actor, runnerGroup } = await entitledNativeChatActor();
    const active = await sendChatRun(actor, {
      prompt: "keep working",
    });
    const execution = await runExecution(active.runId);
    const clientEventId = randomUUID();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    await flushWaitUntilForTest();
    context.mocks.ably.channelGet.mockClear();
    context.mocks.ably.publish.mockClear();
    const sent = await chat.requestSendEvent(
      actor,
      {
        threadId: active.threadId,
        prompt: "steer the existing run",
        clientEventId,
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected the steer input to be accepted");
    }
    await flushWaitUntilForTest();
    // The running run holds the thread, so the send's pick cannot claim it and
    // the Runner is told about the pending input.
    expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
      `runner-group:${runnerGroup}`,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith("active-input", {
      runId: active.runId,
    });

    await expect(
      api.nextSteerableInput(execution.execution.sandboxToken, active.runId),
    ).resolves.toStrictEqual({
      input: { eventId: clientEventId, prompt: "steer the existing run" },
    });
    await cancelChatRun(actor, active.runId, execution.sandboxHeaders);
  });
});
