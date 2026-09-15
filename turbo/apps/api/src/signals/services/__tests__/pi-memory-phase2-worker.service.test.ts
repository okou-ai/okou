import { readPiMemoryBuiltinQuota } from "../pi-memory-builtin-quota.service";
import { checkPiMemoryQuota } from "../pi-memory-quota.service";
import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
} from "@okouai/db/schema/org-usage-allowance";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env, mockOptionalEnv } from "../../../lib/env";
import {
  builtinMemoryQuotaCases,
  seedMemoryQuotaCase,
} from "../../../test-fixtures/pi-memory-builtin-quota";
import { nativeMemoryQuotaCases } from "../../../test-fixtures/pi-memory-quota";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { randomUUID } from "node:crypto";
import { PI_MEMORY_ROOT } from "@okouai/api-contracts/contracts/runners";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { checkpoints } from "@okouai/db/schema/checkpoint";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storageVersionLineage } from "@okouai/db/schema/storage-version-lineage";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { conversations } from "@okouai/db/schema/agent-run-session-conversation";
import { createStore } from "ccstate";
import { createDeferredPromise } from "../../utils";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it, onTestFinished } from "vitest";
import { holdAgentRunRowLockFixture } from "../../../test-fixtures/chat-events";
import { countWaitingPersonalSubscriptionMutationsFixture } from "../../../test-fixtures/personal-subscription";
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
  failPiMemoryPhase2Job,
  PI_MEMORY_PHASE2_RETRY_DELAY_MS,
} from "../pi-memory-phase2-job.service";
import { handlePiMemoryPhase2MaintenanceCallback } from "../pi-memory-phase2-maintenance.service";
import { executePiMemoryPhase2Work$ } from "../pi-memory-phase2-worker.service";
import { computeContentHashFromHashes } from "../storage-content-hash.service";
import { prepareStorageUploadForAuth$ } from "../storage-write.service";
import {
  createPhase2TestScope,
  insertPendingPhase2Job,
  insertPhase2CandidatesWithSources as insertPhase2Candidates,
  insertPhase2StorageVersion,
  readPhase2Job,
  setPhase2StorageHead,
  insertPhase2Candidates as insertMissingSourceCandidates,
  type Phase2SourceBinding,
} from "./pi-memory-phase2-job.test-fixture";
import {
  createPhase2Provider,
  phase2ApiKeyRoutes,
  disconnectPhase2Codex,
  activateAnotherPhase2Codex,
} from "../../../test-fixtures/pi-memory-phase2-credential";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { modelProviderSurfaces } from "@okouai/db/schema/model-provider-gateway";
import { createBddApi } from "../../routes/__tests__/helpers/api-bdd";
import { createMiscRoutesApi } from "../../routes/__tests__/helpers/api-bdd-misc";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import {
  makeCodexJwt,
  makeCodexAuthJson,
} from "../../routes/__tests__/helpers/api-bdd-auth-device";
import { executePhase2Runtime } from "../../../test-fixtures/__tests__/pi-memory-phase2-runtime";
import { useSecretKmsProbe } from "../../routes/__tests__/helpers/secret-kms-probe";

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
  await updateFeatureSwitchesForUser(testContext(), actor, {
    [FeatureSwitchKey.PiMemory]: true,
  });
  onTestFinished(async () => {
    await deleteFeatureSwitchesForUser(testContext(), actor);
  });
}

describe("Pi memory Phase 2 sandbox dispatcher", () => {
  it("releases a switch-off job with pi_memory_disabled and dispatches nothing", async () => {
    const now = new Date("2026-09-05T02:00:00.000Z");
    const scope = await createPhase2TestScope("sandbox-pi-memory-disabled", {
      emptyBase: true,
    });
    onTestFinished(async () => {
      await deleteRunSessionsForScope(scope);
    });
    await seedOrgMetadata({
      orgId: scope.orgId,
      tier: "pro",
      credits: 100_000,
    });
    await seedBuiltInModelKey(testContext(), "gpt-5.6-terra");
    await insertPhase2Candidates(scope, [
      {
        piSessionId: randomUUID(),
        rawMemory: "candidate waits while the owner has PiMemory off",
      },
    ]);
    await insertPendingPhase2Job(scope, { updatedAt: now });
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    const store = createStore();

    await expect(
      withMockNowForTest(now, async () => {
        return await store.set(
          executePiMemoryPhase2Work$,
          { scope, currentTime: now },
          testContext().signal,
        );
      }),
    ).resolves.toStrictEqual({
      outcome: "failed",
      errorClass: "pi_memory_disabled",
    });
    await expect(
      db()
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.triggerSource, "agent"),
            eq(agentRuns.orgId, scope.orgId),
            eq(agentRuns.userId, scope.userId),
          ),
        ),
    ).resolves.toStrictEqual([]);
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "retryable_failure",
      maintenanceRunId: null,
      leaseToken: null,
      sandboxLeaseToken: null,
      retryCount: 1,
      retryAt: new Date(now.getTime() + PI_MEMORY_PHASE2_RETRY_DELAY_MS),
      lastErrorClass: "pi_memory_disabled",
    });
    const [candidate] = await db()
      .select({ rawMemory: piMemoryStage1Candidates.rawMemory })
      .from(piMemoryStage1Candidates)
      .where(
        eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
      );
    expect(candidate?.rawMemory).toBe(
      "candidate waits while the owner has PiMemory off",
    );

    // Enabling exactly this owner lets the due retry dispatch as before.
    await enablePiMemoryForScope(scope);
    const retryTime = new Date(
      now.getTime() + PI_MEMORY_PHASE2_RETRY_DELAY_MS + 1,
    );
    const retried = await withMockNowForTest(retryTime, async () => {
      return await store.set(
        executePiMemoryPhase2Work$,
        { scope, currentTime: retryTime },
        testContext().signal,
      );
    });
    expect(retried.outcome).toBe("dispatched");
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "leased",
      retryCount: 1,
      retryAt: null,
      lastErrorClass: null,
    });
  });

  it("does not claim when no control job is ready", async () => {
    const scope = await createPhase2TestScope("sandbox-no-work", {
      emptyBase: true,
    });
    const store = createStore();
    const result = await store.set(
      executePiMemoryPhase2Work$,
      { scope, currentTime: new Date("2026-09-05T02:00:00.000Z") },
      testContext().signal,
    );

    expect(result).toStrictEqual({ outcome: "no_work" });
  });

  it("retries a due maintenance_agent_missing job without creating an Agent", async () => {
    const now = new Date("2026-09-05T02:00:00.000Z");
    const scope = await createPhase2TestScope("sandbox-missing-agent-retry", {
      emptyBase: true,
    });
    await enablePiMemoryForScope(scope);
    onTestFinished(async () => {
      await deleteRunSessionsForScope(scope);
    });
    await seedOrgMetadata({
      orgId: scope.orgId,
      tier: "pro",
      credits: 100_000,
    });
    await seedBuiltInModelKey(testContext(), "gpt-5.6-terra");
    const sessionId = randomUUID();
    await insertPhase2Candidates(scope, [
      {
        piSessionId: sessionId,
        rawMemory: "bounded private candidate",
        rolloutSummary: "bounded private evidence",
      },
    ]);
    await insertPendingPhase2Job(scope, {
      status: "retryable_failure",
      retryCount: 1,
      retryAt: new Date(now.getTime() - 1),
      lastErrorClass: "maintenance_agent_missing",
      updatedAt: new Date(now.getTime() - 1),
    });
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    const store = createStore();

    const result = await withMockNowForTest(now, async () => {
      return await store.set(
        executePiMemoryPhase2Work$,
        { scope, currentTime: now },
        testContext().signal,
      );
    });

    expect(result.outcome).toBe("dispatched");
    if (result.outcome !== "dispatched") {
      throw new Error("Expected due retry dispatch");
    }
    await expect(
      store.set(
        executePiMemoryPhase2Work$,
        { scope, currentTime: new Date(now.getTime() + 1) },
        testContext().signal,
      ),
    ).resolves.toStrictEqual({ outcome: "dispatched", runId: result.runId });
    await expect(
      db()
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.triggerSource, "agent"),
            eq(agentRuns.orgId, scope.orgId),
            eq(agentRuns.userId, scope.userId),
          ),
        ),
    ).resolves.toStrictEqual([{ id: result.runId }]);
    const [run] = await db()
      .select({ sessionId: agentRuns.sessionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, result.runId));
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
        .where(eq(agents.orgId, scope.orgId)),
    ).resolves.toStrictEqual([]);
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "leased",
      maintenanceRunId: result.runId,
      retryCount: 1,
      retryAt: null,
      lastErrorClass: null,
    });
    const [candidate] = await db()
      .select({ rawMemory: piMemoryStage1Candidates.rawMemory })
      .from(piMemoryStage1Candidates)
      .where(
        and(
          eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
          eq(piMemoryStage1Candidates.piSessionId, sessionId),
        ),
      );
    expect(candidate?.rawMemory).toBe("bounded private candidate");
  });

  it("recovers an expired bound lease whose maintenance run is missing", async () => {
    const currentTime = new Date("2026-09-05T04:00:00.000Z");
    const scope = await createPhase2TestScope("sandbox-orphaned-run", {
      emptyBase: true,
    });
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
        executePiMemoryPhase2Work$,
        { scope, currentTime },
        testContext().signal,
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

  it("releases the claim when standard run launch preparation fails", async () => {
    const now = new Date("2026-09-05T02:00:00.000Z");
    const scope = await createPhase2TestScope("sandbox-launch-failure", {
      emptyBase: true,
    });
    await enablePiMemoryForScope(scope);
    await seedOrgMetadata({
      orgId: scope.orgId,
      tier: "pro",
      credits: 100_000,
    });
    onTestFinished(async () => {
      await deleteRunSessionsForScope(scope);
    });
    await seedBuiltInModelKey(testContext(), "gpt-5.6-terra");
    await insertPhase2Candidates(scope, [
      {
        piSessionId: randomUUID(),
        rawMemory: "candidate survives failed standard launch preparation",
      },
    ]);
    await insertPendingPhase2Job(scope, { updatedAt: now });
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", undefined);
    const store = createStore();

    await expect(
      withMockNowForTest(now, async () => {
        return await store.set(
          executePiMemoryPhase2Work$,
          { scope, currentTime: now },
          testContext().signal,
        );
      }),
    ).resolves.toStrictEqual({
      outcome: "failed",
      errorClass: "maintenance_dispatch_failed",
    });
    const [failedRun] = await db()
      .select({
        status: agentRuns.status,
        error: agentRuns.error,
        storageMounts: agentRuns.storageMounts,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.triggerSource, "agent"),
          eq(agentRuns.orgId, scope.orgId),
          eq(agentRuns.userId, scope.userId),
        ),
      );
    expect(failedRun).toMatchObject({
      status: "failed",
      error: expect.stringContaining("RUNNER_DEFAULT_GROUP"),
      storageMounts: null,
    });
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
    await db().insert(agentRuns).values({
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
    await seedBuiltInModelKey(testContext(), "gpt-5.6-terra");
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
        executePiMemoryPhase2Work$,
        { scope, currentTime: now },
        testContext().signal,
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
        testContext().signal,
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
      executePiMemoryPhase2Work$,
      { scope, currentTime: afterOriginalLease },
      testContext().signal,
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
async function createPhase2WorkerFixture(label: string, emptyBase = true) {
  const scope = await createPhase2TestScope(label, { emptyBase });
  await enablePiMemoryForScope(scope);
  await seedOrgMetadata({ orgId: scope.orgId, tier: "pro", credits: 100_000 });
  await seedBuiltInModelKey(testContext(), "gpt-5.6-terra");
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
      signal = testContext().signal,
    ) {
      return await withMockNowForTest(at, async () => {
        return await store.set(
          executePiMemoryPhase2Work$,
          { scope, currentTime: at },
          signal,
        );
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

describe("Phase 2 complete source credential admission", () => {
  it.each([true, false])(
    "defers empty-selection cleanup/repair for emptyBase=%s with three hourly attempts",
    async (emptyBase) => {
      const job = await createPhase2WorkerFixture(
        "empty-credentials",
        emptyBase,
      );
      await expectNoDispatch(job, "source_credentials_missing");
      expect(testContext().mocks.s3.getSignedUrl).not.toHaveBeenCalled();
      for (let attempt = 2; attempt <= 3; attempt++) {
        const at = new Date(
          new Date("2026-09-05T02:00:00Z").getTime() +
            (attempt - 1) * PI_MEMORY_PHASE2_RETRY_DELAY_MS,
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
    },
  );

  it.each(["same-type-account", "scope", "builtin-byok"])(
    "rejects the whole %s selection",
    async (kind) => {
      expect.hasAssertions();
      const job = await createPhase2WorkerFixture(`mixed-${kind}`);
      const provider = await createPhase2Provider(
        testContext(),
        job.scope,
        "openai-api-key",
      );
      const second =
        kind === "builtin-byok"
          ? builtinSource
          : {
              ...provider.binding,
              ...(kind === "scope"
                ? { modelProviderCredentialScope: "member" }
                : { modelProviderId: randomUUID() }),
            };
      await insertPhase2Candidates(
        job.scope,
        [{ piSessionId: randomUUID() }],
        provider.binding,
      );
      await insertPhase2Candidates(
        job.scope,
        [{ piSessionId: randomUUID() }],
        second,
      );
      await expectNoDispatch(job, "mixed_source_credentials");
    },
  );

  it("normalizes legitimate built-in null/org scopes across all sources", async () => {
    const job = await createPhase2WorkerFixture("builtin-representations");
    await insertPhase2Candidates(
      job.scope,
      [{ piSessionId: randomUUID() }],
      builtinSource,
    );
    await insertPhase2Candidates(job.scope, [{ piSessionId: randomUUID() }], {
      ...builtinSource,
      modelProviderCredentialScope: "org",
    });
    const result = await job.work();
    expect(result.outcome).toBe("dispatched");
    if (result.outcome !== "dispatched") {
      throw new Error("Expected maintenance");
    }
    await expect(
      db()
        .select({
          type: agentRuns.modelProvider,
          id: agentRuns.modelProviderId,
          scope: agentRuns.modelProviderCredentialScope,
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, result.runId)),
    ).resolves.toStrictEqual([{ type: "built-in", id: null, scope: "org" }]);
  });

  it("rejects a missing historical successful source", async () => {
    expect.hasAssertions();
    const job = await createPhase2WorkerFixture("missing-source");
    await insertMissingSourceCandidates(job.scope, [
      { piSessionId: randomUUID() },
    ]);
    await expectNoDispatch(job, "source_missing");
  });

  it.each([
    {
      modelProvider: null,
      modelProviderId: null,
      modelProviderCredentialScope: null,
      reason: "source_binding_invalid",
    },
    {
      modelProvider: "built-in",
      modelProviderId: randomUUID(),
      modelProviderCredentialScope: "org",
      reason: "source_binding_invalid",
    },
    {
      modelProvider: "openai-api-key",
      modelProviderId: randomUUID(),
      modelProviderCredentialScope: null,
      reason: "source_scope_mismatch",
    },
    {
      modelProvider: "codex-oauth-token",
      modelProviderId: randomUUID(),
      modelProviderCredentialScope: "org",
      reason: "source_scope_mismatch",
    },
    {
      modelProvider: "openai-api-key",
      modelProviderId: randomUUID(),
      modelProviderCredentialScope: "org",
      reason: "credential_unavailable",
    },
  ])(
    "rejects invalid provenance $reason/$modelProvider",
    async ({ reason, ...binding }) => {
      expect.hasAssertions();
      const job = await createPhase2WorkerFixture("invalid-source");
      await insertPhase2Candidates(
        job.scope,
        [{ piSessionId: randomUUID() }],
        binding,
      );
      await expectNoDispatch(job, reason);
    },
  );

  it("rejects a custom surface with only a Luna mapping", async () => {
    expect.hasAssertions();
    const job = await createPhase2WorkerFixture("luna-only");
    const provider = await createPhase2Provider(
      testContext(),
      job.scope,
      "custom-openai-responses",
      "org",
      { mapsTerra: false },
    );
    await insertPhase2Candidates(
      job.scope,
      [{ piSessionId: randomUUID() }],
      provider.binding,
    );
    await expectNoDispatch(job, "provider_model_unsupported");
  });

  it.each([
    "non-first-source",
    "storage-head",
    "switch",
    "rotation",
    "replacement",
    "surface",
  ])("fences %s changes during asynchronous preparation", async (fault) => {
    const job = await createPhase2WorkerFixture(`race-${fault}`);
    const provider = await createPhase2Provider(
      testContext(),
      job.scope,
      fault === "surface" ? "custom-openai-responses" : "openai-api-key",
    );
    const sourceIds = [randomUUID(), randomUUID()].sort();
    await insertPhase2Candidates(
      job.scope,
      sourceIds.map((sourceRunId) => {
        return {
          piSessionId: randomUUID(),
          sourceRunId,
        };
      }),
      provider.binding,
    );
    let changed = false;
    let expectedHead = job.scope.baseVersion.versionId;
    testContext().mocks.s3.getSignedUrl.mockImplementation(async () => {
      if (!changed) {
        changed = true;
        if (fault === "non-first-source") {
          await db()
            .update(agentRuns)
            .set({ modelProviderCredentialScope: "member" })
            .where(eq(agentRuns.id, sourceIds[1] as string));
        } else if (fault === "storage-head") {
          const version = await insertPhase2StorageVersion(
            job.scope,
            "external",
          );
          await setPhase2StorageHead(job.scope, version);
          expectedHead = version.versionId;
        } else if (fault === "switch") {
          await updateFeatureSwitchesForUser(testContext(), job.scope, {
            [FeatureSwitchKey.PiMemory]: false,
          });
        } else if (fault === "surface") {
          await db()
            .update(modelProviderSurfaces)
            .set({ modelMappings: { "gpt-5.6-terra": "replacement-alias" } })
            .where(
              eq(modelProviderSurfaces.id, provider.binding.modelProviderId),
            );
        } else {
          const actor = createBddApi(testContext()).user({
            ...job.scope,
            orgRole: "org:admin",
          });
          const api = createMiscRoutesApi(testContext());
          if (fault === "replacement") {
            await api.deleteOrgModelProvider(actor, "openai-api-key", [204]);
          }
          await api.upsertOrgModelProvider(
            actor,
            { type: "openai-api-key", secret: "rotated-source-key" },
            [200, 201],
          );
        }
      }
      return "https://objects.example.test/prepared";
    });
    await expectNoDispatch(
      job,
      fault === "non-first-source"
        ? "source_binding_invalid"
        : fault === "switch"
          ? "pi_memory_disabled"
          : fault === "storage-head"
            ? "storage_binding_changed"
            : "credential_unavailable",
      fault === "storage-head" ? null : expectedHead,
    );
    expect(changed).toBeTruthy();
  });

  it("uses a surviving rotated key while ignoring a changed default", async () => {
    const job = await createPhase2WorkerFixture("surviving-key");
    const provider = await createPhase2Provider(
      testContext(),
      job.scope,
      "openai-api-key",
    );
    await insertPhase2Candidates(
      job.scope,
      [{ piSessionId: randomUUID() }],
      provider.binding,
    );
    const actor = createBddApi(testContext()).user({
      ...job.scope,
      orgRole: "org:admin",
    });
    await createMiscRoutesApi(testContext()).upsertOrgModelProvider(
      actor,
      { type: "openai-api-key", secret: "current-same-owner-key" },
      [200],
    );
    await db()
      .update(modelProviders)
      .set({ isDefault: false })
      .where(eq(modelProviders.id, provider.binding.modelProviderId));
    await expect(job.work()).resolves.toMatchObject({ outcome: "dispatched" });
  });
});

test("does not admit a subscription disconnected during preparation", async () => {
  const job = await createPhase2WorkerFixture("disconnect-before-admission");
  const provider = await createPhase2Provider(
    testContext(),
    job.scope,
    "codex-oauth-token",
    "member",
  );
  await insertPhase2Candidates(
    job.scope,
    [{ piSessionId: randomUUID() }],
    provider.binding,
  );
  let disconnected = false;
  testContext().mocks.s3.getSignedUrl.mockImplementation(async () => {
    if (!disconnected) {
      disconnected = true;
      await disconnectPhase2Codex(
        testContext(),
        job.scope,
        provider.binding.modelProviderId,
      );
    }
    return "https://objects.example.test/prepared";
  });
  // Final admission rejects disconnected accounts after all source-row locks.
  await expectNoDispatch(job, "credential_unavailable");
  expect(disconnected).toBeTruthy();
});

test("does not persist or dispatch when preparation is cancelled", async () => {
  const job = await createPhase2WorkerFixture("cancel-before-admission");
  const provider = await createPhase2Provider(
    testContext(),
    job.scope,
    "openai-api-key",
  );
  await insertPhase2Candidates(
    job.scope,
    [{ piSessionId: randomUUID() }],
    provider.binding,
  );
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, testContext().signal]);
  testContext().mocks.s3.getSignedUrl.mockImplementation(() => {
    controller.abort(new Error("Cancelled preparation"));
    return Promise.resolve("https://objects.example.test/cancelled");
  });
  await expect(job.work(undefined, signal)).rejects.toThrow(
    "Cancelled preparation",
  );
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
  await expect(readPhase2Job(job.scope)).resolves.toMatchObject({
    completedRevision: 0,
    maintenanceRunId: null,
  });
});

test.each([false, true])(
  "refreshes the original subscription or rejects revocation=%s",
  async (revoke) => {
    const job = await createPhase2WorkerFixture("refresh-exact-account");
    const account = `account-${randomUUID()}`;
    const provider = await createPhase2Provider(
      testContext(),
      job.scope,
      "codex-oauth-token",
      "member",
      { subscription: { accountId: account, expired: true } },
    );
    await insertPhase2Candidates(
      job.scope,
      [{ piSessionId: randomUUID() }],
      provider.binding,
    );
    await activateAnotherPhase2Codex(testContext(), job.scope);
    const refreshed = makeCodexJwt({
      exp: Math.floor(now() / 1000) + 7200,
      identity: "refreshed-original",
    });
    const quotaHeaders: Headers[] = [];
    server.use(
      http.get("https://chatgpt.com/backend-api/wham/usage", ({ request }) => {
        quotaHeaders.push(request.headers);
        return HttpResponse.json({
          rate_limit: { primary_window: { used_percent: 75 } },
        });
      }),
    );
    const refreshes: string[] = [];
    server.use(
      http.post("https://auth.openai.com/oauth/token", async ({ request }) => {
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
      }),
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
      const actual = await executePhase2Runtime(testContext(), result.runId);
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
      expect(quotaHeaders[0]?.get("authorization")).toBe(`Bearer ${refreshed}`);
      expect(quotaHeaders[0]?.get("chatgpt-account-id")).toBe(account);
    }
  },
);

test("rejects a selected source owned by another Storage owner", async () => {
  expect.hasAssertions();
  const job = await createPhase2WorkerFixture("foreign-source");
  const foreign = await createPhase2TestScope("foreign-owner");
  const sourceRunId = randomUUID();
  await insertPhase2Candidates(foreign, [
    { piSessionId: randomUUID(), sourceRunId },
  ]);
  await insertPhase2Candidates(job.scope, [
    { piSessionId: randomUUID(), sourceRunId },
  ]);
  await expectNoDispatch(job, "source_owner_mismatch");
});

test("lets disconnect finish while final admission waits on a non-first source", async () => {
  const job = await createPhase2WorkerFixture("source-lifecycle-lock-order");
  const provider = await createPhase2Provider(
    testContext(),
    job.scope,
    "codex-oauth-token",
    "member",
  );
  const sourceIds = [randomUUID(), randomUUID()].sort();
  const lastSourceId = sourceIds[1];
  if (!lastSourceId) {
    throw new Error("Expected the non-first source");
  }
  await insertPhase2Candidates(
    job.scope,
    sourceIds.map((sourceRunId) => {
      return { piSessionId: randomUUID(), sourceRunId };
    }),
    provider.binding,
  );
  const entered = createDeferredPromise<void>(testContext().signal);
  let holding: ReturnType<typeof holdAgentRunRowLockFixture> | undefined;
  let held: Awaited<ReturnType<typeof holdAgentRunRowLockFixture>> | undefined;
  testContext().mocks.s3.getSignedUrl.mockImplementation(async () => {
    if (!holding) {
      holding = holdAgentRunRowLockFixture({
        runId: lastSourceId,
        signal: testContext().signal,
      });
    }
    held = await holding;
    if (!entered.settled()) {
      entered.resolve(undefined);
    }
    return "https://objects.example.test/prepared";
  });
  const work = job.work();
  const pending: Promise<unknown>[] = [work];
  onTestFinished(async () => {
    held?.release();
    await held?.done;
    await Promise.all(pending);
  });
  await entered.promise;
  // Observe the real final-admission row wait after asynchronous preparation.
  await expect
    .poll(async () => {
      return held ? await held.waiterCount() : 0;
    })
    .toBeGreaterThan(0);
  let disconnected = false;
  const disconnect = disconnectPhase2Codex(
    testContext(),
    job.scope,
    provider.binding.modelProviderId,
  ).then(() => {
    disconnected = true;
  });
  pending.push(disconnect);
  await expect
    .poll(async () => {
      if (disconnected) {
        return "settled";
      }
      return (await countWaitingPersonalSubscriptionMutationsFixture({
        ...job.scope,
        type: "codex-oauth-token",
      })) > 0
        ? "blocked"
        : "pending";
    })
    .not.toBe("pending");
  expect(disconnected).toBeTruthy();
  held?.release();
  await held?.done;
  await disconnect;
  await expect(work).resolves.toStrictEqual({
    outcome: "failed",
    errorClass: "credential_unavailable",
  });
  await expect(readPhase2Job(job.scope)).resolves.toMatchObject({
    maintenanceRunId: null,
    completedRevision: 0,
    retryCount: 1,
  });
});

describe("Phase 2 new-run source quota boundary", () => {
  it.each(nativeMemoryQuotaCases)(
    "$name",
    async ({ payload, raw, status, reason }) => {
      const job = await createPhase2WorkerFixture("quota");
      const native = await createPhase2Provider(
        testContext(),
        job.scope,
        "codex-oauth-token",
        "member",
      );
      await insertPhase2Candidates(
        job.scope,
        [{ piSessionId: randomUUID() }],
        native.binding,
      );
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
        await expectNoDispatch(job, reason);
        expect(modelRequests).toBe(0);
        await expect(
          db()
            .select({ id: usageEvent.id })
            .from(usageEvent)
            .where(eq(usageEvent.orgId, job.scope.orgId)),
        ).resolves.toStrictEqual([]);
      } else {
        const result = await job.work();
        expect(result.outcome).toBe("dispatched");
        if (result.outcome !== "dispatched") {
          throw new Error("Expected admitted maintenance");
        }
      }
      expect(metadata).toHaveLength(1);
      expect(metadata[0]?.get("authorization")).toBe(`Bearer ${native.key}`);
      expect(metadata[0]?.get("chatgpt-account-id")).toBe(native.account);
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
      testContext().mocks.stripe.subscriptions.retrieve.mockResolvedValue({
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
      testContext().signal,
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
      testContext().mocks.stripe.subscriptions.retrieve,
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
        testContext().signal,
      ),
    ).rejects.toMatchObject({ errorClass: "quota_unavailable" });
    if (fault === "db-failure") {
      await client.query("ROLLBACK");
    }
  },
);

test("refreshes quota for a new hourly attempt and never re-admits committed recovery", async () => {
  const job = await createPhase2WorkerFixture("quota-retry");
  const native = await createPhase2Provider(
    testContext(),
    job.scope,
    "codex-oauth-token",
    "member",
  );
  await insertPhase2Candidates(
    job.scope,
    [{ piSessionId: randomUUID() }],
    native.binding,
  );
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
  await expect(job.work(new Date(at.getTime() + 1000))).resolves.toMatchObject({
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
  await activateAnotherPhase2Codex(testContext(), job.scope);
  await expect(
    job.work(new Date(retryTime.getTime() + 1000)),
  ).resolves.toStrictEqual(retried);
  expect(reads).toBe(2);
});

test.each(["disconnect", "feature", "source", "storage", "token", "cancel"])(
  "preserves the Phase 2 final %s fence after quota I/O",
  async (fault) => {
    const job = await createPhase2WorkerFixture("post-quota-race");
    const native = await createPhase2Provider(
      testContext(),
      job.scope,
      "codex-oauth-token",
      "member",
    );
    await insertPhase2Candidates(
      job.scope,
      [{ piSessionId: randomUUID() }],
      native.binding,
    );
    const controller = new AbortController();
    onTestFinished(() => {
      return controller.abort();
    });
    let mutated = false;
    server.use(
      http.get("https://chatgpt.com/backend-api/wham/usage", async () => {
        if (fault === "token" && !mutated) {
          mutated = true;
          await createMiscRoutesApi(testContext()).upsertPersonalModelProvider(
            createBddApi(testContext()).user({
              ...job.scope,
              orgRole: "org:admin",
            }),
            {
              type: "codex-oauth-token",
              authMethod: "auth_json",
              secrets: {
                CODEX_AUTH_JSON: makeCodexAuthJson({
                  accessToken: makeCodexJwt({
                    exp: Math.floor(now() / 1000) + 7200,
                    identity: "rotated-after-quota",
                  }),
                  accountId: native.account as string,
                  refreshToken: "rotated-refresh",
                }),
              },
            },
            [200],
          );
        }
        if (fault === "disconnect") {
          await disconnectPhase2Codex(
            testContext(),
            job.scope,
            native.binding.modelProviderId,
          );
        }
        if (fault === "feature") {
          await updateFeatureSwitchesForUser(testContext(), job.scope, {
            [FeatureSwitchKey.PiMemory]: false,
          });
        }
        if (fault === "source") {
          await db()
            .update(agentRuns)
            .set({ modelProviderId: randomUUID() })
            .where(eq(agentRuns.orgId, job.scope.orgId));
        }
        if (fault === "storage") {
          const version = await insertPhase2StorageVersion(
            job.scope,
            "concurrent quota read",
          );
          await setPhase2StorageHead(job.scope, version);
        }
        if (fault === "cancel") {
          controller.abort();
        }
        return HttpResponse.json({
          rate_limit: { primary_window: { used_percent: 0 } },
        });
      }),
    );
    const work = job.work(nowDate(), controller.signal);
    if (fault === "cancel") {
      await expect(work).rejects.toMatchObject({ name: "AbortError" });
    } else {
      expect((await work).outcome).toBe("failed");
    }
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
    await expect(
      db()
        .select({ id: usageEvent.id })
        .from(usageEvent)
        .where(eq(usageEvent.orgId, job.scope.orgId)),
    ).resolves.toStrictEqual([]);
    expect((await readPhase2Job(job.scope))?.completedRevision).toBe(0);
  },
);

test.each(["malformed-json", "network", "timeout"])(
  "phase 2 unknown %s preserves canonical admission",
  async (fault) => {
    const job = await createPhase2WorkerFixture("unknown-quota");
    const native = await createPhase2Provider(
      testContext(),
      job.scope,
      "codex-oauth-token",
      "member",
    );
    await insertPhase2Candidates(
      job.scope,
      [{ piSessionId: randomUUID() }],
      native.binding,
    );
    server.use(
      http.get(
        "https://chatgpt.com/backend-api/wham/usage",
        async ({ request }) => {
          if (fault === "network") {
            return HttpResponse.error();
          }
          if (fault === "timeout") {
            const deadline = createDeferredPromise<void>(testContext().signal);
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
    await expect(job.work()).resolves.toMatchObject({ outcome: "dispatched" });
  },
  10_000,
); // Includes the real five-second metadata deadline.

test("makes exactly one quota GET and no reset-credit request for a real native model attempt", async () => {
  const job = await createPhase2WorkerFixture("native-quota-purity");
  const native = await createPhase2Provider(
    testContext(),
    job.scope,
    "codex-oauth-token",
    "member",
  );
  await insertPhase2Candidates(
    job.scope,
    [{ piSessionId: randomUUID() }],
    native.binding,
  );
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
  const actual = await executePhase2Runtime(testContext(), result.runId);
  expect(actual.requests).toHaveLength(3);
  for (const request of actual.requests) {
    expect(request.headers.get("authorization")).toBe(`Bearer ${native.key}`);
    expect(request.headers.get("chatgpt-account-id")).toBe(native.account);
  }
  expect(reads).toBe(1);
  expect(resetRequests).toBe(0);
  expect(
    testContext().mocks.stripe.subscriptions.retrieve,
  ).not.toHaveBeenCalled();
});

test.each([
  ...phase2ApiKeyRoutes,
  {
    type: "custom-openai-responses" as const,
    url: "https://phase2-gateway.example/v1/responses",
    model: "mapped-terra",
  },
])(
  "admits $type with unknown vendor quota independently of an empty wallet",
  async ({ type, url, model }) => {
    const job = await createPhase2WorkerFixture("unknown-api-key-quota");
    const provider = await createPhase2Provider(testContext(), job.scope, type);
    await insertPhase2Candidates(
      job.scope,
      [{ piSessionId: randomUUID() }],
      provider.binding,
    );
    await seedOrgMetadata({ orgId: job.scope.orgId, tier: "pro", credits: 0 });
    await seedMemoryQuotaCase(job.scope, nowDate(), "pool-zero");
    let quotaReads = 0;
    server.use(
      http.get("https://chatgpt.com/backend-api/wham/usage", () => {
        quotaReads++;
        return HttpResponse.json({ rate_limit: { allowed: false } });
      }),
    );
    const result = await job.work(nowDate());
    expect(result.outcome).toBe("dispatched");
    if (result.outcome !== "dispatched") {
      throw new Error("Expected admitted API-key maintenance");
    }
    const runtime = await executePhase2Runtime(testContext(), result.runId);
    expect(runtime.requests).toHaveLength(3);
    expect(runtime.requests[0]?.body).toMatchObject({ model });
    expect(runtime.requests[0]?.url).toBe(url);
    expect(quotaReads).toBe(0);
  },
);

test("exhausts quota-denied Phase 2 work after three hourly attempts", async () => {
  const job = await createPhase2WorkerFixture("quota-max3");
  const native = await createPhase2Provider(
    testContext(),
    job.scope,
    "codex-oauth-token",
    "member",
  );
  await insertPhase2Candidates(
    job.scope,
    [{ piSessionId: randomUUID() }],
    native.binding,
  );
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
  await expect(readPhase2Job(job.scope)).resolves.toMatchObject({
    retryCount: 3,
    maintenanceRunId: null,
    completedRevision: 0,
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

test("admits native maintenance without asking KMS under the organization admission lock", async () => {
  const job = await createPhase2WorkerFixture("quota-proof-lock-ownership");
  const native = await createPhase2Provider(
    testContext(),
    job.scope,
    "codex-oauth-token",
    "member",
  );
  await insertPhase2Candidates(
    job.scope,
    [{ piSessionId: randomUUID() }],
    native.binding,
  );
  // Infrastructure exception: only a real separate PostgreSQL connection can
  // observe the admission lock during an external KMS callback. The transaction
  // lock is released when this single probe statement commits, without waiting.
  const lockProbe = new Pool({ connectionString: env("DATABASE_URL"), max: 1 });
  onTestFinished(async () => {
    await lockProbe.end();
  });
  useSecretKmsProbe(undefined, async () => {
    const result = await lockProbe.query<{ available: unknown }>(
      "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS available",
      [job.scope.orgId],
    );
    if (result.rows[0]?.available !== true) {
      throw new Error("KMS requested while organization admission is locked");
    }
    return Buffer.from("0123456789abcdef0123456789abcdef");
  });
  server.use(
    http.get("https://chatgpt.com/backend-api/wham/usage", () => {
      return HttpResponse.json({
        rate_limit: { primary_window: { used_percent: 75 } },
      });
    }),
  );
  const result = await job.work(nowDate());
  expect(result.outcome).toBe("dispatched");
  if (result.outcome !== "dispatched") {
    throw new Error("Expected native maintenance");
  }
  const runtime = await executePhase2Runtime(testContext(), result.runId);
  expect(runtime.requests).toHaveLength(3);
  expect(runtime.requests[0]?.headers.get("authorization")).toBe(
    `Bearer ${native.key}`,
  );
  expect(runtime.requests[0]?.headers.get("chatgpt-account-id")).toBe(
    native.account,
  );
});
