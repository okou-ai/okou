import { createHash, randomUUID } from "node:crypto";
import { webhookUsageEventContract } from "@okouai/api-contracts/contracts/webhooks";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/schema/chat-thread";
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
import { nowDate, withMockNowForTest } from "../../../lib/time";
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
import { testCronCleanupSandboxesStateRoutes } from "../../routes/test-cron-cleanup-sandboxes-state";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../../routes/webhooks-agent-health-usage-telemetry";
import {
  piMemoryPhase2MaintenanceCallbackPayloadSchema,
  handlePiMemoryPhase2MaintenanceCallback,
} from "../pi-memory-phase2-maintenance.service";
import { executePiMemoryPhase2Work$ } from "../pi-memory-phase2-worker.service";
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
  createPhase2Provider,
  disconnectPhase2Codex,
  phase2ApiKeyRoutes,
  type Phase2ProviderType,
} from "../../../test-fixtures/pi-memory-phase2-credential";
import { withBuiltInModelRuntimeRouteUnavailableForTest } from "../../../test-fixtures/built-in-model-runtime-route";

// Private maintenance has no public launch/control/ledger API. Seed only its
// infrastructure-owned cron input and terminal faults; the real dispatcher
// persists the binding, and the real proxy HTTP ingress owns all usage writes.
const context = testContext();

async function dispatchMaintenance(
  type?: Phase2ProviderType,
  credentialScope: "org" | "member" = "org",
  represented?: "valid" | "invalid",
) {
  const scope = await createPhase2TestScope("usage", { emptyBase: true });
  // PiMemory is off for everyone by default; the dispatcher only runs for
  // owners whose explicit override enables it.
  await updateFeatureSwitchesForUser(
    context,
    { orgId: scope.orgId, userId: scope.userId },
    { [FeatureSwitchKey.PiMemory]: true },
  );
  onTestFinished(async () => {
    await deleteFeatureSwitchesForUser(context, {
      orgId: scope.orgId,
      userId: scope.userId,
    });
  });
  await seedOrgMetadata({ orgId: scope.orgId, tier: "pro", credits: 100_000 });
  await seedBuiltInModelKey(context, "gpt-5.6-terra");
  const provider = type
    ? await createPhase2Provider(context, scope, type, credentialScope)
    : undefined;
  const candidates = ["first", "second"].map((name) => {
    return {
      piSessionId: randomUUID(),
      sourceRunId: randomUUID(),
      sourceHistoryHash: createHash("sha256")
        .update(randomUUID())
        .digest("hex"),
      sourceCompletedAt: new Date("2026-09-03T04:00:00Z"),
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
    executePiMemoryPhase2Work$,
    { scope, currentTime },
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
  type?: Phase2ProviderType,
  credentialScope: "org" | "member" = "org",
  represented?: "valid" | "invalid",
) {
  const { scope, run, runId, binding, provider, baseFiles } =
    await dispatchMaintenance(type, credentialScope, represented);
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
      provider: "gpt-5.6-terra",
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
            orgIds: [scope.orgId],
            exportJobIds: [],
          },
        }),
        [200],
      );
    },
  };
}

function canonicalLedger(run: Awaited<ReturnType<typeof launchMaintenance>>) {
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
    const run = await launchMaintenance();
    await Promise.all([run.proxy(), run.proxy()]);
    await run.proxy();
    await expect(run.ledger()).resolves.toHaveLength(4);
    await expect(run.ledger()).resolves.toStrictEqual(canonicalLedger(run));
  });

  it.each(
    ["completed", "failed", "cancelled", "timeout"].flatMap((status) => {
      return [
        { status, type: undefined },
        { status, type: "openai-api-key" as const },
      ];
    }),
  )(
    "keeps the $type proxy owner through $status and delayed cleanup",
    async ({ status, type }) => {
      const run = await launchMaintenance(type);
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

  it.each([
    "missing-callback",
    "mismatched-owner",
    "non-pi",
    "owned-thread",
    "api-first",
  ])(
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
      } else if (fault === "api-first") {
        await db()
          .update(agentRuns)
          .set({ modelProvider: null, triggerSource: "api" })
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
    ...phase2ApiKeyRoutes.flatMap((route) => {
      return [
        { ...route, scope: "org" as const },
        { ...route, scope: "member" as const },
      ];
    }),
    {
      type: "codex-oauth-token" as const,
      scope: "member" as const,
      url: "https://chatgpt.com/backend-api/codex/responses",
      model: "gpt-5.6-terra",
    },
    {
      type: "custom-openai-responses" as const,
      scope: "org" as const,
      url: "https://phase2-gateway.example/v1/responses",
      model: "mapped-terra",
    },
  ])(
    "executes exact $type/$scope HTTP and drops replayed model usage",
    async ({ type, scope, url, model }) => {
      await withBuiltInModelRuntimeRouteUnavailableForTest(
        "gpt-5.6-terra",
        async () => {
          const run = await launchMaintenance(type, scope);
          expect(run.run).toMatchObject({
            modelProvider: type,
            modelProviderId: run.provider?.binding.modelProviderId,
            modelProviderCredentialScope: scope,
            selectedModel: "gpt-5.6-terra",
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
            if (type === "custom-openai-responses") {
              expect(request.headers.get("x-source-key")).toBe(
                `Key ${run.provider?.key}`,
              );
            } else {
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
    },
  );

  it.each([
    "openai-api-key",
    "openrouter-codex",
    "vercel-ai-gateway-codex",
    "codex-oauth-token",
    "custom-openai-responses",
  ] as const)("drops %s usage after a real provider failure", async (type) => {
    const run = await launchMaintenance(
      type,
      type === "codex-oauth-token" ? "member" : "org",
    );
    const actual = await executePhase2Runtime(context, run.runId, {
      failure: true,
    });
    expect(actual.requests).toHaveLength(1);
    await run.proxy();
    await expect(run.ledger()).resolves.toStrictEqual([]);
  });
});

test("retains only the committed Codex run's exact account and rejects a new retry", async () => {
  const run = await dispatchMaintenance("codex-oauth-token", "member");
  if (!run.provider) {
    throw new Error("Missing subscription fixture");
  }
  const execution = await claimPhase2Execution(context, run.runId);
  await disconnectPhase2Codex(
    context,
    run.scope,
    run.provider.binding.modelProviderId,
  );
  const replacement = await createPhase2Provider(
    context,
    run.scope,
    "codex-oauth-token",
    "member",
  );
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
  await withMockNowForTest(new Date(retry.retryAt.getTime() + 1), async () => {
    const result = await createStore().set(
      executePiMemoryPhase2Work$,
      { scope: run.scope, currentTime: nowDate() },
      context.signal,
    );
    expect(result).toMatchObject({
      outcome: "failed",
      errorClass: "credential_unavailable",
    });
  });
  await expect(readPhase2Job(run.scope)).resolves.toMatchObject({
    completedRevision: 0,
    maintenanceRunId: null,
    retryCount: 2,
  });
});

test.each(["valid", "invalid"] as const)(
  "preserves BYOK E3 represented %s artifacts",
  async (represented) => {
    const run = await launchMaintenance("openai-api-key", "org", represented);
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

test("preserves non-model usage for a genuinely launched BYOK run", async () => {
  const run = await launchMaintenance("openai-api-key");
  const event = {
    idempotencyKey: randomUUID(),
    kind: "connector" as const,
    provider: "x",
    category: "tweet.read",
    quantity: 10,
  };
  const pricing = await createUsagePricingFixture({
    configured: [{ ...event, unitPrice: 1, unitSize: 1 }],
  });
  onTestFinished(pricing.cleanup);
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
    { kind: "connector", provider: "x", category: "tweet.read", quantity: 10 },
  ]);
});

test("keeps explicit built-in HTTP identity and cache-inclusive billing", async () => {
  const run = await launchMaintenance();
  const actual = await executePhase2Runtime(context, run.runId);
  expect(actual.requests).toHaveLength(3);
  for (const request of actual.requests) {
    expect(request.url).toBe("https://api.openai.com/v1/responses");
    expect(request.headers.get("authorization")).toMatch(
      /^Bearer built-in-key-runtime-fixture-/,
    );
    expect(request.body).toMatchObject({
      model: "gpt-5.6-terra",
      reasoning: { effort: "medium" },
    });
    expect(request.body).not.toHaveProperty("service_tier");
  }
  expect(run.run).toMatchObject({
    modelProvider: "built-in",
    modelProviderId: null,
    modelProviderCredentialScope: "org",
    selectedModel: "gpt-5.6-terra",
  });
  await run.proxy();
  await run.proxy();
  await expect(run.ledger()).resolves.toStrictEqual(canonicalLedger(run));
  await expect(run.ledger()).resolves.toHaveLength(4);
});

test.each(["missing-id", "missing-scope", "wrong-owner", "wrong-framework"])(
  "does not retain malformed BYOK private identity: %s",
  async (fault) => {
    const run = await launchMaintenance("openai-api-key");
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
