import { createHash, randomUUID } from "node:crypto";
import {
  CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  PI_MEMORY_ROOT,
} from "@okouai/api-contracts/contracts/runners";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import {
  barrierQueryText,
  barrierQueryBinds,
  withDatabaseTransactionBarrierFixture,
} from "../../../test-fixtures/database-transaction-barrier";
import type { ApiTestUser } from "./helpers/api-bdd";
import { expectCanonicalStorageManifest } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  commitMemoryVersion,
  seedReadyMemorySummaryProjection,
} from "./helpers/memory";
import {
  createChatEventsFixture,
  type PromptMessage,
  requireOrgId,
  createGptUsagePricingResolution,
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

// Completion-webhook carriers are claimed through the native Runner protocol
// before their launch snapshot is replaced. The fixture's default Sonnet
// policy is Pi-eligible, so select the Fable native route for those carriers.
async function entitledNativeCarrierActor(): Promise<
  Awaited<ReturnType<typeof entitledChatActor>>
> {
  const fixture = await entitledChatActor();
  await api.updateUserModelPreference(fixture.actor, "claude-fable-5-1");
  return fixture;
}

async function expectAgentTokenThreadOwnershipBoundaries(args: {
  readonly agentId: string;
  readonly orgId: string;
  readonly sourceToken: string;
}): Promise<void> {
  const crossUser = bdd.user({ orgId: args.orgId });
  const crossUserThread = await chat.createThread(crossUser, {
    agentId: args.agentId,
  });
  const crossUserSend = await requestSendEventWithBearer(
    args.sourceToken,
    {
      agentId: args.agentId,
      threadId: crossUserThread.id,
      prompt: "reject cross-user delegated memory admission",
    },
    [404],
  );
  expect(crossUserSend.status).toBe(404);

  const crossOrg = await entitledChatActor();
  const crossOrgThread = await chat.createThread(crossOrg.actor, {
    agentId: crossOrg.agentId,
  });
  const crossOrgSend = await requestSendEventWithBearer(
    args.sourceToken,
    {
      agentId: crossOrg.agentId,
      threadId: crossOrgThread.id,
      prompt: "reject cross-org delegated memory admission",
    },
    [404],
  );
  expect(crossOrgSend.status).toBe(404);

  const unownedThreadSend = await requestSendEventWithBearer(
    args.sourceToken,
    {
      agentId: args.agentId,
      threadId: randomUUID(),
      prompt: "reject unowned-thread delegated memory admission",
    },
    [404],
  );
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

describe("CHAT-02: model-first provider policies", () => {
  it("pins recall-enabled Pi memory across Sandbox turns of one session", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    const frozenSummary =
      "# Pi memory summary\n\nUse the exact pinned version for this session.";
    const initialMemory = await commitMemoryVersion(context, actor, [
      {
        path: "MEMORY.md",
        content: "Pi memory version pinned before the first completion.",
      },
      { path: "memory_summary.md", content: frozenSummary },
    ]);
    await seedReadyMemorySummaryProjection(
      context,
      actor,
      initialMemory,
      frozenSummary,
    );
    const usagePricingResolution = await createGptUsagePricingResolution();
    await configureSubscriptionPiModel(actor, {}, "gpt-6-luna");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiMemory]: true,
      },
    );
    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();

    const firstPrompt = "complete the first Pi turn in the Sandbox";
    const first = await sendChatRun(actor, {
      agentId,
      prompt: firstPrompt,
      model: "gpt-6-luna",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    // The first turn has no stored history, so the Sandbox starts fresh.
    expect(firstClaim.claim.resumeSession).toBeNull();
    expect(firstClaim.claim.piSessionId).toBe(first.threadId);
    expect(firstClaim.claim.piLaunchConfig).toMatchObject({
      memoryRecall: {
        status: "ready",
        memoryStorageId: initialMemory.storageId,
        storageVersionId: initialMemory.versionId,
        content: frozenSummary,
      },
    });
    await completeSandboxFirstPiRun({
      actor,
      answer: "Sandbox memory checkpoint",
      checkpointObjects,
      claim: firstClaim,
      prompt: firstPrompt,
      run: first,
      usagePricingResolution,
    });

    const newerMemory = await commitMemoryVersion(context, actor, [
      {
        path: "MEMORY.md",
        content: "A newer HEAD must not replace the session-pinned version.",
      },
    ]);
    expect(newerMemory.versionId).not.toBe(initialMemory.versionId);

    const second = await sendChatRun(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "resume with the pinned Pi memory mount",
        model: "gpt-6-luna",
      },
      usagePricingResolution,
    );
    const claimed = await claimChatRun(runnerGroup, second.runId);
    expect(claimed.claim.cliAgentType).toBe("pi");
    // The resumed turn references the stored history blob.
    expect(claimed.claim.resumeSession).toMatchObject({
      sessionId: first.threadId,
      historyRef: { kind: "blob" },
    });
    expect(claimed.claim.piLaunchConfig).toMatchObject({
      memoryRecall: {
        status: "ready",
        memoryStorageId: initialMemory.storageId,
        storageVersionId: initialMemory.versionId,
        content: frozenSummary,
        sourceHash: createHash("sha256").update(frozenSummary).digest("hex"),
        sourceSize: Buffer.byteLength(frozenSummary),
      },
    });
    expect(claimed.claim.appendSystemPrompt).not.toMatch(/auto.?memory/iu);
    const storageManifest = expectCanonicalStorageManifest(
      claimed.claim.storageManifest,
    );
    if (!storageManifest) {
      throw new Error("Expected recall-enabled Pi Storage mounts");
    }
    const memorySlotMounts = storageManifest.storageMounts.filter((mount) => {
      return mount.name === "memory" || mount.mountPath === PI_MEMORY_ROOT;
    });
    expect(memorySlotMounts).toHaveLength(1);
    expect(memorySlotMounts[0]).toMatchObject({
      name: "memory",
      versionId: initialMemory.versionId,
      mountPath: PI_MEMORY_ROOT,
      missingRootPolicy: "preserveParentVersion",
      writeback: true,
      archiveUrl: expect.any(String),
    });
    expect(memorySlotMounts[0]).not.toHaveProperty("generatedBy");
    expect(storageManifest.storageMounts).not.toContainEqual(
      expect.objectContaining({
        mountPath: CANONICAL_CODEX_MEMORY_MOUNT_PATH,
      }),
    );

    await cancelChatRun(actor, second.runId, claimed.sandboxHeaders);
  }, 90_000);

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

  it("keeps a frozen projection miss no-content after the projection becomes ready", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    const summary =
      "# Delayed summary\n\nOnly a new Pi session may capture this.";
    const memory = await commitMemoryVersion(context, actor, [
      { path: "memory_summary.md", content: summary },
    ]);
    await configureSubscriptionPiModel(actor, {}, "gpt-6-luna");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiMemory]: true,
      },
    );
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    const frozenMiss = await sendChatRun(actor, {
      agentId,
      prompt: "freeze the projection miss",
      model: "gpt-6-luna",
    });

    await seedReadyMemorySummaryProjection(context, actor, memory, summary);
    const frozenMissClaim = await claimChatRun(runnerGroup, frozenMiss.runId);
    expect(frozenMissClaim.claim.piLaunchConfig).toMatchObject({
      memoryRecall: {
        status: "no-content",
        memoryStorageId: memory.storageId,
        storageVersionId: memory.versionId,
      },
    });

    const newSession = await sendChatRun(actor, {
      agentId,
      prompt: "capture the now-ready projection in a new session",
      model: "gpt-6-luna",
    });
    const newSessionClaim = await claimChatRun(runnerGroup, newSession.runId);
    expect(newSessionClaim.claim.piLaunchConfig).toMatchObject({
      memoryRecall: {
        status: "ready",
        memoryStorageId: memory.storageId,
        storageVersionId: memory.versionId,
        content: summary,
      },
    });

    await Promise.all([
      cancelChatRun(actor, frozenMiss.runId, frozenMissClaim.sandboxHeaders),
      cancelChatRun(actor, newSession.runId, newSessionClaim.sandboxHeaders),
    ]);
  }, 90_000);

  it("injects no memory recall into a Pi launch while the owner's PiMemory is off", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    const summary =
      "# Gated summary\n\nOnly an owner with PiMemory on may see this.";
    const memory = await commitMemoryVersion(context, actor, [
      { path: "memory_summary.md", content: summary },
    ]);
    await seedReadyMemorySummaryProjection(context, actor, memory, summary);
    await configureSubscriptionPiModel(actor, {}, "gpt-6-luna");

    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    async function launchPiRun(prompt: string) {
      return await sendChatRun(actor, {
        agentId,
        prompt,
        model: "gpt-6-luna",
      });
    }

    // Off: the ready projection is never read, and the mount stays pinned.
    const gated = await launchPiRun("launch Pi with PiMemory off");
    const gatedClaim = await claimChatRun(runnerGroup, gated.runId);
    expect(gatedClaim.claim.piLaunchConfig).toMatchObject({
      memoryRecall: {
        status: "no-content",
        memoryStorageId: memory.storageId,
        storageVersionId: memory.versionId,
      },
    });
    expect(
      expectCanonicalStorageManifest(
        gatedClaim.claim.storageManifest,
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

    // On for this owner only: the same projection is recalled as before.
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.PiMemory]: true },
    );
    const enabled = await launchPiRun("launch Pi with PiMemory on");
    const enabledClaim = await claimChatRun(runnerGroup, enabled.runId);
    expect(enabledClaim.claim.piLaunchConfig).toMatchObject({
      memoryRecall: {
        status: "ready",
        memoryStorageId: memory.storageId,
        storageVersionId: memory.versionId,
        content: summary,
      },
    });

    await Promise.all([
      cancelChatRun(actor, gated.runId, gatedClaim.sandboxHeaders),
      cancelChatRun(actor, enabled.runId, enabledClaim.sandboxHeaders),
    ]);
  }, 90_000);
  it("uses captured memory flags for one launch and observes changes on the next request", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    const summary =
      "# Captured memory\n\nKeep this launch on its captured flags.";
    const memory = await commitMemoryVersion(context, actor, [
      { path: "memory_summary.md", content: summary },
    ]);
    await seedReadyMemorySummaryProjection(context, actor, memory, summary);
    await configureSubscriptionPiModel(actor, {}, "gpt-6-luna");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.PiMemory]: true },
    );
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    const captured = await withDatabaseTransactionBarrierFixture(
      {
        select: (queryArgs) => {
          return (
            barrierQueryText(queryArgs).includes(
              'from "user_feature_switches"',
            ) &&
            barrierQueryBinds(queryArgs, actor.userId) &&
            barrierQueryBinds(queryArgs, orgId)
          );
        },
        stopAt: (_queryArgs, selecting) => {
          return selecting;
        },
        pauseAfter: true,
        work: async (barrier) => {
          const sending = sendChatRun(actor, {
            agentId,
            model: "gpt-6-luna",
            prompt: "launch with captured flags",
          });
          await barrier.entered;
          await updateFeatureSwitchesForUser(
            context,
            { ...actor, orgId },
            { [FeatureSwitchKey.PiMemory]: false },
          );
          barrier.release();
          return await sending;
        },
      },
      context.signal,
    );
    const capturedClaim = await claimChatRun(runnerGroup, captured.runId);
    expect(capturedClaim.claim.piLaunchConfig).toMatchObject({
      memoryRecall: { status: "ready", content: summary },
    });
    await cancelChatRun(actor, captured.runId, capturedClaim.sandboxHeaders);
    const next = await sendChatRun(actor, {
      agentId,
      model: "gpt-6-luna",
      prompt: "next request sees disabled memory",
    });
    const nextClaim = await claimChatRun(runnerGroup, next.runId);
    expect(nextClaim.claim.piLaunchConfig).toMatchObject({
      memoryRecall: { status: "no-content", memoryStorageId: memory.storageId },
    });
    await cancelChatRun(actor, next.runId, nextClaim.sandboxHeaders);
  });

  it("preserves delegated Pi provenance and rejects foreign thread writes", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeCarrierActor();
    const orgId = requireOrgId(actor);
    await bdd.updateAgentMetadata(actor, agentId, { visibility: "public" });
    const source = await sendChatRun(actor, {
      agentId,
      prompt: "delegate a non-interactive Pi turn",
      model: "claude-fable-5-1",
    });
    const sourceClaim = await claimChatRun(runnerGroup, source.runId);
    const sourceToken = okouTokenFromClaim(sourceClaim.claim);
    const targetThread = await chat.createThread(actor, { agentId });

    const usagePricingResolution = await createGptUsagePricingResolution();

    await configureSubscriptionPiModel(actor, {}, "gpt-6-luna");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiMemory]: true,
      },
    );
    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();

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
      usagePricingResolution,
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
    await completeSandboxFirstPiRun({
      actor,
      answer: "delegated memory admission answer",
      checkpointObjects,
      claim: await claimChatRun(runnerGroup, delegatedRunId),
      prompt: delegatedPrompt,
      run: delegatedRun,
      usagePricingResolution,
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
      agentId,
      orgId,
      sourceToken,
    });

    await cancelChatRun(actor, source.runId, sourceClaim.sandboxHeaders);
  }, 90_000);
});
