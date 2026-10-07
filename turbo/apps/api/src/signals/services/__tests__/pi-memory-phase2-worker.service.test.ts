import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { storageTextFile } from "../../routes/__tests__/helpers/api-bdd-storage-files";
import { observePublicUsage } from "../../routes/__tests__/helpers/public-usage-observation";
import { postUsageAllowanceInvoicePaid } from "../../routes/__tests__/helpers/stripe-billing-webhook";
import {
  createFirewallApi,
  secretTemplate,
} from "../../routes/__tests__/helpers/api-bdd-firewall";
import {
  memoryArchive,
  createPublicRunnerMemory,
} from "../../routes/__tests__/helpers/public-runner-memory";
import { createPublicPiMemorySource } from "../../routes/__tests__/helpers/public-pi-memory-source";
import { createRunReadsApi } from "../../routes/__tests__/helpers/api-bdd-run-reads";
import { readPiMemoryBuiltinQuota } from "../pi-memory-builtin-quota.service";
import { captureFixtureRunBilling } from "../billing-run-fixture";
import { checkPiMemoryQuota } from "../pi-memory-quota.service";
import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
} from "@okouai/db/schema/org-usage-allowance";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  builtinMemoryQuotaCases,
  seedMemoryQuotaCase,
} from "../../../test-fixtures/pi-memory-builtin-quota";
import { nativeMemoryQuotaCases } from "../../../test-fixtures/pi-memory-quota";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { randomUUID } from "node:crypto";
import { PI_MEMORY_ROOT } from "@okouai/api-contracts/contracts/runners";
import { computeContentHashFromHashes } from "@okouai/api-contracts/contracts/storage-content-hash";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { checkpoints } from "@okouai/db/schema/checkpoint";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storageVersionLineage } from "@okouai/db/schema/storage-version-lineage";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { conversations } from "@okouai/db/schema/agent-run-session-conversation";
import { createStore } from "ccstate";
import { createDeferredPromise } from "../../utils";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it, onTestFinished } from "vitest";
import { apiTestS3PresignedUrl } from "../../../__tests__/mocks";
import { testContext } from "../../../__tests__/test-context";
import { db } from "../../../lib/db";
import { withMockNowForTest, now, nowDate } from "../../../lib/time";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "../../routes/__tests__/helpers/feature-switches";
import { seedBuiltInModelKey } from "../../routes/__tests__/helpers/runtime-state";
import {
  configureNativeCliArtifact,
  createChatEventsFixture,
} from "../../routes/__tests__/helpers/chat-events-fixture";
import {
  failPiMemoryPhase2Job,
  PI_MEMORY_PHASE2_RETRY_DELAY_MS,
} from "../pi-memory-phase2-job.service";
import { handlePiMemoryPhase2MaintenanceCallback } from "../pi-memory-phase2-maintenance.service";
import { createPiMemoryPhase2Worker } from "../pi-memory-phase2-worker.service";
import { deleteStoragesWithPiMemoryCandidates } from "../pi-memory-stage1-candidate.service";
import { mockStripeClient } from "../../external/stripe-client";
import { prepareStorageUploadForAuth$ } from "../storage-write.service";
import {
  createPhase2TestScope,
  insertPendingPhase2Job,
  insertPhase2CandidatesWithSources as insertPhase2Candidates,
  insertPhase2StorageVersion,
  readPhase2Job,
  setPhase2StorageHead,
  type Phase2SourceBinding,
} from "./pi-memory-phase2-job.test-fixture";
import {
  createPhase2CodexProvider,
  disconnectPhase2Codex,
  activateAnotherPhase2Codex,
  preparePhase2CodexActivation,
} from "../../../test-fixtures/pi-memory-phase2-credential";

import { createChatFilesBddApi } from "../../routes/__tests__/helpers/api-bdd-chat-files";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "../../routes/__tests__/helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "../../routes/__tests__/helpers/api-bdd-webhooks";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "../../routes/__tests__/helpers/api-bdd";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import {
  makeCodexJwt,
  makeCodexAuthJson,
} from "../../routes/__tests__/helpers/api-bdd-auth-device";
import {
  executePhase2Runtime,
  claimPhase2Execution,
} from "../../../test-fixtures/__tests__/pi-memory-phase2-runtime";
import { createFixtureOperationOwner } from "../../routes/__tests__/helpers/fixture-operation-owner";

const publicScopeContext = testContext();

async function cleanupPublicEmptyMemory(owner: {
  readonly orgId: string;
  readonly userId: string;
  readonly memoryStorageId: string | undefined;
}): Promise<void> {
  // Teardown only: setup can fail before the runner exposes the owned mount.
  const memories = await db()
    .select({ id: storages.id })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, owner.orgId),
        eq(storages.userId, owner.userId),
        eq(storages.name, MEMORY_ARTIFACT_NAME),
        owner.memoryStorageId
          ? eq(storages.id, owner.memoryStorageId)
          : undefined,
      ),
    );
  const storageIds = memories.map((memory) => {
    return memory.id;
  });
  if (storageIds.length === 0) {
    return;
  }
  await db().transaction(async (tx) => {
    await tx
      .update(storages)
      .set({ headVersionId: null })
      .where(inArray(storages.id, storageIds));
    await deleteStoragesWithPiMemoryCandidates(
      tx,
      inArray(storages.id, storageIds),
    );
  });
}

async function createPublicEmptyPhase2Scope() {
  const context = publicScopeContext;
  const chat = createChatEventsFixture(context);
  const actor = chat.bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected an owned Phase 2 organization");
  }
  const orgId = actor.orgId;
  const storageBucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const kmsKeyId = env("SECRETS_KMS_KEY_ID");
  let agentId: string | undefined;
  let runId: string | undefined;
  let sandboxToken: string | undefined;
  let memoryStorageId: string | undefined;
  const owner = createFixtureOperationOwner(async () => {
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", storageBucket);
    mockEnv("SECRETS_KMS_KEY_ID", kmsKeyId);
    context.mocks.s3.send.mockResolvedValue({
      Contents: [],
      IsTruncated: false,
    });
    context.mocks.ably.publish.mockResolvedValue(undefined);
    chat.api.acceptStorageDownloads();
    chat.api.acceptTelemetryIngest();
    if (runId) {
      const current = await chat.api.readRun(actor, runId);
      if (current.status === "pending" || current.status === "running") {
        await chat.api.requestCancelRun(actor, runId, [200]);
      }
      if (
        sandboxToken &&
        ["pending", "running", "cancelled"].includes(current.status)
      ) {
        await chat.webhooks.requestAgentComplete(
          {
            runId,
            exitCode: 1,
            error: "Owned empty-memory carrier cancelled",
          },
          { authorization: `Bearer ${sandboxToken}` },
          [200],
        );
      }
    }
    await flushWaitUntilForTest();
    if (agentId) {
      await chat.bdd.deleteAgent(actor, agentId);
      await flushWaitUntilForTest();
    }
    await cleanupPublicEmptyMemory({
      orgId,
      userId: actor.userId,
      memoryStorageId,
    });
    await deleteFeatureSwitchesForUser(context, {
      orgId,
      userId: actor.userId,
    });
  });

  const scope = await owner.run(async () => {
    chat.chatCallbacks.acceptChatObjectStorage();
    chat.api.acceptStorageDownloads();
    chat.api.acceptTelemetryIngest();
    chat.chatCallbacks.disableVapid();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    const runnerGroup = chat.api.configureRunnerGroup();
    await chat.api.grantProEntitlement(actor);
    await chat.api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    const agent = await chat.bdd.createAgent(actor, {
      displayName: "Empty Memory carrier",
      description: "Exposes the initialized Memory through a native claim.",
      visibility: "private",
    });
    agentId = agent.agentId;
    const run = await chat.chat.sendAndLaunch(actor, {
      agentId,
      prompt: "Keep the initialized Memory empty.",
    });
    runId = run.runId;
    const claimed = await chat.claimChatRun(runnerGroup, runId);
    sandboxToken = claimed.claim.sandboxToken;
    expect(claimed.claim.cliAgentType).not.toBe("pi");
    const manifest = expectCanonicalStorageManifest(
      claimed.claim.storageManifest,
    );
    const memory = manifest?.storageMounts.find((mount) => {
      return mount.name === MEMORY_ARTIFACT_NAME;
    });
    if (!memory) {
      throw new Error("Expected the carrier's real Memory mount");
    }
    memoryStorageId = memory.storageId;
    expect(memory).toMatchObject({ empty: true, writeback: true });
    expect(memory.versionId).not.toBe("");
    return { memoryStorageId, orgId, userId: actor.userId };
  });
  return { scope, run: owner.run };
}

async function deleteRunSessionsForScope(scope: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  const sessions = await db()
    .select({ id: agentRuns.sessionId })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.triggerSource, "agent"),
        eq(agentRuns.orgId, scope.orgId),
        eq(agentRuns.userId, scope.userId),
      ),
    );
  if (sessions.length > 0) {
    await db()
      .delete(agentSessions)
      .where(
        inArray(
          agentSessions.id,
          sessions.map((session) => {
            return session.id;
          }),
        ),
      );
  }
}

async function enablePiMemoryForScope(scope: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  const actor = { orgId: scope.orgId, userId: scope.userId };
  await updateFeatureSwitchesForUser(publicScopeContext, actor, {
    [FeatureSwitchKey.PiMemory]: true,
  });
  onTestFinished(async () => {
    await deleteFeatureSwitchesForUser(publicScopeContext, actor);
  });
}

describe("Pi memory Phase 2 sandbox dispatcher", () => {
  it("releases a switch-off job with pi_memory_disabled and dispatches nothing", async () => {
    const fixture = createPublicPiMemorySource(publicScopeContext);
    await fixture.run(async () => {
      const job = await createPublicPhase2WorkerFixture(
        fixture,
        new Date(now() + 24 * 3_600_000),
        "candidate waits while the owner has PiMemory off",
      );

      await updateFeatureSwitchesForUser(publicScopeContext, job.scope, {
        [FeatureSwitchKey.PiMemory]: false,
      });
      await expect(job.work()).resolves.toStrictEqual({
        outcome: "failed",
        errorClass: "pi_memory_disabled",
      });
      await expect(publicMaintenanceRuns(fixture)).resolves.toStrictEqual([]);
      await updateFeatureSwitchesForUser(publicScopeContext, job.scope, {
        [FeatureSwitchKey.PiMemory]: true,
      });
      const retried = await job.work(
        new Date(job.at.getTime() + PI_MEMORY_PHASE2_RETRY_DELAY_MS + 1),
      );
      expect(retried.outcome).toBe("dispatched");
      if (retried.outcome !== "dispatched") {
        throw new Error("Expected retry dispatch");
      }
      const execution = await claimPhase2Execution(
        publicScopeContext,
        retried.runId,
      );
      fixture.registerClaim(retried.runId, execution.sandboxToken);
      expect(execution.piLaunchConfig?.maintenance?.selected).toStrictEqual([
        expect.objectContaining({
          rawMemory: "candidate waits while the owner has PiMemory off",
        }),
      ]);
    });
  });

  it("launches maintenance while the organization is at its run limit", async () => {
    const fixture = createPublicPiMemorySource(publicScopeContext);
    await fixture.run(async () => {
      const job = await createPublicPhase2WorkerFixture(
        fixture,
        new Date(now() + 24 * 3_600_000),
        "maintenance does not wait for chat capacity",
      );

      mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      const chat = createChatEventsFixture(publicScopeContext);
      const blocker = await chat.sendChatRun(fixture.actor, {
        agentId: job.scope.sourceAgentId,
        prompt: "Hold the organization's only slot.",
        model: "gpt-6-luna",
      });
      fixture.registerRun(blocker.runId);
      const result = await job.work();
      expect(result.outcome).toBe("dispatched");
      if (result.outcome !== "dispatched") {
        throw new Error("Expected maintenance run dispatch at capacity");
      }
      const dispatched = await chat.api.readRun(fixture.actor, result.runId);
      expect(dispatched).toMatchObject({ status: "pending" });
      expect(dispatched).not.toHaveProperty("error");
      await chat.cancelChatRun(fixture.actor, blocker.runId);
      const waitingThread = await chat.chat.createThread(fixture.actor, {
        agentId: job.scope.sourceAgentId,
      });
      fixture.registerQueuedThread(waitingThread.id);
      await chat.sendWaitingChatInput(fixture.actor, {
        agentId: job.scope.sourceAgentId,
        threadId: waitingThread.id,
        prompt: "Wait behind the maintenance run.",
      });
    });
  });

  it("does not claim when no control job is ready", async () => {
    const fixture = await createPublicEmptyPhase2Scope();
    const store = createStore();
    // The exact scoped worker is the key 10 isolation exception. Ordinary
    // empty Memory and its HEAD come from onboarding and this real claim.
    const result = await fixture.run(async () => {
      return await store.set(
        createPiMemoryPhase2Worker(fixture.scope).execute$,
        new Date("2026-09-05T02:00:00.000Z"),
        publicScopeContext.signal,
      );
    });

    expect(result).toStrictEqual({ outcome: "no_work" });
  });

  it("recovers an expired bound lease whose maintenance run is missing", async () => {
    const fixture = createPublicRunnerMemory(publicScopeContext);
    await fixture.run(async () => {
      const currentTime = new Date("2026-09-05T04:00:00.000Z");
      const agentId = await fixture.initializeNative();
      const claimed = await fixture.claim(
        agentId,
        "Own the orphan-lease Memory",
      );
      if (!fixture.actor.orgId || !claimed.memory.versionId) {
        throw new Error("Expected a public Memory version and owner");
      }
      const scope = {
        memoryStorageId: claimed.memory.storageId,
        orgId: fixture.actor.orgId,
        userId: fixture.actor.userId,
        baseVersion: { versionId: claimed.memory.versionId },
      };
      const leaseToken = randomUUID();
      const maintenanceRunId = randomUUID();
      await insertPendingPhase2Job(scope, {
        status: "leased",
        claimedRevision: 1,
        leaseToken,
        sandboxLeaseToken: leaseToken,
        leaseExpiresAt: new Date("2026-09-05T03:00:00.000Z"),
        maintenanceRunId,
        claimedSelectionDigest: "a".repeat(64),
        claimedSelectedCount: 0,
        claimedSelectedUtf8Bytes: 0,
      });

      const store = createStore();
      await expect(
        store.set(
          createPiMemoryPhase2Worker(scope).execute$,
          currentTime,
          publicScopeContext.signal,
        ),
      ).resolves.toStrictEqual({
        outcome: "failed",
        errorClass: "maintenance_run_missing",
      });
      await expect(readPhase2Job(scope)).resolves.toMatchObject({
        status: "retryable_failure",
        maintenanceRunId: null,
        leaseToken: null,
        sandboxLeaseToken: null,
        retryCount: 1,
        lastErrorClass: "maintenance_run_missing",
      });
    });
  });

  it("releases the claim when standard run launch preparation fails", async () => {
    const fixture = createPublicPiMemorySource(publicScopeContext, {
      cashCredits: 100_000,
    });
    await fixture.run(async () => {
      const job = await createPublicPhase2WorkerFixture(
        fixture,
        new Date(now() + 24 * 3_600_000),
        "candidate survives failed standard launch preparation",
      );
      const scope = job.scope;
      await fixture.disconnect(scope.subscription.accountSourceId);
      await seedBuiltInModelKey(
        publicScopeContext,
        "deepseek-v4.1-flash",
        fixture.registerCleanup,
      );
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", undefined);
      await expect(job.work()).resolves.toStrictEqual({
        outcome: "failed",
        errorClass: "maintenance_dispatch_failed",
      });
      const failed = await publicMaintenanceRuns(fixture);
      expect(failed).toHaveLength(1);
      if (!failed[0]) {
        throw new Error("Expected failed maintenance");
      }
      fixture.registerRun(failed[0].id);
      await expect(
        createRunsApi(publicScopeContext).readRun(fixture.actor, failed[0].id),
      ).resolves.toMatchObject({
        status: "failed",
        error: expect.stringContaining("RUNNER_DEFAULT_GROUP"),
      });
      // Original key10 launch rollback guard, absent from public Run responses.
      await expect(
        db()
          .select({ storageMounts: agentRuns.storageMounts })
          .from(agentRuns)
          .where(eq(agentRuns.id, failed[0].id)),
      ).resolves.toStrictEqual([{ storageMounts: null }]);
      await expect(readPhase2Job(scope)).resolves.toMatchObject({
        status: "retryable_failure",
        maintenanceRunId: null,
        leaseToken: null,
        sandboxLeaseToken: null,
        retryCount: 1,
        lastErrorClass: "maintenance_dispatch_failed",
      });
      const [candidate] = await db()
        .select({ rawMemory: piMemoryStage1Candidates.rawMemory })
        .from(piMemoryStage1Candidates)
        .where(
          eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
        );
      expect(candidate?.rawMemory).toBe(
        "candidate survives failed standard launch preparation",
      );
    });
  });

  it("records the failed run when the built-in allowance refresh fails", async () => {
    const fixture = createPublicPiMemorySource(publicScopeContext);
    await fixture.run(async () => {
      const job = await createPublicPhase2WorkerFixture(
        fixture,
        new Date(now() + 24 * 3_600_000),
        "candidate survives a failed allowance refresh",
      );

      await fixture.disconnect(job.scope.subscription.accountSourceId);
      await seedBuiltInModelKey(
        publicScopeContext,
        "deepseek-v4.1-flash",
        fixture.registerCleanup,
      );
      await postUsageAllowanceInvoicePaid(publicScopeContext.signal, {
        orgId: job.scope.orgId,
        userId: job.scope.userId,
        customerId: fixture.customerId,
        subscriptionId: fixture.subscriptionId,
        shortWindowSeconds: 18_000,
        shortWindowUnits: 10_000,
        weeklyWindowSeconds: 604_800,
        weeklyWindowUnits: 100_000,
        effectiveAt: new Date(job.at.getTime() - 30 * 24 * 3_600_000),
        expiresAt: new Date(job.at.getTime() - 3_600_000),
      });
      await flushWaitUntilForTest();
      mockStripeClient(publicScopeContext.mocks.stripe);
      const retrieves =
        publicScopeContext.mocks.stripe.subscriptions.retrieve.mock.calls
          .length;
      publicScopeContext.mocks.stripe.subscriptions.retrieve.mockRejectedValue(
        new Error("Stripe subscription read failed"),
      );
      await expect(job.work()).resolves.toStrictEqual({
        outcome: "failed",
        errorClass: "maintenance_dispatch_failed",
      });
      expect(
        publicScopeContext.mocks.stripe.subscriptions.retrieve,
      ).toHaveBeenCalledTimes(retrieves + 1);
      const failures = await publicMaintenanceRuns(fixture);
      expect(failures).toHaveLength(1);
      const failed = failures[0];
      if (!failed) {
        throw new Error("Expected the recorded failed Run");
      }
      fixture.registerRun(failed.id);
      await expect(
        createRunsApi(publicScopeContext).readRun(fixture.actor, failed.id),
      ).resolves.toMatchObject({
        status: "failed",
        error: "Stripe subscription read failed",
      });
    });
  });

  it("dispatches one isolated threadless run after a shared public Agent source", async () => {
    const now = new Date("2026-09-05T02:00:00.000Z");
    const scope = await createPhase2TestScope("sandbox-dispatch", {
      emptyBase: true,
    });
    await enablePiMemoryForScope(scope);
    await seedOrgMetadata({
      orgId: scope.orgId,
      tier: "pro",
      credits: 100_000,
    });
    const agentId = randomUUID();
    const sourceSessionId = randomUUID();
    const sourceThreadId = randomUUID();
    const sourceRunId = randomUUID();
    const agentOwnerId = `${scope.userId}-agent-owner`;
    await db().insert(agents).values({
      id: agentId,
      orgId: scope.orgId,
      owner: agentOwnerId,
      name: "shared-pi-agent",
      visibility: "public",
    });
    await db().insert(agentSessions).values({
      id: sourceSessionId,
      orgId: scope.orgId,
      userId: scope.userId,
      agentId,
    });
    await db().insert(chatThreads).values({
      id: sourceThreadId,
      userId: scope.userId,
      agentId,
      title: "Shared Pi source",
    });
    await db().transaction(async (tx) => {
      await tx.insert(agentRuns).values({
        id: sourceRunId,
        sessionId: sourceSessionId,
        orgId: scope.orgId,
        userId: scope.userId,
        status: "completed",
        prompt: "Remember this from a shared public Agent.",
        modelProvider: "built-in",
        modelProviderId: null,
        modelProviderCredentialScope: "org",
        triggerSource: "agent",
        autonomyBudget: 0,
        chatThreadId: sourceThreadId,
        completedAt: now,
      });
      await captureFixtureRunBilling(tx, sourceRunId);
    });
    await db()
      .update(chatThreads)
      .set({
        agentSessionId: sourceSessionId,
        agentSessionRunId: sourceRunId,
      })
      .where(eq(chatThreads.id, sourceThreadId));
    onTestFinished(async () => {
      await deleteRunSessionsForScope(scope);
      await db().delete(agents).where(eq(agents.id, agentId));
    });
    await seedBuiltInModelKey(publicScopeContext, "deepseek-v4.1-flash");
    // V4.1 Flash dispatch requires the commit-addressed CLI reader artifact.
    configureNativeCliArtifact();
    const sessionId = randomUUID();
    const [sourceHistoryHash] = await insertPhase2Candidates(scope, [
      {
        piSessionId: sessionId,
        sourceRunId,
        rawMemory: "candidate stays inside the private launch payload",
        rolloutSummary: "evidence stays inside the private launch payload",
      },
    ]);
    await insertPendingPhase2Job(scope, { updatedAt: now });
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    const store = createStore();

    const result = await withMockNowForTest(now, async () => {
      return await store.set(
        createPiMemoryPhase2Worker(scope).execute$,
        now,
        publicScopeContext.signal,
      );
    });

    expect(result.outcome).toBe("dispatched");
    if (result.outcome !== "dispatched") {
      throw new Error("Expected maintenance run dispatch");
    }
    const [run] = await db()
      .select({
        sessionId: agentRuns.sessionId,
        status: agentRuns.status,
        error: agentRuns.error,
        triggerSource: agentRuns.triggerSource,
        chatThreadId: agentRuns.chatThreadId,
        prompt: agentRuns.prompt,
        storageMounts: agentRuns.storageMounts,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, result.runId));
    expect(run).toMatchObject({ status: "pending", error: null });
    expect(run?.triggerSource).toBe("agent");
    expect(run?.chatThreadId).toBeNull();
    // Assistant text from the threadless maintenance run changes no thread.
    const owner = {
      userId: scope.userId,
      orgId: scope.orgId,
      orgRole: "org:admin" as const,
      email: `${scope.userId}@example.test`,
    };
    const chatApi = createChatFilesBddApi(publicScopeContext);
    const threadEventsBefore = await chatApi.listThreadEvents(
      owner,
      sourceThreadId,
    );
    await createWebhookCallbackApi(publicScopeContext).requestAgentEvents(
      {
        runId: result.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 1,
            message: {
              id: "msg_maintenance_detached",
              content: [{ type: "text", text: "No thread receives this" }],
            },
          },
        ],
      },
      {
        authorization: `Bearer ${createRunsApi(publicScopeContext).sandboxTokenForRun(owner, result.runId)}`,
      },
      [200],
    );
    await flushWaitUntilForTest();
    await expect(
      chatApi.listThreadEvents(owner, sourceThreadId),
    ).resolves.toStrictEqual(threadEventsBefore);
    expect(run?.prompt).not.toContain("candidate stays inside");
    expect(run?.storageMounts).toStrictEqual([
      expect.objectContaining({
        name: "memory",
        storageId: scope.memoryStorageId,
        version: scope.baseVersion.versionId,
        writeback: true,
        missingRootPolicy: "fail",
      }),
    ]);
    const [maintenanceSession] = run
      ? await db()
          .select({ agentId: agentSessions.agentId })
          .from(agentSessions)
          .where(eq(agentSessions.id, run.sessionId))
      : [];
    expect(maintenanceSession?.agentId).toBeNull();
    await expect(
      db()
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(eq(agents.orgId, scope.orgId), eq(agents.owner, scope.userId)),
        ),
    ).resolves.toStrictEqual([]);
    await expect(
      db()
        .select({ id: agents.id, name: agents.name, owner: agents.owner })
        .from(agents)
        .where(eq(agents.orgId, scope.orgId)),
    ).resolves.toStrictEqual([
      { id: agentId, name: "shared-pi-agent", owner: agentOwnerId },
    ]);
    const [callback] = await db()
      .select({
        internalKind: agentRunCallbacks.internalKind,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, result.runId));
    expect(callback).toMatchObject({
      internalKind: "pi-memory:phase2",
      payload: {
        memoryStorageId: scope.memoryStorageId,
        selected: [{ piSessionId: sessionId, sourceHistoryHash }],
      },
    });
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "leased",
      maintenanceRunId: result.runId,
      sandboxLeaseToken: expect.any(String),
    });

    const afterOriginalLease = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const activeJob = await readPhase2Job(scope);
    if (
      !activeJob?.leaseToken ||
      !activeJob.claimedRevision ||
      !activeJob.claimedSelectionDigest
    ) {
      throw new Error("Expected active maintenance claim fence");
    }
    const leaseToken = activeJob.leaseToken;
    const claimedRevision = activeJob.claimedRevision;
    const selectionDigest = activeJob.claimedSelectionDigest;
    await expect(
      failPiMemoryPhase2Job(db(), {
        ...scope,
        leaseToken,
        claimedRevision,
        claimedBaseVersionId: scope.baseVersion.versionId,
        currentTime: new Date(now.getTime() + 1),
        expectedMaintenanceRunId: null,
        errorClass: "post_commit_dispatch_error",
      }),
    ).resolves.toBeFalsy();
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "leased",
      maintenanceRunId: result.runId,
    });
    await db()
      .update(agentRuns)
      .set({ status: "running" })
      .where(eq(agentRuns.id, result.runId));
    const invalidFiles = [
      { path: "MEMORY.md", hash: "c".repeat(64), size: 1 },
    ] as const;
    const invalidVersionId = computeContentHashFromHashes(
      scope.memoryStorageId,
      invalidFiles,
    );
    const rejected = await withMockNowForTest(afterOriginalLease, async () => {
      return await store.set(
        prepareStorageUploadForAuth$,
        {
          auth: {
            runId: result.runId,
            orgId: scope.orgId,
            userId: scope.userId,
          },
          runId: result.runId,
          storageId: scope.memoryStorageId,
          parentVersionId: scope.baseVersion.versionId,
          files: invalidFiles,
          maintenanceAttestation: {
            schemaVersion: 2,
            leaseToken,
            claimedRevision,
            claimedBaseVersionId: scope.baseVersion.versionId,
            selectionDigest,
            validatedVersionId: invalidVersionId,
          },
        },
        publicScopeContext.signal,
      );
    });
    expect(rejected.status).toBe(404);
    await expect(
      db()
        .select({ id: storageVersions.id })
        .from(storageVersions)
        .where(
          and(
            eq(storageVersions.storageId, scope.memoryStorageId),
            eq(storageVersions.id, invalidVersionId),
          ),
        ),
    ).resolves.toStrictEqual([]);

    const recovered = await store.set(
      createPiMemoryPhase2Worker(scope).execute$,
      afterOriginalLease,
      publicScopeContext.signal,
    );
    expect(recovered).toStrictEqual({
      outcome: "dispatched",
      runId: result.runId,
    });
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      maintenanceRunId: result.runId,
      leaseExpiresAt: new Date(afterOriginalLease.getTime() + 60 * 60 * 1000),
    });
    await expect(
      db()
        .select({ id: agentRunCallbacks.id })
        .from(agentRunCallbacks)
        .where(eq(agentRunCallbacks.runId, result.runId)),
    ).resolves.toHaveLength(1);

    const publishedVersion = await insertPhase2StorageVersion(
      scope,
      "sandbox-checkpoint",
    );
    await setPhase2StorageHead(scope, publishedVersion, afterOriginalLease);
    await db().insert(storageVersionLineage).values({
      storageId: scope.memoryStorageId,
      versionId: publishedVersion.versionId,
      parentVersionId: scope.baseVersion.versionId,
      runId: result.runId,
    });
    const [conversation] = await db()
      .insert(conversations)
      .values({
        runId: result.runId,
        cliAgentType: "pi",
        cliAgentSessionId: result.runId,
      })
      .onConflictDoUpdate({
        target: conversations.runId,
        set: {
          cliAgentType: "pi",
          cliAgentSessionId: result.runId,
        },
      })
      .returning({ id: conversations.id });
    if (!conversation || !callback?.payload) {
      throw new Error("Expected exact maintenance callback fixture");
    }
    await db()
      .insert(checkpoints)
      .values({
        runId: result.runId,
        conversationId: conversation.id,
        storageMounts: [
          {
            orgId: scope.orgId,
            userId: scope.userId,
            name: "memory",
            storageId: scope.memoryStorageId,
            version: publishedVersion.versionId,
            mountPath: PI_MEMORY_ROOT,
            writeback: true,
            missingRootPolicy: "fail",
          },
        ],
      });
    await db()
      .update(agentRuns)
      .set({ status: "completed", completedAt: afterOriginalLease })
      .where(eq(agentRuns.id, result.runId));

    const completion = {
      runId: result.runId,
      status: "completed" as const,
      payload: callback.payload,
    };
    await expect(
      handlePiMemoryPhase2MaintenanceCallback(db(), {
        ...completion,
        payload: null,
      }),
    ).resolves.toStrictEqual({
      success: false,
      error: "Invalid Pi memory maintenance callback",
    });
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "leased",
      maintenanceRunId: result.runId,
    });
    await expect(
      handlePiMemoryPhase2MaintenanceCallback(db(), completion),
    ).resolves.toStrictEqual({ success: true });
    const versionsBeforeReplay = await db()
      .select({ id: storageVersions.id })
      .from(storageVersions)
      .where(eq(storageVersions.storageId, scope.memoryStorageId));
    await expect(
      handlePiMemoryPhase2MaintenanceCallback(db(), completion),
    ).resolves.toStrictEqual({ success: true, skipped: true });
    await expect(
      db()
        .select({ id: storageVersions.id })
        .from(storageVersions)
        .where(eq(storageVersions.storageId, scope.memoryStorageId)),
    ).resolves.toStrictEqual(versionsBeforeReplay);
    await expect(
      db()
        .select({ headVersionId: storages.headVersionId })
        .from(storages)
        .where(eq(storages.id, scope.memoryStorageId)),
    ).resolves.toStrictEqual([{ headVersionId: publishedVersion.versionId }]);
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "idle",
      completedRevision: 1,
      lastMaintenanceRunId: result.runId,
      lastMaintenanceCheckpointVersionId: publishedVersion.versionId,
      lastMaintenanceOutcome: "published",
    });
  });
});

// Prepares test scope and worker execution; this helper returns no credentials.

async function publicMaintenanceRuns(
  fixture: ReturnType<typeof createPublicPiMemorySource>,
) {
  return (
    await createRunReadsApi(publicScopeContext).requestListLogs(
      fixture.actor,
      { triggerSource: "agent", limit: 100 },
      [200],
    )
  ).body.data;
}

function onPublicMemoryArchivePresign(
  archiveKey: string,
  fault: () => Promise<void> | void,
) {
  publicScopeContext.mocks.s3.getSignedUrl.mockImplementation(
    async (_client: unknown, command: unknown) => {
      const url = apiTestS3PresignedUrl(command);
      if (new URL(url).searchParams.get("object")?.endsWith(`/${archiveKey}`)) {
        await fault();
      }
      return url;
    },
  );
}

async function publicMemoryVersion(
  fixture: ReturnType<typeof createPublicPiMemorySource>,
  agentId: string,
) {
  const api = createRunsApi(publicScopeContext);
  await api.ensurePersonalSubscriptionModel(fixture.actor, {
    model: "claude-fable-5-1",
  });
  const run = await api.createThreadRun(fixture.actor, {
    agentId,
    prompt: "Read the preserved Memory",
    model: "claude-fable-5-1",
  });
  fixture.registerRun(run.runId);
  const execution = await api.claimRunnerJob(run.runId);
  fixture.registerClaim(run.runId, execution.sandboxToken);
  const memory = expectCanonicalStorageManifest(
    execution.storageManifest,
  )?.storageMounts.find((mount) => {
    return mount.name === "memory";
  });
  if (!memory) {
    throw new Error("Expected the same owner's Memory mount");
  }
  return memory.versionId;
}

async function createPublicPhase2WorkerFixture(
  fixture: ReturnType<typeof createPublicPiMemorySource>,
  at: Date,
  rawMemory?: string,
) {
  const scope = await fixture.prepare(at);
  fixture.installExtractionProvider(rawMemory);
  await expect(fixture.extract()).resolves.toMatchObject({
    claimed: 1,
    succeeded: 1,
  });
  const store = createStore();
  return {
    scope,
    at,
    async work(time = at, signal = publicScopeContext.signal) {
      const result = await withMockNowForTest(time, async () => {
        return await store.set(
          createPiMemoryPhase2Worker(scope).execute$,
          time,
          signal,
        );
      });
      if (result.outcome === "dispatched") {
        fixture.registerRun(result.runId);
      }
      return result;
    },
  };
}

function ownedPublicPhase2Job(
  fixture: ReturnType<typeof createPublicPiMemorySource>,
  scope: Awaited<ReturnType<typeof fixture.prepare>>,
  at: Date,
) {
  const store = createStore();
  return {
    scope,
    at,
    async work(time = at, signal = publicScopeContext.signal) {
      const result = await withMockNowForTest(time, () => {
        return store.set(
          createPiMemoryPhase2Worker(scope).execute$,
          time,
          signal,
        );
      });
      if (result.outcome === "dispatched") {
        fixture.registerRun(result.runId);
      }
      return result;
    },
  };
}

async function expectPublicFailedJob(
  scope: { memoryStorageId: string; orgId: string; userId: string },
  reason: string,
) {
  // Original named key10 finite lease/retry/input-consumption safety boundary.
  await expect(readPhase2Job(scope)).resolves.toMatchObject({
    status: "retryable_failure",
    retryCount: 1,
    completedRevision: 0,
    maintenanceRunId: null,
    lastErrorClass: reason,
  });
}

async function claimOwnedMemoryCarrier(
  fixture: ReturnType<typeof createPublicPiMemorySource>,
  agentId: string,
) {
  const api = createRunsApi(publicScopeContext);
  fixture.registerCleanup(async () => {
    await fixture.misc.deletePersonalModelProvider(
      fixture.actor,
      "claude-code-oauth-token",
      [204, 404],
    );
  });
  await api.ensurePersonalSubscriptionModel(fixture.actor);
  const run = await api.createThreadRun(fixture.actor, {
    agentId,
    model: "claude-fable-5-1",
    prompt: "Own concurrent Memory writeback",
  });
  fixture.registerRun(run.runId);
  const execution = await api.claimRunnerJob(run.runId);
  fixture.registerClaim(run.runId, execution.sandboxToken);
  const memory = expectCanonicalStorageManifest(
    execution.storageManifest,
  )?.storageMounts.find((entry) => {
    return entry.name === "memory";
  });
  if (!memory?.storageId) {
    throw new Error("Expected real owned Memory carrier");
  }
  return {
    runId: run.runId,
    memory,
    headers: { authorization: `Bearer ${execution.sandboxToken}` },
  };
}

async function commitOwnedCarrierMemory(
  carrier: Awaited<ReturnType<typeof claimOwnedMemoryCarrier>>,
  content: string,
) {
  const context = publicScopeContext;
  const files = [storageTextFile("MEMORY.md", content)];
  const objects = new Map<string, Buffer>();
  const transport = context.mocks.s3.send.getMockImplementation();
  if (!transport) {
    throw new Error("Expected real source transport");
  }
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      (command instanceof GetObjectCommand ||
        command instanceof HeadObjectCommand) &&
      command.input.Key &&
      objects.has(command.input.Key)
    ) {
      const bytes = objects.get(command.input.Key);
      if (!bytes) {
        throw new Error("Expected owned archive bytes");
      }
      return Promise.resolve({
        ContentLength: bytes.length,
        Body: {
          async *[Symbol.asyncIterator]() {
            yield bytes;
          },
        },
      });
    }
    return transport(command);
  });
  const api = createWebhookCallbackApi(context);
  const prepared = await api.requestAgentStoragePrepare(
    { runId: carrier.runId, storageId: carrier.memory.storageId, files },
    carrier.headers,
    [200],
  );
  if (prepared.status !== 200 || !prepared.body.uploads) {
    throw new Error("Expected real upload targets");
  }
  objects.set(
    prepared.body.uploads.archive.key,
    memoryArchive("MEMORY.md", content),
  );
  objects.set(
    prepared.body.uploads.manifest.key,
    Buffer.from(
      JSON.stringify({
        version: 1,
        files,
        createdAt: new Date(0).toISOString(),
      }),
    ),
  );
  await api.requestAgentStorageCommit(
    {
      runId: carrier.runId,
      storageId: carrier.memory.storageId,
      versionId: prepared.body.versionId,
      files,
    },
    carrier.headers,
    [200],
  );
  return prepared.body.versionId;
}

async function createPhase2WorkerFixture(label: string, emptyBase = true) {
  const scope = await createPhase2TestScope(label, { emptyBase });
  await enablePiMemoryForScope(scope);
  await seedOrgMetadata({ orgId: scope.orgId, tier: "pro", credits: 100_000 });
  await seedBuiltInModelKey(publicScopeContext, "deepseek-v4.1-flash");
  // V4.1 Flash dispatch requires the commit-addressed CLI reader artifact.
  configureNativeCliArtifact();
  await insertPendingPhase2Job(scope, {
    updatedAt: new Date("2026-09-05T02:00:00Z"),
  });
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  onTestFinished(async () => {
    await deleteRunSessionsForScope(scope);
  });
  const store = createStore();
  return {
    scope,
    async work(
      at = new Date("2026-09-05T02:00:00Z"),
      signal = publicScopeContext.signal,
    ) {
      const { execute$ } = createPiMemoryPhase2Worker(scope);
      return await withMockNowForTest(at, async () => {
        return await store.set(execute$, at, signal);
      });
    },
  };
}

const builtinSource = {
  modelProvider: "built-in",
  modelProviderId: null,
  modelProviderCredentialScope: null,
} satisfies Phase2SourceBinding;

async function expectNoDispatch(
  job: Awaited<ReturnType<typeof createPhase2WorkerFixture>>,
  reason: string,
  expectedHead: string | null = job.scope.baseVersion.versionId,
) {
  const result = await job.work();
  const runs = await db()
    .select({ error: agentRuns.error })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, job.scope.orgId),
        eq(agentRuns.triggerSource, "agent"),
      ),
    );
  expect(result, JSON.stringify(runs)).toStrictEqual({
    outcome: "failed",
    errorClass: reason,
  });
  await expect(readPhase2Job(job.scope)).resolves.toMatchObject({
    status: "retryable_failure",
    retryCount: 1,
    completedRevision: 0,
    maintenanceRunId: null,
    lastErrorClass: reason,
  });
  await expect(
    db()
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, job.scope.orgId),
          eq(agentRuns.triggerSource, "agent"),
        ),
      ),
  ).resolves.toStrictEqual([]);
  if (expectedHead !== null) {
    await expect(
      db()
        .select({ head: storages.headVersionId })
        .from(storages)
        .where(eq(storages.id, job.scope.memoryStorageId)),
    ).resolves.toStrictEqual([{ head: expectedHead }]);
  }
}

// Runs `fault` when run preparation presigns the non-empty memory base archive.
// Storage materialization happens after credential resolution and before the
// final admission transaction; other presigns keep the default behavior.
function onMemoryArchivePresign(
  job: Awaited<ReturnType<typeof createPhase2WorkerFixture>>,
  fault: () => Promise<void> | void,
) {
  const archiveKey = `${job.scope.baseVersion.s3Key}/archive.tar.gz`;
  publicScopeContext.mocks.s3.getSignedUrl.mockImplementation(
    async (_client: unknown, command: unknown) => {
      const url = apiTestS3PresignedUrl(command);
      if (new URL(url).searchParams.get("object")?.endsWith(`/${archiveKey}`)) {
        await fault();
      }
      return url;
    },
  );
}

describe("Phase 2 current credential admission", () => {
  it.each([true, false])(
    "defers empty-selection cleanup/repair for emptyBase=%s with three hourly attempts",
    async (emptyBase) => {
      const fixture = createPublicPiMemorySource(publicScopeContext, {
        cashCredits: 100_000,
        memoryFile: emptyBase
          ? undefined
          : { path: "MEMORY.md", content: "Original empty-selection Memory" },
      });
      await fixture.run(async () => {
        const at = new Date(now() + 24 * 3_600_000);
        const scope = await fixture.prepare(at);
        fixture.installExtractionProvider([
          { rawMemory: "", rolloutSummary: "" },
        ]);
        await expect(fixture.extract()).resolves.toMatchObject({
          claimed: 1,
          succeededNoOutput: 1,
        });
        const job = ownedPublicPhase2Job(fixture, scope, at);
        const presigns =
          publicScopeContext.mocks.s3.getSignedUrl.mock.calls.length;
        const result = await job.work();
        expect(result).toStrictEqual({
          outcome: "failed",
          errorClass: "source_credentials_missing",
        });
        expect(
          publicScopeContext.mocks.s3.getSignedUrl.mock.calls,
        ).toHaveLength(presigns);
        await expectPublicFailedJob(job.scope, "source_credentials_missing");
        await expect(publicMaintenanceRuns(fixture)).resolves.toStrictEqual([]);
        await expect(
          publicMemoryVersion(fixture, scope.sourceAgentId),
        ).resolves.toBe(
          scope.publishedMemory?.versionId ?? scope.sourceMemoryVersionId,
        );
        for (let attempt = 2; attempt <= 3; attempt++) {
          const at = new Date(
            job.at.getTime() + (attempt - 1) * PI_MEMORY_PHASE2_RETRY_DELAY_MS,
          );
          await expect(job.work(at)).resolves.toMatchObject({
            outcome: "failed",
            errorClass: "source_credentials_missing",
          });
          await expect(readPhase2Job(job.scope)).resolves.toMatchObject({
            retryCount: attempt,
            completedRevision: 0,
            status: attempt === 3 ? "terminal_failure" : "retryable_failure",
          });
        }
      });
    },
  );

  it.each(["same-type-account", "builtin-subscription"])(
    "dispatches the whole %s selection through the current personal subscription route",
    async (kind) => {
      expect.hasAssertions();
      const job = await createPhase2WorkerFixture(`mixed-${kind}`);
      const provider = await createPhase2CodexProvider(
        publicScopeContext,
        job.scope,
      );
      const second =
        kind === "builtin-subscription"
          ? builtinSource
          : { ...provider.binding, modelProviderId: randomUUID() };
      const firstSession = randomUUID();
      const secondSession = randomUUID();
      await insertPhase2Candidates(
        job.scope,
        [{ piSessionId: firstSession }],
        provider.binding,
      );
      await insertPhase2Candidates(
        job.scope,
        [{ piSessionId: secondSession }],
        second,
      );
      const result = await job.work();
      expect(result.outcome).toBe("dispatched");
      if (result.outcome !== "dispatched") {
        throw new Error("Expected dispatch");
      }
      await expect(
        db()
          .select({
            type: agentRuns.modelProvider,
            id: agentRuns.modelProviderId,
            model: agentRuns.selectedModel,
          })
          .from(agentRuns)
          .where(eq(agentRuns.id, result.runId)),
      ).resolves.toStrictEqual([
        {
          type: "codex-oauth-token",
          id: provider.binding.modelProviderId,
          model: "gpt-6-luna",
        },
      ]);
      const [callback] = await db()
        .select({ payload: agentRunCallbacks.payload })
        .from(agentRunCallbacks)
        .where(
          and(
            eq(agentRunCallbacks.runId, result.runId),
            eq(agentRunCallbacks.internalKind, "pi-memory:phase2"),
          ),
        );
      expect(callback?.payload).toMatchObject({
        selected: expect.arrayContaining([
          expect.objectContaining({ piSessionId: firstSession }),
          expect.objectContaining({ piSessionId: secondSession }),
        ]),
      });
    },
  );

  it("normalizes legitimate built-in null/org scopes across all sources", async () => {
    const fixture = createPublicPiMemorySource(publicScopeContext, {
      cashCredits: 100_000,
      sourceProvider: "built-in",
      sources: ["first builtin source", "second builtin source"],
    });
    await fixture.run(async () => {
      const at = new Date(now() + 24 * 3_600_000);
      const scope = await fixture.prepare(at);
      fixture.installExtractionProvider();
      await expect(fixture.extract()).resolves.toMatchObject({
        claimed: 2,
        succeeded: 2,
      });
      const first = scope.sources[0];
      if (!first) {
        throw new Error("Expected first real source");
      }
      // Original named key10 legacy null representation; current writers use org.
      await db()
        .update(agentRuns)
        .set({ modelProviderCredentialScope: null })
        .where(eq(agentRuns.id, first.runId));
      const result = await ownedPublicPhase2Job(fixture, scope, at).work();
      expect(result.outcome).toBe("dispatched");
      if (result.outcome !== "dispatched") {
        throw new Error("Expected maintenance");
      }
      const execution = await claimPhase2Execution(
        publicScopeContext,
        result.runId,
      );
      fixture.registerClaim(result.runId, execution.sandboxToken);
      expect(
        (
          await createRunsApi(publicScopeContext).readRun(
            fixture.actor,
            result.runId,
          )
        ).source,
      ).toMatchObject({
        providerType: "built-in",
        model: "deepseek-v4.1-flash",
        credentialScope: "org",
      });
      expect(
        execution.piLaunchConfig?.maintenance?.selected
          .map((entry) => {
            return entry.sourceRunId;
          })
          .sort(),
      ).toStrictEqual(
        scope.sources
          .map((entry) => {
            return entry.runId;
          })
          .sort(),
      );
      // Public source deliberately hides built-in provider IDs; retain the exact normalization guard.
      await expect(
        db()
          .select({ id: agentRuns.modelProviderId })
          .from(agentRuns)
          .where(eq(agentRuns.id, result.runId)),
      ).resolves.toStrictEqual([{ id: null }]);
    });
  });

  it("dispatches when the historical source run no longer exists", async () => {
    const fixture = createPublicPiMemorySource(publicScopeContext);
    await fixture.run(async () => {
      const job = await createPublicPhase2WorkerFixture(
        fixture,
        new Date(now() + 24 * 3_600_000),
      );

      await fixture.disconnect(job.scope.subscription.accountSourceId);
      await seedBuiltInModelKey(
        publicScopeContext,
        "deepseek-v4.1-flash",
        fixture.registerCleanup,
      );
      for (const source of job.scope.sources) {
        fixture.registerRunDeletion(source.runId);
      }
      fixture.registerRunDeletion(job.scope.triggerRunId);
      await createBddApi(publicScopeContext).deleteAgent(
        fixture.actor,
        job.scope.sourceAgentId,
      );
      await flushWaitUntilForTest();
      for (const source of job.scope.sources) {
        await createRunsApi(publicScopeContext).requestReadRun(
          fixture.actor,
          source.runId,
          [404],
        );
      }
      await expect(job.work()).resolves.toMatchObject({
        outcome: "dispatched",
      });
    });
  });

  it("uses built-in after the only personal subscription account is disconnected", async () => {
    const fixture = createPublicPiMemorySource(publicScopeContext);
    await fixture.run(async () => {
      const job = await createPublicPhase2WorkerFixture(
        fixture,
        new Date(now() + 24 * 3_600_000),
      );

      await fixture.disconnect(job.scope.subscription.accountSourceId);
      await seedBuiltInModelKey(
        publicScopeContext,
        "deepseek-v4.1-flash",
        fixture.registerCleanup,
      );
      const result = await job.work();
      expect(result.outcome).toBe("dispatched");
      if (result.outcome !== "dispatched") {
        throw new Error("Expected dispatch");
      }
      const execution = await claimPhase2Execution(
        publicScopeContext,
        result.runId,
      );
      fixture.registerClaim(result.runId, execution.sandboxToken);
      await expect(
        createRunsApi(publicScopeContext).readRun(fixture.actor, result.runId),
      ).resolves.toMatchObject({
        source: {
          providerType: "built-in",
          model: "deepseek-v4.1-flash",
          credentialScope: "org",
        },
      });
      expect(execution.piModelConfig).toMatchObject({
        provider: "openrouter",
        model: "deepseek/deepseek-v4.1-flash",
      });
    });
  });

  it("ignores stale historical provider IDs when no personal subscription is configured", async () => {
    const job = await createPhase2WorkerFixture("stale-source-binding");
    await insertPhase2Candidates(job.scope, [{ piSessionId: randomUUID() }], {
      modelProvider: "codex-oauth-token",
      modelProviderId: randomUUID(),
      modelProviderCredentialScope: "member",
    });
    const result = await job.work();
    expect(result.outcome).toBe("dispatched");
    if (result.outcome !== "dispatched") {
      throw new Error("Expected dispatch");
    }
    await expect(
      db()
        .select({
          type: agentRuns.modelProvider,
          model: agentRuns.selectedModel,
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, result.runId)),
    ).resolves.toStrictEqual([
      { type: "built-in", model: "deepseek-v4.1-flash" },
    ]);
  });

  it.each(["storage-head", "switch", "active-account", "disconnect"] as const)(
    "fences %s changes during asynchronous preparation",
    async (fault) => {
      const job = await createPhase2WorkerFixture(`race-${fault}`, false);
      const provider = await createPhase2CodexProvider(
        publicScopeContext,
        job.scope,
      );
      const sourceIds = [randomUUID(), randomUUID()].sort();
      await insertPhase2Candidates(
        job.scope,
        sourceIds.map((sourceRunId) => {
          return { piSessionId: randomUUID(), sourceRunId };
        }),
        provider.binding,
      );
      const activatePreparedAccount =
        fault === "active-account"
          ? await preparePhase2CodexActivation(
              publicScopeContext,
              job.scope,
              provider.binding.modelProviderId,
            )
          : undefined;
      let changed = false;
      let expectedHead = job.scope.baseVersion.versionId;
      onMemoryArchivePresign(job, async () => {
        if (!changed) {
          changed = true;
          if (fault === "storage-head") {
            const version = await insertPhase2StorageVersion(
              job.scope,
              "external",
            );
            await setPhase2StorageHead(job.scope, version);
            expectedHead = version.versionId;
          } else if (fault === "switch") {
            await updateFeatureSwitchesForUser(publicScopeContext, job.scope, {
              [FeatureSwitchKey.PiMemory]: false,
            });
          } else if (fault === "active-account") {
            await activatePreparedAccount?.();
          } else {
            await disconnectPhase2Codex(
              publicScopeContext,
              job.scope,
              provider.binding.modelProviderId,
            );
          }
        }
      });
      await expectNoDispatch(
        job,
        fault === "switch"
          ? "pi_memory_disabled"
          : fault === "storage-head"
            ? "storage_binding_changed"
            : "credential_unavailable",
        fault === "storage-head" ? null : expectedHead,
      );
      expect(changed).toBeTruthy();
    },
  );
});

test.each(["storage-head", "switch"] as const)(
  "fences public %s changes during asynchronous preparation",
  async (fault) => {
    const concurrentMemory = "Concurrent preparation Memory";
    let concurrentMemoryVersionId: string | undefined;
    const fixture = createPublicPiMemorySource(publicScopeContext, {
      cashCredits: 100_000,
      sources: [
        "first actual preparation source",
        "second actual preparation source",
      ],
      memoryFile: {
        path: "MEMORY.md",
        content: "Original owned preparation Memory",
      },

      async beforeMemoryPublication(agentId) {
        // Claim the empty mount before initial publication can cache its archive URL.
        if (fault === "storage-head") {
          const carrier = await claimOwnedMemoryCarrier(fixture, agentId);
          concurrentMemoryVersionId = await commitOwnedCarrierMemory(
            carrier,
            concurrentMemory,
          );
        }
      },
    });
    await fixture.run(async () => {
      const at = new Date(now() + 24 * 3_600_000);
      const scope = await fixture.prepare(at);
      fixture.installExtractionProvider();
      await expect(fixture.extract()).resolves.toMatchObject({
        claimed: 2,
        succeeded: 2,
      });
      if (!scope.publishedMemory) {
        throw new Error("Expected public source and Memory version");
      }
      const job = ownedPublicPhase2Job(fixture, scope, at);
      let changed = false;
      const originalHead = scope.publishedMemory.versionId;
      let expectedHead = originalHead;
      onPublicMemoryArchivePresign(
        scope.publishedMemory.archiveKey,
        async () => {
          if (changed) {
            return;
          }
          changed = true;
          if (fault === "storage-head") {
            if (!concurrentMemoryVersionId) {
              throw new Error("Expected publicly committed concurrent Memory");
            }
            // Key10 retains this exact original HEAD-only race input. A public
            // commit here also notifies new input, changing retry semantics.
            // Both nonempty versions were publicly committed before Stage1;
            // only the original notification-free HEAD swap remains private.
            expectedHead = concurrentMemoryVersionId;
            const changedStorage = await db()
              .update(storages)
              .set({
                headVersionId: concurrentMemoryVersionId,
                size: Buffer.byteLength(concurrentMemory),
                fileCount: 1,
                updatedAt: new Date(now()),
              })
              .where(
                and(
                  eq(storages.id, scope.memoryStorageId),
                  eq(storages.orgId, scope.orgId),
                  eq(storages.userId, scope.userId),
                  eq(storages.headVersionId, originalHead),
                ),
              )
              .returning({ id: storages.id });
            expect(changedStorage).toHaveLength(1);
          } else if (fault === "switch") {
            await updateFeatureSwitchesForUser(publicScopeContext, scope, {
              [FeatureSwitchKey.PiMemory]: false,
            });
          }
        },
      );
      const reason =
        fault === "switch"
          ? "pi_memory_disabled"
          : fault === "storage-head"
            ? "storage_binding_changed"
            : "credential_unavailable";
      await expect(job.work()).resolves.toStrictEqual({
        outcome: "failed",
        errorClass: reason,
      });
      await expectPublicFailedJob(scope, reason);
      await expect(publicMaintenanceRuns(fixture)).resolves.toStrictEqual([]);
      if (fault !== "storage-head") {
        await expect(
          publicMemoryVersion(fixture, scope.sourceAgentId),
        ).resolves.toBe(expectedHead);
      }
      expect(changed).toBeTruthy();
    });
  },
);

test("does not admit a subscription disconnected during preparation", async () => {
  const fixture = createPublicPiMemorySource(publicScopeContext, {
    memoryFile: { path: "MEMORY.md", content: "Original owned Memory" },
  });
  await fixture.run(async () => {
    const job = await createPublicPhase2WorkerFixture(
      fixture,
      new Date(now() + 24 * 3_600_000),
    );

    const published = job.scope.publishedMemory;
    if (!published) {
      throw new Error("Expected published Memory");
    }
    let disconnected = false;
    onPublicMemoryArchivePresign(published.archiveKey, async () => {
      if (!disconnected) {
        disconnected = true;
        await fixture.disconnect(job.scope.subscription.accountSourceId);
      }
    });
    await expect(job.work()).resolves.toMatchObject({
      outcome: "failed",
      errorClass: "credential_unavailable",
    });
    await expect(publicMaintenanceRuns(fixture)).resolves.toStrictEqual([]);
    expect(disconnected).toBeTruthy();
    await expect(
      publicMemoryVersion(fixture, job.scope.sourceAgentId),
    ).resolves.toBe(published.versionId);
  });
});

test("does not persist or dispatch when preparation is cancelled", async () => {
  const fixture = createPublicPiMemorySource(publicScopeContext, {
    memoryFile: { path: "MEMORY.md", content: "Original owned Memory" },
  });
  await fixture.run(async () => {
    const job = await createPublicPhase2WorkerFixture(
      fixture,
      new Date(now() + 24 * 3_600_000),
    );

    const published = job.scope.publishedMemory;
    if (!published) {
      throw new Error("Expected published Memory");
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      publicScopeContext.signal,
    ]);
    onPublicMemoryArchivePresign(published.archiveKey, () => {
      controller.abort(new Error("Cancelled preparation"));
    });
    await expect(job.work(undefined, signal)).rejects.toThrow(
      "Cancelled preparation",
    );
    await expect(publicMaintenanceRuns(fixture)).resolves.toStrictEqual([]);
  });
});

test.each([false, true])(
  "refreshes the current subscription or rejects revocation=%s",
  async (revoke) => {
    const fixture = createPublicPiMemorySource(publicScopeContext);
    await fixture.run(async () => {
      const job = await createPublicPhase2WorkerFixture(
        fixture,
        new Date(now() + 24 * 3_600_000),
      );
      const account = fixture.account;
      await fixture.expireCredential(job.scope.subscription.accountSourceId);
      const refreshed = makeCodexJwt({
        exp: Math.floor(now() / 1000) + 7200,
        identity: "refreshed-original",
      });
      const quotaHeaders: Headers[] = [];
      server.use(
        http.get(
          "https://chatgpt.com/backend-api/wham/usage",
          ({ request }) => {
            quotaHeaders.push(request.headers);
            return HttpResponse.json({
              rate_limit: { primary_window: { used_percent: 75 } },
            });
          },
        ),
      );
      const refreshes: string[] = [];
      server.use(
        http.post(
          "https://auth.openai.com/oauth/token",
          async ({ request }) => {
            refreshes.push(await request.text());
            if (revoke) {
              return HttpResponse.json(
                {
                  error: "invalid_grant",
                  error_description: "refresh_token_reused",
                },
                { status: 400 },
              );
            }
            return HttpResponse.json({
              access_token: refreshed,
              refresh_token: `refreshed-${account}`,
              token_type: "Bearer",
              expires_in: 7200,
              id_token: makeCodexJwt({
                "https://api.openai.com/auth": {
                  chatgpt_account_id: account,
                  chatgpt_plan_type: "plus",
                },
              }),
            });
          },
        ),
      );
      if (revoke) {
        await expect(job.work(nowDate())).resolves.toMatchObject({
          outcome: "failed",
          errorClass: "credential_unavailable",
        });
      } else {
        const result = await job.work(nowDate());
        if (result.outcome !== "dispatched") {
          throw new Error(
            `Expected subscription launch: ${JSON.stringify(result)}`,
          );
        }
        const actual = await executePhase2Runtime(
          publicScopeContext,
          result.runId,
          {
            registerCleanup: fixture.registerCleanup,
            onClaim: (execution) => {
              fixture.registerClaim(result.runId, execution.sandboxToken);
            },
          },
        );
        expect(actual.requests).toHaveLength(3);
        for (const request of actual.requests) {
          expect(request.headers.get("authorization")).toBe(
            `Bearer ${refreshed}`,
          );
          expect(request.headers.get("chatgpt-account-id")).toBe(account);
        }
      }
      expect(refreshes).toHaveLength(1);
      expect(refreshes[0]).toContain(`refresh-${account}`);
      expect(quotaHeaders).toHaveLength(revoke ? 0 : 1);
      if (!revoke) {
        expect(quotaHeaders[0]?.get("authorization")).toBe(
          `Bearer ${refreshed}`,
        );
        expect(quotaHeaders[0]?.get("chatgpt-account-id")).toBe(account);
      }
    });
  },
);

test("selects the current active account after historical account replacement", async () => {
  const fixture = createPublicPiMemorySource(publicScopeContext);
  await fixture.run(async () => {
    const job = await createPublicPhase2WorkerFixture(
      fixture,
      new Date(now() + 24 * 3_600_000),
    );

    const current = await fixture.activateAccount(
      `replacement-${randomUUID()}`,
    );
    expect(current.accountSourceId).not.toBe(
      job.scope.subscription.accountSourceId,
    );
    server.use(
      http.get("https://chatgpt.com/backend-api/wham/usage", () => {
        return HttpResponse.json({
          rate_limit: { primary_window: { used_percent: 0 } },
        });
      }),
    );
    const result = await job.work();
    expect(result.outcome).toBe("dispatched");
    if (result.outcome !== "dispatched") {
      throw new Error("Expected dispatch");
    }
    const execution = await claimPhase2Execution(
      publicScopeContext,
      result.runId,
    );
    fixture.registerClaim(result.runId, execution.sandboxToken);
    if (!execution.encryptedSecrets) {
      throw new Error("Expected current credentials");
    }
    const auth = await createFirewallApi(
      publicScopeContext,
    ).requestFirewallAuth(
      { authorization: `Bearer ${execution.sandboxToken}` },
      {
        encryptedSecrets: execution.encryptedSecrets,
        authHeaders: {
          "x-selected-token": secretTemplate("CHATGPT_ACCESS_TOKEN"),
          "x-selected-account": secretTemplate("CHATGPT_ACCOUNT_ID"),
        },
        secretConnectorMap: execution.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          execution.secretConnectorMetadataMap ?? undefined,
      },
      [200],
    );
    if (auth.status !== 200) {
      throw new Error("Expected current-account firewall authorization");
    }
    expect(auth.body.headers).toMatchObject({
      "x-selected-token": current.oauth.oauthTokenResponses[0]?.access_token,
      "x-selected-account": current.identity,
    });
  });
});

describe("Phase 2 new-run quota boundary", () => {
  it.each(nativeMemoryQuotaCases)(
    "$name",
    async ({ payload, raw, status, reason }) => {
      const fixture = createPublicPiMemorySource(publicScopeContext);
      await fixture.run(async () => {
        const job = await createPublicPhase2WorkerFixture(
          fixture,
          new Date(now() + 24 * 3_600_000),
        );

        const baseline = await observePublicUsage(
          publicScopeContext,
          fixture.actor,
        );
        expect(baseline.record.rows).toStrictEqual([]);
        expect(baseline.members).toStrictEqual([]);
        const metadata: Headers[] = [];
        let modelRequests = 0;
        server.use(
          http.post("https://chatgpt.com/backend-api/codex/responses", () => {
            modelRequests++;
            return new HttpResponse(null, { status: 500 });
          }),
          http.get(
            "https://chatgpt.com/backend-api/wham/usage",
            ({ request }) => {
              metadata.push(request.headers);
              return new HttpResponse(raw ?? JSON.stringify(payload), {
                status: status ?? 200,
                headers: { "content-type": "application/json" },
              });
            },
          ),
        );
        if (reason) {
          await expect(job.work()).resolves.toMatchObject({
            outcome: "failed",
            errorClass: reason,
          });
          await expect(publicMaintenanceRuns(fixture)).resolves.toStrictEqual(
            [],
          );
          expect(modelRequests).toBe(0);
          await expect(
            observePublicUsage(publicScopeContext, fixture.actor),
          ).resolves.toStrictEqual(baseline);
          await expect(
            publicMemoryVersion(fixture, job.scope.sourceAgentId),
          ).resolves.toBe(job.scope.sourceMemoryVersionId);
        } else {
          const result = await job.work();
          expect(result.outcome).toBe("dispatched");
        }
        expect(metadata).toHaveLength(1);
        expect(metadata[0]?.get("authorization")).toBe(
          `Bearer ${job.scope.subscription.oauth.oauthTokenResponses[0]?.access_token}`,
        );
        expect(metadata[0]?.get("chatgpt-account-id")).toBe(fixture.account);
      });
    },
  );
});

describe("Phase 2 built-in reserves with positive cash", () => {
  it.each(builtinMemoryQuotaCases)("%s", async (scenario) => {
    const job = await createPhase2WorkerFixture("builtin-quota");
    await insertPhase2Candidates(
      job.scope,
      [{ piSessionId: randomUUID() }],
      builtinSource,
    );
    if (
      scenario === "entitlement-stale" ||
      scenario === "unpaid-outside-grace"
    ) {
      // Quota permits stale metadata; canonical launch still reconciles it.
      publicScopeContext.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        status: "canceled",
        items: { data: [] },
      });
    }
    const { denied } = await seedMemoryQuotaCase(
      job.scope,
      new Date("2026-09-05T02:00:00Z"),
      scenario,
    );
    if (denied) {
      await expectNoDispatch(job, "quota_below_threshold");
      await expect(
        db()
          .select({ id: usageEvent.id })
          .from(usageEvent)
          .where(eq(usageEvent.orgId, job.scope.orgId)),
      ).resolves.toStrictEqual([]);
    } else {
      await expect(job.work()).resolves.toMatchObject({
        outcome: "dispatched",
      });
    }
  });
});

test.each(["uncreated-windows", "entitlement-stale", "no-grants"] as const)(
  "quota-only DB read is pure and reports unknown for %s",
  async (scenario) => {
    const job = await createPhase2WorkerFixture("quota-purity");
    const at = nowDate();
    await seedMemoryQuotaCase(job.scope, at, scenario);
    const before = await db()
      .select()
      .from(orgUsageAllowanceEntitlements)
      .where(eq(orgUsageAllowanceEntitlements.orgId, job.scope.orgId));
    const result = await readPiMemoryBuiltinQuota(
      db(),
      job.scope,
      at,
      publicScopeContext.signal,
    );
    expect(result).toMatchObject({
      decision: "unknown",
      reason:
        scenario === "entitlement-stale"
          ? "entitlement_stale"
          : "cash_percentage_unknown",
    });
    await expect(
      db()
        .select()
        .from(orgUsageAllowanceEntitlements)
        .where(eq(orgUsageAllowanceEntitlements.orgId, job.scope.orgId)),
    ).resolves.toStrictEqual(before);
    const windows = await db()
      .select()
      .from(orgUsageAllowanceWindows)
      .where(eq(orgUsageAllowanceWindows.orgId, job.scope.orgId));
    expect(windows).toHaveLength(scenario === "entitlement-stale" ? 1 : 0);
    expect(
      publicScopeContext.mocks.stripe.subscriptions.retrieve,
    ).not.toHaveBeenCalled();
  },
);

test.each([
  "invalid-pool",
  "invalid-pool-masked",
  "invalid-window",
  "db-failure",
] as const)(
  "fails unavailable for %s without fabricated reserves",
  async (fault) => {
    // Infrastructure exception: constraint-violating historical rows and a failed
    // DB transaction cannot be produced by an API. Temporary tables are scoped to
    // one PostgreSQL session, preserving real query/decoder behavior and isolation.
    const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 1 });
    const client = await pool.connect();
    onTestFinished(async () => {
      client.release();
      await pool.end();
    });
    const quotaDb = drizzle(client);
    const owner = { orgId: randomUUID(), userId: randomUUID() };
    await client.query(
      "CREATE TEMP TABLE usage_pack_credit_grants (LIKE public.usage_pack_credit_grants)",
    );
    await client.query(
      "CREATE TEMP TABLE org_usage_allowance_entitlements (LIKE public.org_usage_allowance_entitlements)",
    );
    await client.query(
      "CREATE TEMP TABLE org_usage_allowance_windows (LIKE public.org_usage_allowance_windows)",
    );
    if (fault === "invalid-pool" || fault === "invalid-pool-masked") {
      await client.query(
        "INSERT INTO pg_temp.usage_pack_credit_grants (id, org_id, user_id, grant_type, idempotency_key, original_amount, remaining_amount, created_at, expires_at) VALUES ($1::uuid,$2,$3,'purchased',$1::text,0,0,now()-interval '1 hour',now()+interval '1 hour')",
        [randomUUID(), owner.orgId, owner.userId],
      );
      if (fault === "invalid-pool-masked") {
        await client.query(
          "INSERT INTO pg_temp.usage_pack_credit_grants (id, org_id, user_id, grant_type, idempotency_key, original_amount, remaining_amount, created_at, expires_at) VALUES ($1::uuid,$2,$3,'bonus',$1::text,100,100,now()-interval '1 hour',now()+interval '1 hour')",
          [randomUUID(), owner.orgId, owner.userId],
        );
      }
    } else if (fault === "invalid-window") {
      const id = randomUUID();
      await client.query(
        "INSERT INTO pg_temp.org_usage_allowance_entitlements (id,org_id,source,status,short_window_seconds,short_window_units,weekly_window_seconds,weekly_window_units,effective_at,created_at,updated_at) VALUES ($1,$2,'manual','active',18000,10000,604800,100000,now()-interval '2 hours',now(),now())",
        [id, owner.orgId],
      );
      await client.query(
        "INSERT INTO pg_temp.org_usage_allowance_windows (id,org_id,entitlement_id,kind,starts_at,expires_at,unit_limit,consumed_units,created_at,updated_at) VALUES ($1,$2,$3,'short',now()-interval '1 hour',now()+interval '1 hour',0,0,now(),now())",
        [randomUUID(), owner.orgId, id],
      );
    } else {
      await client.query("BEGIN");
      await expect(client.query("SELECT 1 / 0")).rejects.toThrow(
        "division by zero",
      );
    }
    await expect(
      checkPiMemoryQuota(
        quotaDb,
        { ...owner, stage: "phase2", source: { providerClass: "builtin" } },
        publicScopeContext.signal,
      ),
    ).rejects.toMatchObject({ errorClass: "quota_unavailable" });
    if (fault === "db-failure") {
      await client.query("ROLLBACK");
    }
  },
);

test("refreshes quota for a new hourly attempt and never re-admits committed recovery", async () => {
  const fixture = createPublicPiMemorySource(publicScopeContext);
  await fixture.run(async () => {
    const job = await createPublicPhase2WorkerFixture(
      fixture,
      new Date(now() + 24 * 3_600_000),
    );
    const native = fixture;
    let used = 90;
    let reads = 0;
    server.use(
      http.get("https://chatgpt.com/backend-api/wham/usage", ({ request }) => {
        if (request.headers.get("chatgpt-account-id") === native.account) {
          reads++;
        }
        return HttpResponse.json({
          rate_limit: { primary_window: { used_percent: used } },
        });
      }),
    );
    const at = nowDate();
    await expect(job.work(at)).resolves.toMatchObject({
      outcome: "failed",
      errorClass: "quota_below_threshold",
    });
    await expect(
      job.work(new Date(at.getTime() + 1000)),
    ).resolves.toMatchObject({
      outcome: "no_work",
    });
    expect(reads).toBe(1);
    used = 75;
    const retryTime = new Date(
      at.getTime() + PI_MEMORY_PHASE2_RETRY_DELAY_MS + 1,
    );
    const retried = await job.work(retryTime);
    expect(retried.outcome).toBe("dispatched");
    expect(reads).toBe(2);
    used = 100;
    await activateAnotherPhase2Codex(publicScopeContext, job.scope);
    await expect(
      job.work(new Date(retryTime.getTime() + 1000)),
    ).resolves.toStrictEqual(retried);
    expect(reads).toBe(2);
  });
});

test.each(["disconnect", "feature", "storage", "token", "cancel"])(
  "preserves the Phase 2 final %s fence after quota I/O",
  async (fault) => {
    const fixture = createPublicPiMemorySource(publicScopeContext, {
      cashCredits: 100_000,
    });
    await fixture.run(async () => {
      const job = await createPublicPhase2WorkerFixture(
        fixture,
        new Date(now() + 24 * 3_600_000),
      );
      const carrier =
        fault === "storage"
          ? await claimOwnedMemoryCarrier(fixture, job.scope.sourceAgentId)
          : undefined;
      const controller = new AbortController();
      let mutated = false;
      server.use(
        http.get("https://chatgpt.com/backend-api/wham/usage", async () => {
          if (fault === "token" && !mutated) {
            mutated = true;
            await fixture.misc.upsertPersonalModelProvider(
              fixture.actor,
              {
                type: "codex-oauth-token",
                authMethod: "auth_json",
                secrets: {
                  CODEX_AUTH_JSON: makeCodexAuthJson({
                    accessToken: makeCodexJwt({
                      exp: Math.floor(now() / 1000) + 7200,
                      identity: "rotated-after-quota",
                    }),
                    accountId: fixture.account,
                    refreshToken: "rotated-refresh",
                  }),
                },
              },
              [200],
            );
          }
          if (fault === "disconnect") {
            await fixture.disconnect(job.scope.subscription.accountSourceId);
          }
          if (fault === "feature") {
            await updateFeatureSwitchesForUser(publicScopeContext, job.scope, {
              [FeatureSwitchKey.PiMemory]: false,
            });
          }
          if (fault === "storage") {
            if (!carrier) {
              throw new Error("Expected real concurrent Memory carrier");
            }
            await commitOwnedCarrierMemory(carrier, "Concurrent quota read");
          }
          if (fault === "cancel") {
            controller.abort();
          }
          return HttpResponse.json({
            rate_limit: { primary_window: { used_percent: 0 } },
          });
        }),
      );
      const work = job.work(
        nowDate(),
        AbortSignal.any([controller.signal, publicScopeContext.signal]),
      );
      if (fault === "cancel") {
        await expect(work).rejects.toMatchObject({ name: "AbortError" });
      } else {
        expect((await work).outcome).toBe("failed");
      }
      await expect(publicMaintenanceRuns(fixture)).resolves.toStrictEqual([]);
      // Original key10 no-dispatch side-effect guard includes pending events,
      // which processed-only public usage reports cannot observe. No extra settlement.
      await expect(
        db()
          .select({ id: usageEvent.id })
          .from(usageEvent)
          .where(eq(usageEvent.orgId, job.scope.orgId)),
      ).resolves.toStrictEqual([]);
      // Original named key10 concurrent input-consumption fence.
      expect((await readPhase2Job(job.scope))?.completedRevision).toBe(0);
    });
  },
);

test.each(["malformed-json", "network", "timeout"])(
  "phase 2 unknown %s preserves canonical admission",
  async (fault) => {
    const fixture = createPublicPiMemorySource(publicScopeContext);
    await fixture.run(async () => {
      const job = await createPublicPhase2WorkerFixture(
        fixture,
        new Date(now() + 24 * 3_600_000),
      );
      server.use(
        http.get(
          "https://chatgpt.com/backend-api/wham/usage",
          async ({ request }) => {
            if (fault === "network") {
              return HttpResponse.error();
            }
            if (fault === "timeout") {
              const deadline = createDeferredPromise<void>(
                publicScopeContext.signal,
              );
              if (request.signal.aborted) {
                deadline.resolve();
              } else {
                request.signal.addEventListener(
                  "abort",
                  () => {
                    deadline.resolve();
                  },
                  { once: true },
                );
              }
              await deadline.promise;
            }
            return new HttpResponse("malformed JSON");
          },
        ),
      );
      await expect(job.work()).resolves.toMatchObject({
        outcome: "dispatched",
      });
    });
  },
  10_000,
); // Includes the real five-second metadata deadline.

test("makes exactly one quota GET and no reset-credit request for a real native model attempt", async () => {
  const fixture = createPublicPiMemorySource(publicScopeContext);
  await fixture.run(async () => {
    const job = await createPublicPhase2WorkerFixture(
      fixture,
      new Date(now() + 24 * 3_600_000),
    );
    const stripeRetrieves =
      publicScopeContext.mocks.stripe.subscriptions.retrieve.mock.calls.length;
    let reads = 0;
    let resetRequests = 0;
    server.use(
      http.get("https://chatgpt.com/backend-api/wham/usage", () => {
        reads++;
        return HttpResponse.json({
          rate_limit: { primary_window: { used_percent: 75 } },
        });
      }),
      http.all(
        /https:\/\/chatgpt\.com\/backend-api\/wham\/rate-limit-reset-credits/u,
        () => {
          resetRequests++;
          return HttpResponse.json({});
        },
      ),
    );
    const result = await job.work(nowDate());
    if (result.outcome !== "dispatched") {
      throw new Error("Expected maintenance run");
    }
    const actual = await executePhase2Runtime(
      publicScopeContext,
      result.runId,
      {
        registerCleanup: fixture.registerCleanup,
        onClaim: (execution) => {
          fixture.registerClaim(result.runId, execution.sandboxToken);
        },
      },
    );
    expect(actual.requests).toHaveLength(3);
    for (const request of actual.requests) {
      expect(request.headers.get("authorization")).toBe(
        `Bearer ${job.scope.subscription.oauth.oauthTokenResponses[0]?.access_token}`,
      );
      expect(request.headers.get("chatgpt-account-id")).toBe(fixture.account);
    }
    expect(reads).toBe(1);
    expect(resetRequests).toBe(0);
    expect(
      publicScopeContext.mocks.stripe.subscriptions.retrieve,
    ).toHaveBeenCalledTimes(stripeRetrieves);
  });
});

test("admits codex-oauth-token with unknown subscription quota independently of an empty wallet", async () => {
  const job = await createPhase2WorkerFixture("unknown-subscription-quota");
  const provider = await createPhase2CodexProvider(
    publicScopeContext,
    job.scope,
  );
  await insertPhase2Candidates(
    job.scope,
    [{ piSessionId: randomUUID(), sourceCompletedAt: nowDate() }],
    provider.binding,
  );
  await seedOrgMetadata({ orgId: job.scope.orgId, tier: "pro", credits: 0 });
  await seedMemoryQuotaCase(job.scope, nowDate(), "pool-zero");
  let quotaReads = 0;
  server.use(
    http.get("https://chatgpt.com/backend-api/wham/usage", () => {
      quotaReads++;
      return HttpResponse.json(
        { error: "quota temporarily unavailable" },
        { status: 503 },
      );
    }),
  );
  const result = await job.work(nowDate());
  expect(result.outcome).toBe("dispatched");
  if (result.outcome !== "dispatched") {
    throw new Error("Expected admitted subscription maintenance");
  }
  const runtime = await executePhase2Runtime(publicScopeContext, result.runId);
  expect(runtime.requests).toHaveLength(3);
  expect(runtime.requests[0]?.body).toMatchObject({ model: "gpt-6-luna" });
  expect(runtime.requests[0]?.url).toBe(
    "https://chatgpt.com/backend-api/codex/responses",
  );
  expect(quotaReads).toBe(1);
});

test("reports a run committed before an abort on the next pass, never as stale", async () => {
  const fixture = createPublicPiMemorySource(publicScopeContext);
  await fixture.run(async () => {
    const job = await createPublicPhase2WorkerFixture(
      fixture,
      new Date(now() + 24 * 3_600_000),
    );

    await fixture.disconnect(job.scope.subscription.accountSourceId);
    await seedBuiltInModelKey(
      publicScopeContext,
      "deepseek-v4.1-flash",
      fixture.registerCleanup,
    );
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      publicScopeContext.signal,
    ]);
    publicScopeContext.mocks.ably.publish.mockImplementation(
      (event: unknown) => {
        if (event === "job") {
          controller.abort();
        }
        return Promise.resolve();
      },
    );
    await expect(job.work(undefined, signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    const committed = await publicMaintenanceRuns(fixture);
    expect(committed).toHaveLength(1);
    const run = committed[0];
    if (!run) {
      throw new Error("Expected the committed run to stay bound");
    }
    fixture.registerRun(run.id);
    await expect(
      createRunsApi(publicScopeContext).readRun(fixture.actor, run.id),
    ).resolves.toMatchObject({ status: "pending" });
    await expect(job.work()).resolves.toStrictEqual({
      outcome: "dispatched",
      runId: run.id,
    });
  });
});

test("exhausts quota-denied Phase 2 work after three hourly attempts", async () => {
  const fixture = createPublicPiMemorySource(publicScopeContext);
  await fixture.run(async () => {
    const job = await createPublicPhase2WorkerFixture(
      fixture,
      new Date(now() + 24 * 3_600_000),
    );
    const native = fixture;
    let reads = 0;
    server.use(
      http.post("https://auth.openai.com/oauth/token", () => {
        return HttpResponse.json({
          access_token: makeCodexJwt({
            exp: Math.floor(now() / 1000) + 86_400,
            identity: "quota-retry",
          }),
          refresh_token: "refresh-quota-retry",
          expires_in: 86_400,
          id_token: makeCodexJwt({
            "https://api.openai.com/auth": {
              chatgpt_account_id: native.account,
              chatgpt_plan_type: "plus",
            },
          }),
        });
      }),
      http.get("https://chatgpt.com/backend-api/wham/usage", () => {
        reads++;
        return HttpResponse.json({ rate_limit: { allowed: false } });
      }),
    );
    const at = nowDate();
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(
        job.work(
          new Date(
            at.getTime() + attempt * (PI_MEMORY_PHASE2_RETRY_DELAY_MS + 1),
          ),
        ),
      ).resolves.toMatchObject({
        outcome: "failed",
        errorClass: "quota_limit_reached",
      });
    }
    await expect(
      job.work(new Date(at.getTime() + 4 * PI_MEMORY_PHASE2_RETRY_DELAY_MS)),
    ).resolves.toMatchObject({ outcome: "no_work" });
    expect(reads).toBe(3);
    expect(
      (
        await createRunReadsApi(publicScopeContext).requestListLogs(
          fixture.actor,
          { triggerSource: "agent", limit: 50 },
          [200],
        )
      ).body.data,
    ).toStrictEqual([]);
  });
});

test("requires ordinary credit admission before builtin quota", async () => {
  expect.hasAssertions();
  const job = await createPhase2WorkerFixture("ordinary-credit-admission");
  await insertPhase2Candidates(
    job.scope,
    [{ piSessionId: randomUUID() }],
    builtinSource,
  );
  await seedOrgMetadata({ orgId: job.scope.orgId, tier: "pro", credits: 0 });
  await expectNoDispatch(job, "source_admission_denied");
});
