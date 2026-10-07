import { cleanupSandboxFixturesForTest } from "../../../test-fixtures/sandbox-cleanup-worker";
import { settleIncludingAbort } from "../../utils";
import { createChatFilesBddApi } from "../../routes/__tests__/helpers/api-bdd-chat-files";
import { createWebhookCallbackApi } from "../../routes/__tests__/helpers/api-bdd-webhooks";
import {
  createFirewallApi,
  secretTemplate,
} from "../../routes/__tests__/helpers/api-bdd-firewall";
import {
  expectCanonicalStorageManifest,
  createRunsApi,
} from "../../routes/__tests__/helpers/api-bdd-runs";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createPublicPiMemorySource } from "../../routes/__tests__/helpers/public-pi-memory-source";
import { createHash, randomUUID } from "node:crypto";
import { webhookUsageEventContract } from "@okouai/api-contracts/contracts/webhooks";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { onTestFinished, describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { db } from "../../../lib/db";
import { mockOptionalEnv } from "../../../lib/env";
import { now, nowDate, withMockNowForTest } from "../../../lib/time";
import {
  seedOrgMetadata,
  createUsagePricingFixture,
} from "../../../test-fixtures/system-config-seeds";
import { generateSandboxToken } from "../../auth/tokens";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "../../routes/__tests__/helpers/feature-switches";
import { seedBuiltInModelKey } from "../../routes/__tests__/helpers/runtime-state";
import { configureNativeCliArtifact } from "../../routes/__tests__/helpers/chat-events-fixture";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../../routes/webhooks-agent-health-usage-telemetry";
import { piMemoryPhase2MaintenanceCallbackPayloadSchema } from "../pi-memory-phase2-maintenance.service";
import {
  PI_MEMORY_PHASE2_BUILT_IN_MODEL,
  PI_MEMORY_PHASE2_PERSONAL_MODEL,
} from "../pi-memory-phase2-usage.service";
import { createPiMemoryPhase2Worker } from "../pi-memory-phase2-worker.service";
import {
  createPhase2TestScope,
  insertPendingPhase2Job,
  insertPhase2CandidatesWithSources as insertPhase2Candidates,
} from "./pi-memory-phase2-job.test-fixture";
import {
  claimPhase2Execution,
  executePhase2Runtime,
} from "../../../test-fixtures/__tests__/pi-memory-phase2-runtime";
import {
  createPhase2CodexProvider,
  disconnectPhase2Codex,
} from "../../../test-fixtures/pi-memory-phase2-credential";

// The original named key10 harness keeps exact corrupt identities and financial
// vectors that public reports do not represent. The legacy constructor below
// remains only for the separately inventoried terminal-fault callback.
const context = testContext();

async function dispatchMaintenance(type?: "codex-oauth-token") {
  const scope = await createPhase2TestScope("usage", { emptyBase: true });
  // PiMemory is off for everyone by default; the dispatcher only runs for
  // owners whose explicit override enables it.
  await updateFeatureSwitchesForUser(
    context,
    { orgId: scope.orgId, userId: scope.userId },
    {
      [FeatureSwitchKey.PiMemory]: true,
    },
  );
  onTestFinished(async () => {
    await deleteFeatureSwitchesForUser(context, {
      orgId: scope.orgId,
      userId: scope.userId,
    });
  });
  await seedOrgMetadata({ orgId: scope.orgId, tier: "pro", credits: 100_000 });
  if (!type) {
    await seedBuiltInModelKey(context, PI_MEMORY_PHASE2_BUILT_IN_MODEL);
  }
  // V4.1 Flash dispatch requires the commit-addressed CLI reader artifact.
  configureNativeCliArtifact();
  const provider = type
    ? await createPhase2CodexProvider(context, scope)
    : undefined;
  const candidates = ["first", "second"].map((name) => {
    return {
      piSessionId: randomUUID(),
      sourceRunId: randomUUID(),
      sourceHistoryHash: createHash("sha256")
        .update(randomUUID())
        .digest("hex"),
      sourceCompletedAt: nowDate(),
      rawMemory: `${name} private candidate`,
      rolloutSummary: `${name} complete evidence`,
    };
  });
  await insertPhase2Candidates(scope, candidates, provider?.binding);
  const currentTime = nowDate();
  await insertPendingPhase2Job(scope, { updatedAt: currentTime });
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  const result = await createStore().set(
    createPiMemoryPhase2Worker(scope).execute$,
    currentTime,
    context.signal,
  );
  if (result.outcome !== "dispatched") {
    throw new Error(`Maintenance dispatch failed: ${result.outcome}`);
  }
  const runId = result.runId;
  const [run] = await db()
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  if (!run) {
    throw new Error("Missing private run");
  }
  onTestFinished(async () => {
    await db().delete(usageEvent).where(eq(usageEvent.orgId, scope.orgId));
    await db().delete(agentSessions).where(eq(agentSessions.id, run.sessionId));
  });
  const [callback] = await db()
    .select()
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, runId));
  const binding = piMemoryPhase2MaintenanceCallbackPayloadSchema.parse(
    callback?.payload,
  );
  return { scope, run, runId, binding, provider };
}

async function launchMaintenance(type?: "codex-oauth-token") {
  const { scope, run, runId, binding, provider } =
    await dispatchMaintenance(type);
  // One proxy flush aggregates two provider responses.
  const events = [
    { category: "tokens.input", quantity: 6 },
    { category: "tokens.output", quantity: 4186 },
    { category: "tokens.cache_read", quantity: 87_690 },
    { category: "tokens.cache_creation", quantity: 48_472 },
  ].map((entry) => {
    return {
      ...entry,
      idempotencyKey: randomUUID(),
      kind: "model" as const,
      provider: type
        ? PI_MEMORY_PHASE2_PERSONAL_MODEL
        : PI_MEMORY_PHASE2_BUILT_IN_MODEL,
    };
  });
  const headers = {
    authorization: `Bearer ${generateSandboxToken(scope.userId, runId, scope.orgId)}`,
  };
  const client = setupApp({
    context,
    routes: webhooksAgentHealthUsageTelemetryRoutes,
  });
  const pricing = await createUsagePricingFixture({
    configured: events.map((event) => {
      return {
        kind: event.kind,
        provider: event.provider,
        category: event.category,
        unitPrice: 1,
        unitSize: 1000,
      };
    }),
  });
  onTestFinished(pricing.cleanup);
  return {
    scope,
    run,
    runId,
    binding,
    events,
    headers,
    provider,
    async proxy() {
      return await accept(
        client(webhookUsageEventContract).send({
          headers,
          body: { runId, events },
        }),
        [200],
      );
    },
    async ledger() {
      return await db()
        .select()
        .from(usageEvent)
        .where(eq(usageEvent.orgId, scope.orgId));
    },
    async cleanup() {
      return await cleanupSandboxFixturesForTest(
        {
          scope: {
            chatThreadIds: [],
            runIds: [runId],
            exportJobIds: [],
          },
          usagePricingResolution: pricing.resolution,
        },
        context.signal,
      );
    },
  };
}

async function launchPublicMaintenance(
  fixture: ReturnType<typeof createPublicPiMemorySource>,
  { type }: { type?: "codex-oauth-token"; credentialScope?: "member" } = {},
) {
  const at = new Date(now() + 24 * 3_600_000);
  const scope = await fixture.prepare(at);
  fixture.installExtractionProvider([
    {
      rawMemory: "first private candidate",
      rolloutSummary: "first complete evidence",
      sourceText: "first complete evidence",
    },
    {
      rawMemory: "second private candidate",
      rolloutSummary: "second complete evidence",
      sourceText: "second complete evidence",
    },
  ]);
  await expect(fixture.extract()).resolves.toMatchObject({
    claimed: 2,
    succeeded: 2,
  });
  await fixture.disconnect(scope.subscription.accountSourceId);
  let provider:
    | Awaited<ReturnType<typeof createPhase2CodexProvider>>
    | undefined;
  if (type) {
    provider = await createPhase2CodexProvider(context, scope, {
      registerCleanup: fixture.registerCleanup,
      miscApi: fixture.misc,
    });
  } else {
    await seedBuiltInModelKey(
      context,
      PI_MEMORY_PHASE2_BUILT_IN_MODEL,
      fixture.registerCleanup,
    );
  }
  const result = await createStore().set(
    createPiMemoryPhase2Worker(scope).execute$,
    at,
    context.signal,
  );
  if (result.outcome !== "dispatched") {
    throw new Error(`Maintenance dispatch failed: ${result.outcome}`);
  }
  const runId = result.runId;
  fixture.registerRun(runId);
  const execution = await claimPhase2Execution(context, runId);
  fixture.registerClaim(runId, execution.sandboxToken);
  const run = await createRunsApi(context).readRun(fixture.actor, runId);
  const events = [
    { category: "tokens.input", quantity: 6 },
    { category: "tokens.output", quantity: 4186 },
    { category: "tokens.cache_read", quantity: 87_690 },
    { category: "tokens.cache_creation", quantity: 48_472 },
  ].map((entry) => {
    return {
      ...entry,
      idempotencyKey: randomUUID(),
      kind: "model" as const,
      provider: type
        ? PI_MEMORY_PHASE2_PERSONAL_MODEL
        : PI_MEMORY_PHASE2_BUILT_IN_MODEL,
    };
  });
  const pricing = await createUsagePricingFixture({
    registerCleanup: fixture.registerCleanup,
    configured: events.map((event) => {
      return {
        kind: event.kind,
        provider: event.provider,
        category: event.category,
        unitPrice: 1,
        unitSize: 1000,
      };
    }),
  });
  const headers = { authorization: `Bearer ${execution.sandboxToken}` };
  const client = setupApp({
    context,
    routes: webhooksAgentHealthUsageTelemetryRoutes,
  });
  const maintenance = execution.piLaunchConfig?.maintenance;
  if (!maintenance) {
    throw new Error("Expected authenticated maintenance identity");
  }
  const binding = piMemoryPhase2MaintenanceCallbackPayloadSchema.parse({
    schemaVersion: 1,
    memoryStorageId: maintenance.memoryStorageId,
    orgId: scope.orgId,
    userId: scope.userId,
    leaseToken: maintenance.leaseToken,
    claimedRevision: maintenance.claimedRevision,
    claimedBaseVersionId: maintenance.claimedBaseVersionId,
    selectionDigest: maintenance.selectionDigest,
    selected: maintenance.selected.map(({ piSessionId, sourceHistoryHash }) => {
      return {
        piSessionId,
        sourceHistoryHash,
      };
    }),
  });
  return {
    scope,
    run,
    provider,
    binding,
    runId,
    execution,
    events,
    headers,
    async proxy() {
      return await accept(
        client(webhookUsageEventContract).send({
          headers,
          body: { runId, events },
        }),
        [200],
      );
    },
    async cleanup() {
      fixture.registerRunDeletion(runId);
      return await cleanupSandboxFixturesForTest(
        {
          scope: { chatThreadIds: [], runIds: [runId], exportJobIds: [] },
          usagePricingResolution: pricing.resolution,
        },
        context.signal,
      );
    },
    async ledger() {
      // Original named Phase2 usage harness: exact financial identity/vector and
      // replay population are not represented by aggregated public usage rows.
      return await db()
        .select()
        .from(usageEvent)
        .where(eq(usageEvent.orgId, scope.orgId));
    },
  };
}

function canonicalLedger(run: {
  readonly events: Awaited<ReturnType<typeof launchMaintenance>>["events"];
  readonly runId: string;
  readonly scope: { readonly orgId: string; readonly userId: string };
}) {
  return expect.arrayContaining(
    run.events.map((event) => {
      return expect.objectContaining({
        ...event,
        runId: run.runId,
        orgId: run.scope.orgId,
        userId: run.scope.userId,
      });
    }),
  );
}

describe("Pi memory Phase 2 proxy billing", () => {
  it("charges one provider vector with concurrent batches and retries", async () => {
    const fixture = createPublicPiMemorySource(context, {
      cashCredits: 100_000,
      sources: ["first complete evidence", "second complete evidence"],
    });
    await fixture.run(async () => {
      const run = await launchPublicMaintenance(fixture);
      await Promise.all([run.proxy(), run.proxy()]);
      await run.proxy();
      await expect(run.ledger()).resolves.toHaveLength(4);
      await expect(run.ledger()).resolves.toStrictEqual(canonicalLedger(run));
    });
  });

  it.each([
    { status: "completed", type: undefined },
    { status: "failed", type: undefined },
    { status: "cancelled", type: undefined },
    { status: "timeout", type: undefined },
    { status: "completed", type: "codex-oauth-token" },
  ] as const)(
    "keeps the $type proxy owner through $status and delayed cleanup",
    async ({ status, type }) => {
      const run = await launchMaintenance(type);
      // Both models stay legitimate forever: the built-in binding dispatches
      // DeepSeek while every personal subscription binding keeps dispatching GPT. The delayed
      // cleanup below only reports `deleted: 0` while the retained binding is
      // still resolvable, so this asserts the full set is honoured.
      expect(run.run.selectedModel).toBe(
        type
          ? PI_MEMORY_PHASE2_PERSONAL_MODEL
          : PI_MEMORY_PHASE2_BUILT_IN_MODEL,
      );
      const completedAt = nowDate();
      // Terminal states, persisted launch snapshots and delayed proxy flushes
      // are infrastructure-only inputs.
      await db()
        .update(agentRuns)
        .set({
          status,
          completedAt,
          launchSnapshot: {
            schemaVersion: 1,
            framework: "pi",
            runnerProfile: "vm0/test",
          },
        })
        .where(eq(agentRuns.id, run.runId));
      await db()
        .update(agentRunCallbacks)
        .set({ status: "delivered" })
        .where(eq(agentRunCallbacks.runId, run.runId));
      await db()
        .delete(runnerJobQueue)
        .where(eq(runnerJobQueue.runId, run.runId));
      await db()
        .update(piMemoryPhase2Jobs)
        .set({ leaseExpiresAt: new Date(completedAt.getTime() - 1) })
        .where(
          eq(piMemoryPhase2Jobs.memoryStorageId, run.scope.memoryStorageId),
        );
      await withMockNowForTest(
        new Date(completedAt.getTime() + 10 * 60_000),
        async () => {
          const cleanup = await run.cleanup();
          expect(cleanup.threadlessRuns.deleted).toBe(0);
          await run.proxy();
          await run.proxy();
          await expect(run.ledger()).resolves.toHaveLength(type ? 0 : 4);
          await expect(run.ledger()).resolves.toStrictEqual(
            type ? [] : canonicalLedger(run),
          );
        },
      );
      // The ordinary terminal lifecycle settles pending charges before cleanup.
      expect(
        (await run.ledger()).every((entry) => {
          return entry.status === "pending";
        }),
      ).toBeTruthy();
      await withMockNowForTest(
        new Date(completedAt.getTime() + 3 * 60 * 60_000),
        async () => {
          expect((await run.cleanup()).threadlessRuns.deleted).toBe(1);
        },
      );
      const ledger = await run.ledger();
      expect(ledger).toHaveLength(type ? 0 : 4);
      expect(
        ledger.every((entry) => {
          return (
            entry.status === "processed" &&
            entry.billingError === null &&
            (entry.creditsCharged ?? 0) > 0
          );
        }),
      ).toBeTruthy();
      expect(
        ledger.every((entry) => {
          return entry.runId === null;
        }),
      ).toBeTruthy();
      // Cleanup only unlinks the private run; billable quantities and keys survive.
      expect(ledger).toStrictEqual(
        expect.arrayContaining(
          (type ? [] : run.events).map((event) => {
            return expect.objectContaining(event);
          }),
        ),
      );
    },
  );

  it.each(["missing-callback", "mismatched-owner", "non-pi", "owned-thread"])(
    "cannot turn %s into a private maintenance billing exemption",
    async (fault) => {
      const fixture = createPublicPiMemorySource(context, {
        cashCredits: 100_000,
        sources: ["first complete evidence", "second complete evidence"],
      });
      await fixture.run(async () => {
        const run = await launchPublicMaintenance(fixture);
        // Original named key10 corruption matrix only; ordinary ownership is public.
        const outcome = await settleIncludingAbort(
          (async () => {
            if (fault === "missing-callback") {
              await db()
                .delete(agentRunCallbacks)
                .where(eq(agentRunCallbacks.runId, run.runId));
            } else if (fault === "mismatched-owner") {
              await db()
                .update(agentRunCallbacks)
                .set({ payload: { ...run.binding, userId: randomUUID() } })
                .where(eq(agentRunCallbacks.runId, run.runId));
            } else if (fault === "owned-thread") {
              const threadId = randomUUID();
              const threads = createChatFilesBddApi(context);
              fixture.registerCleanup(async () => {
                await threads.deleteThread(fixture.actor, threadId);
              });
              await threads.createThread(fixture.actor, {
                agentId: run.scope.sourceAgentId,
                clientThreadId: threadId,
                model: null,
              });
              await db()
                .update(agentRuns)
                .set({ chatThreadId: threadId })
                .where(eq(agentRuns.id, run.runId));
            } else {
              await db()
                .update(agentRuns)
                .set({
                  launchSnapshot: {
                    schemaVersion: 1,
                    framework: "codex",
                    runnerProfile: "vm0/test",
                  },
                })
                .where(eq(agentRuns.id, run.runId));
            }
            await run.proxy();
            await expect(run.ledger()).resolves.toHaveLength(4);
            await expect(run.ledger()).resolves.toStrictEqual(
              canonicalLedger(run),
            );
          })(),
        );
        const restored = await settleIncludingAbort(
          (async () => {
            // Restore the intentionally mismatched capture before real-token cleanup ACK.
            if (fault === "mismatched-owner") {
              await db()
                .update(agentRunCallbacks)
                .set({ payload: run.binding })
                .where(eq(agentRunCallbacks.runId, run.runId));
            }
          })(),
        );
        if (!outcome.ok) {
          throw outcome.error;
        }
        if (!restored.ok) {
          throw restored.error;
        }
      });
    },
  );

  it("executes exact codex-oauth-token/member HTTP and drops replayed model usage", async () => {
    const fixture = createPublicPiMemorySource(context, {
      cashCredits: 100_000,
      sources: ["first complete evidence", "second complete evidence"],
    });
    await fixture.run(async () => {
      const run = await launchPublicMaintenance(fixture, {
        type: "codex-oauth-token",
        credentialScope: "member",
      });
      expect(run.run.source).toMatchObject({
        providerType: "codex-oauth-token",
        model: PI_MEMORY_PHASE2_PERSONAL_MODEL,
        credentialScope: "member",
      });
      expect(run.execution.piSessionId).toBe(run.runId);
      // Original exact financial admission bit has no public response field.
      await expect(
        db()
          .select({ creditAdmitted: agentRuns.creditAdmitted })
          .from(agentRuns)
          .where(eq(agentRuns.id, run.runId)),
      ).resolves.toStrictEqual([{ creditAdmitted: false }]);
      const actual = await executePhase2Runtime(context, run.runId, {
        execution: run.execution,
        registerCleanup: fixture.registerCleanup,
      });
      expect(
        actual.execution.piLaunchConfig?.maintenance?.selected,
      ).toHaveLength(2);
      expect(actual.execution.connectorRuntimeTargets).toStrictEqual([]);
      expect(actual.execution.secretValues).not.toContain(
        actual.execution.sandboxToken,
      );
      expect(actual.requests).toHaveLength(3);
      for (const request of actual.requests) {
        expect(request.url).toBe(
          "https://chatgpt.com/backend-api/codex/responses",
        );
        expect(request.body).toMatchObject({
          model: PI_MEMORY_PHASE2_PERSONAL_MODEL,
          reasoning: { effort: "medium" },
        });
        expect(request.body).not.toHaveProperty("text.format");
        expect(request.body).not.toHaveProperty("service_tier");
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${run.provider?.key}`,
        );
        expect(request.headers.get("chatgpt-account-id")).toBe(
          run.provider?.account,
        );
      }
      await Promise.all([run.proxy(), run.proxy()]);
      await run.proxy();
      await expect(run.ledger()).resolves.toStrictEqual([]);
    });
  });

  it("drops codex-oauth-token usage after a real provider failure", async () => {
    const fixture = createPublicPiMemorySource(context, {
      cashCredits: 100_000,
      sources: ["first complete evidence", "second complete evidence"],
    });
    await fixture.run(async () => {
      const run = await launchPublicMaintenance(fixture, {
        type: "codex-oauth-token",
        credentialScope: "member",
      });
      const actual = await executePhase2Runtime(context, run.runId, {
        failure: true,
        execution: run.execution,
        registerCleanup: fixture.registerCleanup,
      });
      expect(actual.requests).toHaveLength(1);
      await run.proxy();
      await expect(run.ledger()).resolves.toStrictEqual([]);
    });
  });
});

test("retains the committed Codex account and uses the current account for a new retry", async () => {
  const fixture = createPublicPiMemorySource(context, {
    cashCredits: 100_000,
    sources: ["first complete evidence", "second complete evidence"],
  });
  await fixture.run(async () => {
    const run = await launchPublicMaintenance(fixture, {
      type: "codex-oauth-token",
      credentialScope: "member",
    });
    if (!run.provider) {
      throw new Error("Missing subscription fixture");
    }
    await disconnectPhase2Codex(
      context,
      run.scope,
      run.provider.binding.modelProviderId,
    );
    const replacement = await createPhase2CodexProvider(context, run.scope, {
      registerCleanup: fixture.registerCleanup,
      miscApi: fixture.misc,
    });
    expect(replacement.binding.modelProviderId).not.toBe(
      run.provider.binding.modelProviderId,
    );
    const authFor = async (execution: typeof run.execution) => {
      if (!execution.encryptedSecrets) {
        throw new Error("Expected captured credentials");
      }
      const auth = await createFirewallApi(context).requestFirewallAuth(
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
        throw new Error("Expected captured firewall authorization");
      }
      return auth.body.headers;
    };
    await expect(authFor(run.execution)).resolves.toMatchObject({
      "x-selected-token": run.provider.key,
      "x-selected-account": run.provider.account,
    });
    const api = createRunsApi(context);
    await api.requestCancelRun(fixture.actor, run.runId, [200]);
    await createWebhookCallbackApi(context).requestAgentComplete(
      { runId: run.runId, exitCode: 1, error: "Cancelled private maintenance" },
      run.headers,
      [200],
    );
    await flushWaitUntilForTest();
    const cancelled = await api.readRun(fixture.actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
    if (!cancelled.completedAt) {
      throw new Error("Expected real terminal time");
    }
    await withMockNowForTest(
      new Date(new Date(cancelled.completedAt).getTime() + 3_600_001),
      async () => {
        const result = await createStore().set(
          createPiMemoryPhase2Worker(run.scope).execute$,
          nowDate(),
          context.signal,
        );
        expect(result.outcome).toBe("dispatched");
        if (result.outcome !== "dispatched") {
          throw new Error("Expected retry to use replacement");
        }
        fixture.registerRun(result.runId);
        expect(result.runId).not.toBe(run.runId);
        const execution = await claimPhase2Execution(context, result.runId);
        fixture.registerClaim(result.runId, execution.sandboxToken);
        await expect(authFor(execution)).resolves.toMatchObject({
          "x-selected-token": replacement.key,
          "x-selected-account": replacement.account,
        });
        expect(
          (await api.readRun(fixture.actor, result.runId)).source,
        ).toMatchObject({
          providerType: "codex-oauth-token",
          account: { id: replacement.binding.modelProviderId },
        });
        expect(execution.piLaunchConfig?.maintenance).toMatchObject({
          memoryStorageId: run.binding.memoryStorageId,
          claimedBaseVersionId: run.binding.claimedBaseVersionId,
          selected: run.binding.selected,
        });
      },
    );
  });
});

test.each(["valid", "invalid"] as const)(
  "preserves personal subscription E3 represented %s artifacts",
  async (represented) => {
    let baseFiles: { path: string; content: string }[] = [];
    const fixture = createPublicPiMemorySource(context, {
      cashCredits: 100_000,
      sources: ["first complete evidence", "second complete evidence"],
      memoryFiles(sources) {
        baseFiles = [
          { path: "MEMORY.md", content: "# Task Group: source\n" },
          {
            path: "memory_summary.md",
            content:
              represented === "valid"
                ? "v1\n## User Profile\n- source\n"
                : "invalid summary",
          },
          ...sources.map((source, index) => {
            return {
              // Real Stage1 uses rolloutSlug "source"; the runtime persists a
              // bounded hashed slug, not that raw provider string.
              path: `rollout_summaries/pi/${createHash("sha256").update(source.threadId).digest("hex")}-slug-${createHash("sha256").update("source").digest("hex").slice(0, 43)}.md`,
              content: [
                `pi_session_id: ${JSON.stringify(source.threadId)}`,
                `source_run_id: ${JSON.stringify(source.runId)}`,
                `source_history_hash: ${JSON.stringify(source.hash)}`,
                `source_completed_at: ${JSON.stringify(source.completedAt)}`,
                "",
                index === 0
                  ? "first complete evidence"
                  : "second complete evidence",
                "",
              ].join("\n"),
            };
          }),
        ];
        return baseFiles;
      },
    });
    await fixture.run(async () => {
      const run = await launchPublicMaintenance(fixture, {
        type: "codex-oauth-token",
      });
      for (const [index, source] of run.scope.sources.entries()) {
        expect(
          run.execution.piLaunchConfig?.maintenance?.selected.find((entry) => {
            return entry.piSessionId === source.threadId;
          }),
        ).toMatchObject({
          sourceRunId: source.runId,
          sourceHistoryHash: source.hash,
          sourceCompletedAt: source.completedAt,
          rolloutSummary:
            index === 0
              ? "first complete evidence"
              : "second complete evidence",
          rolloutSlug: "source",
        });
      }
      const actual = await executePhase2Runtime(context, run.runId, {
        baseFiles,
        execution: run.execution,
        registerCleanup: fixture.registerCleanup,
        noDiff: represented === "valid",
      });
      expect(actual.requests).toHaveLength(represented === "valid" ? 0 : 3);
      await run.proxy();
      await run.proxy();
      await expect(run.ledger()).resolves.toStrictEqual([]);
    });
  },
);

test("preserves non-model usage for a genuinely launched personal subscription run", async () => {
  const fixture = createPublicPiMemorySource(context, {
    cashCredits: 100_000,
    sources: ["first complete evidence", "second complete evidence"],
  });
  await fixture.run(async () => {
    const run = await launchPublicMaintenance(fixture, {
      type: "codex-oauth-token",
    });
    const event = {
      idempotencyKey: randomUUID(),
      kind: "connector" as const,
      provider: "x",
      category: "tweet.read",
      quantity: 10,
    };
    await createUsagePricingFixture({
      registerCleanup: fixture.registerCleanup,
      configured: [{ ...event, unitPrice: 1, unitSize: 1 }],
    });
    const client = setupApp({
      context,
      routes: webhooksAgentHealthUsageTelemetryRoutes,
    });
    const send = () => {
      return accept(
        client(webhookUsageEventContract).send({
          headers: run.headers,
          body: { runId: run.runId, events: [event] },
        }),
        [200],
      );
    };
    await send();
    await send();
    await run.proxy();
    await expect(run.ledger()).resolves.toMatchObject([
      {
        kind: "connector",
        provider: "x",
        category: "tweet.read",
        quantity: 10,
      },
    ]);
  });
});

test("keeps explicit built-in HTTP identity and cache-inclusive billing", async () => {
  const fixture = createPublicPiMemorySource(context, {
    cashCredits: 100_000,
    sources: ["first complete evidence", "second complete evidence"],
  });
  await fixture.run(async () => {
    const run = await launchPublicMaintenance(fixture);
    const actual = await executePhase2Runtime(context, run.runId, {
      execution: run.execution,
      registerCleanup: fixture.registerCleanup,
    });
    expect(actual.requests).toHaveLength(3);
    for (const request of actual.requests) {
      expect(request.url).toBe("https://openrouter.ai/api/v1/responses");
      expect(request.headers.get("authorization")).toMatch(
        /^Bearer built-in-key-runtime-fixture-/,
      );
      // V4.1 Flash publishes no `medium` step, so maintenance sends `high`.
      expect(request.body).toMatchObject({
        model: "deepseek/deepseek-v4.1-flash",
        reasoning: { effort: "high" },
      });
      expect(request.body).not.toHaveProperty("service_tier");
    }
    expect(run.run.source).toMatchObject({
      providerType: "built-in",
      model: PI_MEMORY_PHASE2_BUILT_IN_MODEL,
      credentialScope: "org",
    });
    await run.proxy();
    await run.proxy();
    await expect(run.ledger()).resolves.toStrictEqual(canonicalLedger(run));
    await expect(run.ledger()).resolves.toHaveLength(4);
  });
});

test.each(["missing-id", "missing-scope", "wrong-owner", "wrong-framework"])(
  "does not retain malformed personal subscription private identity: %s",
  async (fault) => {
    const fixture = createPublicPiMemorySource(context, {
      cashCredits: 100_000,
      sources: ["first complete evidence", "second complete evidence"],
    });
    await fixture.run(async () => {
      const run = await launchPublicMaintenance(fixture, {
        type: "codex-oauth-token",
      });
      const memory = expectCanonicalStorageManifest(
        run.execution.storageManifest,
      )?.storageMounts.find((entry) => {
        return entry.name === "memory";
      });
      if (!memory) {
        throw new Error("Expected maintenance Memory mount");
      }
      await createWebhookCallbackApi(context).requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 0,
          checkpoint: {
            cliAgentType: "pi",
            cliAgentSessionId: run.runId,
            cliAgentSessionHistoryDisposition: "unavailable",
            artifactSnapshots: [
              {
                name: memory.name,
                mountPath: memory.mountPath,
                version: run.binding.claimedBaseVersionId,
              },
            ],
          },
        },
        run.headers,
        [200],
      );
      await flushWaitUntilForTest();
      const completed = await createRunsApi(context).readRun(
        fixture.actor,
        run.runId,
      );
      expect(completed.status).toBe("completed");
      if (!completed.completedAt) {
        throw new Error("Expected real terminal completion");
      }
      const completedAt = new Date(completed.completedAt);
      // Original key10 malformed captured identity; lifecycle above is real.
      if (fault !== "wrong-owner") {
        await db()
          .update(agentRuns)
          .set({
            ...(fault === "missing-id" ? { modelProviderId: null } : {}),
            ...(fault === "missing-scope"
              ? { modelProviderCredentialScope: null }
              : {}),
            ...(fault === "wrong-framework"
              ? {
                  launchSnapshot: {
                    schemaVersion: 1,
                    framework: "codex" as const,
                    runnerProfile: "vm0/test",
                  },
                }
              : {}),
          })
          .where(eq(agentRuns.id, run.runId));
      } else {
        await db()
          .update(agentRunCallbacks)
          .set(
            fault === "wrong-owner"
              ? { payload: { ...run.binding, userId: "other-owner" } }
              : {},
          )
          .where(eq(agentRunCallbacks.runId, run.runId));
      }
      await withMockNowForTest(
        new Date(completedAt.getTime() + 10 * 60_000),
        async () => {
          expect((await run.cleanup()).threadlessRuns.deleted).toBe(1);
        },
      );
    });
  },
);
