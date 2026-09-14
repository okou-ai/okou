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
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { db } from "../../../lib/db";
import { mockOptionalEnv } from "../../../lib/env";
import { withMockNowForTest } from "../../../lib/time";
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
  insertPhase2Candidates,
  insertPhase2StorageVersion,
  readPhase2Job,
  setPhase2StorageHead,
} from "./pi-memory-phase2-job.test-fixture";

async function deleteRunSessionsForScope(scope: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  const sessions = await db()
    .select({ id: agentRuns.sessionId })
    .from(agentRuns)
    .where(
      and(eq(agentRuns.orgId, scope.orgId), eq(agentRuns.userId, scope.userId)),
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
