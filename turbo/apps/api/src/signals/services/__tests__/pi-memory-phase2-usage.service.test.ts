import { randomUUID } from "node:crypto";

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
import { piMemoryPhase2MaintenanceCallbackPayloadSchema } from "../pi-memory-phase2-maintenance.service";
import { executePiMemoryPhase2Work$ } from "../pi-memory-phase2-worker.service";
import {
  createPhase2TestScope,
  insertPendingPhase2Job,
  insertPhase2Candidates,
} from "./pi-memory-phase2-job.test-fixture";

// Private maintenance has no public launch/control/ledger API. Seed only its
// infrastructure-owned cron input and terminal faults; the real dispatcher
// persists the binding, and the real proxy HTTP ingress owns all usage writes.
const context = testContext();

async function dispatchMaintenance() {
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
  await insertPhase2Candidates(scope, [
    {
      piSessionId: randomUUID(),
      rawMemory: "private candidate",
      rolloutSummary: "private evidence",
    },
  ]);
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
  return { scope, run, runId, binding };
}

async function launchMaintenance() {
  const { scope, run, runId, binding } = await dispatchMaintenance();
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

  it.each(["completed", "failed", "cancelled", "timeout"])(
    "keeps the proxy owner through %s and delayed cleanup",
    async (status) => {
      const run = await launchMaintenance();
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
          await expect(run.ledger()).resolves.toHaveLength(4);
          await expect(run.ledger()).resolves.toStrictEqual(
            canonicalLedger(run),
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
      expect(ledger).toHaveLength(4);
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
          run.events.map((event) => {
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

  it.each(["openai-api-key", "codex-oauth-token"])(
    "preserves %s exclusions even with a spoofed maintenance callback",
    async (modelProvider) => {
      const run = await launchMaintenance();
      await db()
        .update(agentRuns)
        .set({ modelProvider })
        .where(eq(agentRuns.id, run.runId));
      await run.proxy();
      await expect(run.ledger()).resolves.toStrictEqual([]);
    },
  );
});
