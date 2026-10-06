import { createPublicPiMemorySource } from "../../routes/__tests__/helpers/public-pi-memory-source";
import { createRunsApi } from "../../routes/__tests__/helpers/api-bdd-runs";
import { createHash, randomUUID } from "node:crypto";
import { webhookUsageEventContract } from "@okouai/api-contracts/contracts/webhooks";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
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
import { seedBuiltInModelCandidateKeys } from "../../routes/__tests__/helpers/runtime-state";
import { configureNativeCliArtifact } from "../../routes/__tests__/helpers/chat-events-fixture";
import { testCronCleanupSandboxesStateRoutes } from "../../routes/test-cron-cleanup-sandboxes-state";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../../routes/webhooks-agent-health-usage-telemetry";
import {
  piMemoryPhase2MaintenanceCallbackPayloadSchema,
  handlePiMemoryPhase2MaintenanceCallback,
} from "../pi-memory-phase2-maintenance.service";
import {
  PI_MEMORY_PHASE2_BUILT_IN_MODEL,
  PI_MEMORY_PHASE2_PERSONAL_MODEL,
} from "../pi-memory-phase2-usage.service";
import { createPiMemoryPhase2Worker } from "../pi-memory-phase2-worker.service";
import {
  createPhase2TestScope,
  insertPendingPhase2Job,
  insertPhase2StorageVersion,
  setPhase2StorageHead,
  insertPhase2CandidatesWithSources as insertPhase2Candidates,
  readPhase2Job,
} from "./pi-memory-phase2-job.test-fixture";
import {
  claimPhase2Execution,
  phase2RuntimeModel,
  executePhase2Runtime,
} from "../../../test-fixtures/__tests__/pi-memory-phase2-runtime";
import {
  createPhase2CodexProvider,
  disconnectPhase2Codex,
} from "../../../test-fixtures/pi-memory-phase2-credential";

// Private maintenance has no public launch/control/ledger API. Seed only its
// infrastructure-owned cron input and terminal faults; the real dispatcher
// persists the binding, and the real proxy HTTP ingress owns all usage writes.
const context = testContext();

async function dispatchMaintenance(
  type?: "codex-oauth-token",

  represented?: "valid" | "invalid",
) {
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
    await seedBuiltInModelCandidateKeys(
      context,
      PI_MEMORY_PHASE2_BUILT_IN_MODEL,
    );
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
  const baseFiles: { path: string; content: string }[] = [];
  if (represented) {
    baseFiles.push(
      { path: "MEMORY.md", content: "# Task Group: source\n" },
      {
        path: "memory_summary.md",
        content:
          represented === "valid"
            ? "v1\n## User Profile\n- source\n"
            : "invalid summary",
      },
      ...candidates.map((candidate) => {
        return {
          path: `rollout_summaries/pi/${createHash("sha256").update(candidate.piSessionId).digest("hex")}.md`,
          content: [
            `pi_session_id: ${JSON.stringify(candidate.piSessionId)}`,
            `source_run_id: ${JSON.stringify(candidate.sourceRunId)}`,
            `source_history_hash: ${JSON.stringify(candidate.sourceHistoryHash)}`,
            `source_completed_at: ${JSON.stringify(candidate.sourceCompletedAt.toISOString())}`,
            "",
            candidate.rolloutSummary,
            "",
          ].join("\n"),
        };
      }),
    );
    const hashes = baseFiles
      .map((file) => {
        return `${file.path}:${createHash("sha256").update(file.content).digest("hex")}`;
      })
      .sort();
    const version = await insertPhase2StorageVersion(scope, "represented", {
      versionId: createHash("sha256")
        .update(`storage:${scope.memoryStorageId}\n${hashes.join("\n")}`)
        .digest("hex"),
      fileCount: baseFiles.length,
      size: baseFiles.reduce((sum, file) => {
        return sum + Buffer.byteLength(file.content);
      }, 0),
      archiveSize: 1,
    });
    await setPhase2StorageHead(scope, version);
  }
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
  return { scope, run, runId, binding, provider, baseFiles };
}

async function launchMaintenance(
  type?: "codex-oauth-token",

  represented?: "valid" | "invalid",
) {
  const { scope, run, runId, binding, provider, baseFiles } =
    await dispatchMaintenance(type, represented);
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
    baseFiles,
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
      return await accept(
        setupApp({
          context,
          routes: testCronCleanupSandboxesStateRoutes,
          usagePricingResolution: pricing.resolution,
        })(testCronCleanupSandboxesStateContract).cleanup({
          body: {
            chatThreadIds: [],
            runIds: [runId],
            exportJobIds: [],
          },
        }),
        [200],
      );
    },
  };
}

async function launchPublicMaintenance(
  fixture: ReturnType<typeof createPublicPiMemorySource>,
  type?: "codex-oauth-token",
) {
  const at = new Date(now() + 24 * 3_600_000);
  const scope = await fixture.prepare(at);
  fixture.installExtractionProvider([
    {
      rawMemory: "first private candidate",
      rolloutSummary: "first complete evidence",
    },
    {
      rawMemory: "second private candidate",
      rolloutSummary: "second complete evidence",
    },
  ]);
  await expect(fixture.extract()).resolves.toMatchObject({
    claimed: 2,
    succeeded: 2,
  });
  if (!type) {
    await fixture.disconnect(scope.subscription.accountSourceId);
    await seedBuiltInModelCandidateKeys(
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
  await createUsagePricingFixture({
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
  return {
    scope,
    run,
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
      // DeepSeek while every BYOK binding keeps dispatching GPT. The delayed
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
          expect(cleanup.body.threadlessRuns.deleted).toBe(0);
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
          expect((await run.cleanup()).body.threadlessRuns.deleted).toBe(1);
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
      const run = await launchMaintenance();
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
        await db().insert(chatThreads).values({
          id: threadId,
          userId: run.scope.userId,
        });
        onTestFinished(async () => {
          await db().delete(chatThreads).where(eq(chatThreads.id, threadId));
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
      await expect(run.ledger()).resolves.toStrictEqual(canonicalLedger(run));
    },
  );

  it.each([
    {
      type: "codex-oauth-token",
      scope: "member",
      url: "https://chatgpt.com/backend-api/codex/responses",
      model: PI_MEMORY_PHASE2_PERSONAL_MODEL,
    },
  ] as const)(
    "executes exact $type/$scope HTTP and drops replayed model usage",
    async ({ type, scope, url, model }) => {
      const run = await launchMaintenance(type);
      expect(run.run).toMatchObject({
        modelProvider: type,
        modelProviderId: run.provider?.binding.modelProviderId,
        modelProviderCredentialScope: scope,
        selectedModel: PI_MEMORY_PHASE2_PERSONAL_MODEL,
        chatThreadId: null,
        creditAdmitted: false,
      });
      const actual = await executePhase2Runtime(context, run.runId);
      expect(
        actual.execution.piLaunchConfig?.maintenance?.selected,
      ).toHaveLength(2);
      expect(actual.execution.connectorRuntimeTargets).toStrictEqual([]);
      expect(actual.execution.secretValues).not.toContain(
        actual.execution.sandboxToken,
      );
      expect(actual.requests).toHaveLength(3);
      for (const request of actual.requests) {
        expect(request.url).toBe(url);
        expect(request.body).toMatchObject({
          model,
          reasoning: { effort: "medium" },
        });
        expect(request.body).not.toHaveProperty("text.format");
        expect(request.body).not.toHaveProperty("service_tier");
        {
          expect(request.headers.get("authorization")).toBe(
            `Bearer ${run.provider?.key}`,
          );
        }
        if (type === "codex-oauth-token") {
          expect(request.headers.get("chatgpt-account-id")).toBe(
            run.provider?.account,
          );
        }
      }
      await Promise.all([run.proxy(), run.proxy()]);
      await run.proxy();
      await expect(run.ledger()).resolves.toStrictEqual([]);
    },
  );

  it.each(["codex-oauth-token"] as const)(
    "drops %s usage after a real provider failure",
    async (type) => {
      const run = await launchMaintenance(type);
      const actual = await executePhase2Runtime(context, run.runId, {
        failure: true,
      });
      expect(actual.requests).toHaveLength(1);
      await run.proxy();
      await expect(run.ledger()).resolves.toStrictEqual([]);
    },
  );
});

test("retains the committed Codex account and uses the current account for a new retry", async () => {
  const run = await dispatchMaintenance("codex-oauth-token");
  if (!run.provider) {
    throw new Error("Missing subscription fixture");
  }
  const execution = await claimPhase2Execution(context, run.runId);
  await disconnectPhase2Codex(
    context,
    run.scope,
    run.provider.binding.modelProviderId,
  );
  const replacement = await createPhase2CodexProvider(context, run.scope);
  expect(replacement.binding.modelProviderId).not.toBe(
    run.provider.binding.modelProviderId,
  );
  const retained = await phase2RuntimeModel(context, execution);
  expect(retained.apiKey).toBe(run.provider.key);
  expect(retained.accountId).toBe(run.provider.account);
  const completedAt = nowDate();
  // Runner cancellation is infrastructure-owned for private threadless work.
  await db()
    .update(agentRuns)
    .set({ status: "cancelled", completedAt })
    .where(eq(agentRuns.id, run.runId));
  await handlePiMemoryPhase2MaintenanceCallback(db(), {
    runId: run.runId,
    payload: run.binding,
    status: "failed",
    error: "Cancelled private maintenance",
  });
  const retry = await readPhase2Job(run.scope);
  if (!retry?.retryAt) {
    throw new Error("Missing scheduled retry");
  }
  let retryRunId: string | undefined;
  await withMockNowForTest(new Date(retry.retryAt.getTime() + 1), async () => {
    const result = await createStore().set(
      createPiMemoryPhase2Worker(run.scope).execute$,
      nowDate(),
      context.signal,
    );
    expect(result.outcome).toBe("dispatched");
    if (result.outcome !== "dispatched") {
      throw new Error("Expected retry to use the replacement account");
    }
    retryRunId = result.runId;
    const [retryRun] = await db()
      .select({
        providerId: agentRuns.modelProviderId,
        sessionId: agentRuns.sessionId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, result.runId));
    if (!retryRun) {
      throw new Error("Missing retry maintenance run");
    }
    expect(retryRun.providerId).toBe(replacement.binding.modelProviderId);
    onTestFinished(async () => {
      await db()
        .delete(agentSessions)
        .where(eq(agentSessions.id, retryRun.sessionId));
    });
  });
  await expect(readPhase2Job(run.scope)).resolves.toMatchObject({
    completedRevision: 0,
    maintenanceRunId: retryRunId,
    retryCount: 1,
  });
});

test.each(["valid", "invalid"] as const)(
  "preserves BYOK E3 represented %s artifacts",
  async (represented) => {
    const run = await launchMaintenance("codex-oauth-token", represented);
    const actual = await executePhase2Runtime(context, run.runId, {
      baseFiles: run.baseFiles,
      noDiff: represented === "valid",
    });
    expect(actual.requests).toHaveLength(represented === "valid" ? 0 : 3);
    await run.proxy();
    await run.proxy();
    await expect(run.ledger()).resolves.toStrictEqual([]);
  },
);

test("preserves non-model usage for a genuinely launched personal subscription run", async () => {
  const fixture = createPublicPiMemorySource(context, {
    cashCredits: 100_000,
    sources: ["first complete evidence", "second complete evidence"],
  });
  await fixture.run(async () => {
    const run = await launchPublicMaintenance(fixture, "codex-oauth-token");
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
  "does not retain malformed BYOK private identity: %s",
  async (fault) => {
    const run = await launchMaintenance("codex-oauth-token");
    const completedAt = nowDate();
    await db()
      .update(agentRuns)
      .set({
        status: "completed",
        completedAt,
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
    await db()
      .update(agentRunCallbacks)
      .set({
        status: "delivered",
        ...(fault === "wrong-owner"
          ? { payload: { ...run.binding, userId: "other-owner" } }
          : {}),
      })
      .where(eq(agentRunCallbacks.runId, run.runId));
    await db()
      .delete(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, run.runId));
    await db()
      .update(piMemoryPhase2Jobs)
      .set({ leaseExpiresAt: new Date(completedAt.getTime() - 1) })
      .where(eq(piMemoryPhase2Jobs.memoryStorageId, run.scope.memoryStorageId));
    await withMockNowForTest(
      new Date(completedAt.getTime() + 10 * 60_000),
      async () => {
        expect((await run.cleanup()).body.threadlessRuns.deleted).toBe(1);
      },
    );
  },
);
