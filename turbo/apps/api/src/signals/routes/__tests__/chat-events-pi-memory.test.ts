import { publicChatActor } from "./helpers/public-chat-actor";
import { randomUUID } from "node:crypto";
import { PI_MEMORY_ROOT } from "@okouai/api-contracts/contracts/runners";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import type { ApiTestUser } from "./helpers/api-bdd";
import { expectCanonicalStorageManifest } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { commitMemoryVersion } from "./helpers/memory";
import {
  createChatEventsFixture,
  type PromptMessage,
  requireOrgId,
  okouTokenFromClaim,
  userMessages,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  bdd,
  api,
  chat,
  entitledChatActor,
  configureSubscriptionPiModel,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  cancelChatRun,
  requestSendEventWithBearer,
  mockPiCheckpointObjectStore,
  completeSandboxFirstPiRun,
  publishPendingPiInstructions,
  mockPiResourceArchiveDownloads,
} = createChatEventsFixture(context);

async function expectAgentTokenThreadOwnershipBoundaries(args: {
  readonly own: Awaited<ReturnType<typeof publicChatActor>>["run"];
  readonly agentId: string;
  readonly orgId: string;
  readonly sourceToken: string;
}): Promise<void> {
  const crossUser = bdd.user({ orgId: args.orgId });
  const crossUserThread = await args.own(() => {
    return chat.createThread(crossUser, { agentId: args.agentId });
  });
  const crossUserSend = await args.own(() => {
    return requestSendEventWithBearer(
      args.sourceToken,
      {
        agentId: args.agentId,
        threadId: crossUserThread.id,
        prompt: "reject cross-user delegated memory admission",
      },
      [404],
    );
  });
  expect(crossUserSend.status).toBe(404);

  const crossOrg = await publicChatActor(context);
  const crossOrgThread = await crossOrg.run(() => {
    return chat.createThread(crossOrg.actor, { agentId: crossOrg.agentId });
  });
  const crossOrgSend = await crossOrg.run(() => {
    return requestSendEventWithBearer(
      args.sourceToken,
      {
        agentId: crossOrg.agentId,
        threadId: crossOrgThread.id,
        prompt: "reject cross-org delegated memory admission",
      },
      [404],
    );
  });
  expect(crossOrgSend.status).toBe(404);

  const unownedThreadSend = await args.own(() => {
    return requestSendEventWithBearer(
      args.sourceToken,
      {
        agentId: args.agentId,
        threadId: randomUUID(),
        prompt: "reject unowned-thread delegated memory admission",
      },
      [404],
    );
  });
  expect(unownedThreadSend.status).toBe(404);
}

async function expectAgentChatProvenance(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly delegatedEventId: string;
  readonly delegatedRunId: string;
  readonly orgId: string;
  readonly source: { readonly runId: string; readonly threadId: string };
  readonly targetThreadId: string;
}): Promise<void> {
  const delegatedMessages = await waitForThreadMessages(
    args.actor,
    args.targetThreadId,
    (events) => {
      return userMessages(events).some((event) => {
        return event.id === args.delegatedEventId;
      });
    },
  );
  const delegatedInput = userMessages(delegatedMessages.events).find(
    (event): event is PromptMessage => {
      return (
        event.eventType === "input.prompt" && event.id === args.delegatedEventId
      );
    },
  );
  expect(delegatedInput?.userMessage.parts).toContainEqual({
    type: "source",
    kind: "agent",
    runId: args.source.runId,
    threadId: args.source.threadId,
    agentId: args.agentId,
    titleSnapshot: "New thread",
    href: `/chats/${args.source.threadId}#run-${args.source.runId}`,
  });
}

describe("CHAT-02: model-first routing", () => {
  it("refreshes user memory from another Thread while resuming native Pi history", async () => {
    const {
      run: own,
      actor,
      agentId,
      runnerGroup,
      claimChatRun,
      sendChatRun,
    } = await publicChatActor(context);
    const orgId = requireOrgId(actor);
    await own(async () => {
      return await configureSubscriptionPiModel(actor, {}, "gpt-6-luna");
    });
    await own(async () => {
      return await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.PiMemory]: true },
      );
    });
    mockPiResourceArchiveDownloads();
    const historyObjects = mockPiCheckpointObjectStore();

    const firstPrompt = "complete the first Pi turn in the Sandbox";
    const first = await sendChatRun(actor, {
      agentId,
      prompt: firstPrompt,
      model: "gpt-6-luna",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(firstClaim.claim.resumeSession).toBeNull();
    const initialMemory = expectCanonicalStorageManifest(
      firstClaim.claim.storageManifest,
    )?.storageMounts.find((mount) => {
      return mount.name === "memory" && mount.mountPath === PI_MEMORY_ROOT;
    });
    if (!initialMemory) {
      throw new Error("Expected user memory in the first Pi Run");
    }
    await own(async () => {
      return await completeSandboxFirstPiRun({
        actor,
        answer: "First Pi turn completed",
        historyObjects,
        claim: firstClaim,
        prompt: firstPrompt,
        run: first,
      });
    });

    const publisher = await sendChatRun(actor, {
      agentId,
      prompt: "update shared user memory from a different Thread",
      model: "gpt-6-luna",
    });
    const publisherClaim = await claimChatRun(runnerGroup, publisher.runId);
    const content = "Use the latest user memory on the next Run.";
    const committed = await own(async () => {
      return await commitMemoryVersion(
        context,
        {
          runId: publisher.runId,
          sandboxHeaders: publisherClaim.sandboxHeaders,
          storageManifest: publisherClaim.claim.storageManifest,
        },
        [{ path: "MEMORY.md", content }],
      );
    });
    await own(async () => {
      return await cancelChatRun(
        actor,
        publisher.runId,
        publisherClaim.sandboxHeaders,
      );
    });

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue with current user memory",
      model: "gpt-6-luna",
    });
    const claimed = await claimChatRun(runnerGroup, second.runId);
    expect(claimed.claim.resumeSession).toMatchObject({
      sessionId: first.threadId,
      historyRef: { kind: "blob" },
    });
    const mounts = expectCanonicalStorageManifest(
      claimed.claim.storageManifest,
    )?.storageMounts.filter((mount) => {
      return mount.name === "memory" || mount.mountPath === PI_MEMORY_ROOT;
    });
    expect(mounts).toHaveLength(1);
    expect(mounts?.[0]).toMatchObject({
      storageId: initialMemory.storageId,
      versionId: committed.versionId,
      mountPath: PI_MEMORY_ROOT,
      writeback: true,
    });
    expect(committed.versionId).not.toBe(initialMemory.versionId);
    expect(claimed.claim.piLaunchConfig?.memoryRecall).toMatchObject({
      storageVersionId: committed.versionId,
      status: "no-content",
    });
    await own(async () => {
      return await cancelChatRun(actor, second.runId, claimed.sandboxHeaders);
    });
  });

  it("keeps an empty recall-enabled Pi memory mount valid", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await publishPendingPiInstructions(actor, agentId);
    const orgId = requireOrgId(actor);
    await configureSubscriptionPiModel(actor, {}, "gpt-6-luna");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiMemory]: true,
      },
    );
    mockPiResourceArchiveDownloads(true);
    mockPiCheckpointObjectStore();
    await api.heartbeatRunner(runnerGroup);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "launch Pi with an absent memory Storage",
      model: "gpt-6-luna",
    });
    const claimed = await claimChatRun(runnerGroup, run.runId);
    const storageManifest = expectCanonicalStorageManifest(
      claimed.claim.storageManifest,
    );
    if (!storageManifest) {
      throw new Error("Expected empty recall-enabled Pi Storage mounts");
    }
    const memorySlotMounts = storageManifest.storageMounts.filter((mount) => {
      return mount.name === "memory" || mount.mountPath === PI_MEMORY_ROOT;
    });
    expect(memorySlotMounts).toHaveLength(1);
    expect(memorySlotMounts[0]).toMatchObject({
      name: "memory",
      versionId: expect.any(String),
      mountPath: PI_MEMORY_ROOT,
      missingRootPolicy: "preserveParentVersion",
      writeback: true,
      empty: true,
    });
    expect(claimed.claim.piLaunchConfig).toMatchObject({
      memoryRecall: {
        status: "no-content",
        memoryStorageId: memorySlotMounts[0]?.storageId,
        storageVersionId: memorySlotMounts[0]?.versionId,
      },
    });
    expect(memorySlotMounts[0]).not.toHaveProperty("archiveUrl");
    expect(memorySlotMounts[0]).not.toHaveProperty("generatedBy");

    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
  }, 90_000);

  it("continues native history with memory published by the preceding Run", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    await configureSubscriptionPiModel(actor, {}, "gpt-6-luna");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiMemory]: true,
      },
    );
    mockPiResourceArchiveDownloads();
    const historyObjects = mockPiCheckpointObjectStore();
    const prompt = "publish memory while preserving this Run's recall snapshot";
    const first = await sendChatRun(actor, {
      agentId,
      prompt,
      model: "gpt-6-luna",
    });
    const claimed = await claimChatRun(runnerGroup, first.runId);
    const initialRecall = claimed.claim.piLaunchConfig?.memoryRecall;
    expect(initialRecall).toMatchObject({ status: "no-content" });
    const memory = await commitMemoryVersion(
      context,
      {
        runId: first.runId,
        sandboxHeaders: claimed.sandboxHeaders,
        storageManifest: claimed.claim.storageManifest,
      },
      [{ path: "memory_summary.md", content: "# Published by the actual Run" }],
    );
    expect(memory.versionId).not.toBe(initialRecall?.storageVersionId);
    await completeSandboxFirstPiRun({
      actor,
      answer: "First Pi turn published memory",
      historyObjects,
      claim: claimed,
      prompt,
      run: first,
    });
    const continuation = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue with the newly published memory version",
      model: "gpt-6-luna",
    });
    const next = await claimChatRun(runnerGroup, continuation.runId);
    expect(next.claim.resumeSession).toMatchObject({
      sessionId: first.threadId,
      historyRef: { kind: "blob" },
    });
    expect(next.claim.piLaunchConfig?.memoryRecall).toMatchObject({
      status: "no-content",
      memoryStorageId: memory.storageId,
      storageVersionId: memory.versionId,
    });
    const mount = expectCanonicalStorageManifest(
      next.claim.storageManifest,
    )?.storageMounts.find((item) => {
      return item.name === "memory";
    });
    expect(mount).toMatchObject({
      storageId: memory.storageId,
      versionId: memory.versionId,
      writeback: true,
    });
    await cancelChatRun(actor, continuation.runId, next.sandboxHeaders);
  }, 90_000);

  it("keeps memory writeback and the current mount available while PiMemory is off", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    await configureSubscriptionPiModel(actor, {}, "gpt-6-luna");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.PiMemory]: false },
    );
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    const publisher = await sendChatRun(actor, {
      agentId,
      prompt: "write owned memory without recall",
      model: "gpt-6-luna",
    });
    const publisherClaim = await claimChatRun(runnerGroup, publisher.runId);
    const memory = await commitMemoryVersion(
      context,
      {
        runId: publisher.runId,
        sandboxHeaders: publisherClaim.sandboxHeaders,
        storageManifest: publisherClaim.claim.storageManifest,
      },
      [
        {
          path: "memory_summary.md",
          content: "# User-owned memory with recall disabled",
        },
      ],
    );
    await cancelChatRun(actor, publisher.runId, publisherClaim.sandboxHeaders);
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "mount the current user memory",
      model: "gpt-6-luna",
    });
    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(claimed.claim.piLaunchConfig?.memoryRecall).toMatchObject({
      status: "no-content",
      memoryStorageId: memory.storageId,
      storageVersionId: memory.versionId,
    });
    expect(
      expectCanonicalStorageManifest(
        claimed.claim.storageManifest,
      )?.storageMounts.filter((mount) => {
        return mount.name === "memory" || mount.mountPath === PI_MEMORY_ROOT;
      }),
    ).toStrictEqual([
      expect.objectContaining({
        name: "memory",
        storageId: memory.storageId,
        versionId: memory.versionId,
        mountPath: PI_MEMORY_ROOT,
        writeback: true,
        archiveUrl: expect.any(String),
      }),
    ]);
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
  }, 90_000);

  it("preserves delegated Pi provenance and rejects foreign thread writes", async () => {
    const {
      run: own,
      actor,
      agentId,
      runnerGroup,
      claimChatRun,
      sendChatRun,
      requestSendEventWithBearer,
    } = await publicChatActor(context);
    await own(async () => {
      return await api.updateUserModelPreference(actor, "claude-fable-5-1");
    });
    const orgId = requireOrgId(actor);
    await own(async () => {
      return await bdd.updateAgentMetadata(actor, agentId, {
        visibility: "public",
      });
    });
    const source = await sendChatRun(actor, {
      agentId,
      prompt: "delegate a non-interactive Pi turn",
      model: "claude-fable-5-1",
    });
    const sourceClaim = await claimChatRun(runnerGroup, source.runId);
    const sourceToken = okouTokenFromClaim(sourceClaim.claim);
    const targetThread = await own(async () => {
      return await chat.createThread(actor, { agentId });
    });

    await own(async () => {
      return await configureSubscriptionPiModel(actor, {}, "gpt-6-luna");
    });
    await own(async () => {
      return await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.PiMemory]: true,
        },
      );
    });
    mockPiResourceArchiveDownloads();
    const historyObjects = mockPiCheckpointObjectStore();

    const delegatedEventId = randomUUID();
    const delegatedPrompt = "learn this stable preference from delegated work";
    const delegated = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: delegatedEventId,
        threadId: targetThread.id,
        prompt: delegatedPrompt,
        model: "gpt-6-luna",
      },
      [201],
    );
    expect(delegated.status).toBe(201);
    if (delegated.status !== 201) {
      throw new Error("Expected the delegated Pi prompt to be accepted");
    }
    expect(delegated.body).toStrictEqual({
      runId: null,
      threadId: targetThread.id,
      createdAt: expect.any(String),
    });
    // The background pick launches the delegated input on its thread.
    const delegatedMessages = await waitForThreadMessages(
      actor,
      targetThread.id,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === delegatedEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    const delegatedRunId = userMessages(delegatedMessages.events).find(
      (message) => {
        return message.revokesEventId === delegatedEventId;
      },
    )?.runId;
    if (delegatedRunId === undefined) {
      throw new Error("Expected the delegated Pi prompt to launch a run");
    }
    const delegatedRun = { runId: delegatedRunId, threadId: targetThread.id };
    await own(async () => {
      return await completeSandboxFirstPiRun({
        actor,
        answer: "delegated memory admission answer",
        historyObjects,
        claim: await claimChatRun(runnerGroup, delegatedRunId),
        prompt: delegatedPrompt,
        run: delegatedRun,
      });
    });
    await expectAgentChatProvenance({
      actor,
      agentId,
      delegatedEventId,
      delegatedRunId,
      orgId,
      source,
      targetThreadId: targetThread.id,
    });
    await expectAgentTokenThreadOwnershipBoundaries({
      own,
      agentId,
      orgId,
      sourceToken,
    });

    await own(async () => {
      return await cancelChatRun(
        actor,
        source.runId,
        sourceClaim.sandboxHeaders,
      );
    });
  }, 90_000);
});
