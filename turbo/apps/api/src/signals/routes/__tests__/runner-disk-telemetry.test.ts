import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import {
  accept,
  testContext,
  type TestContext,
} from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { billingStatusRoutes } from "../billing-status";
import { createBddApi } from "./helpers/api-bdd";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { createRouteMocks } from "./helpers/route-test";
import { mockSecretKmsHttp } from "./helpers/secret-kms-http";

const context = testContext();

function createDiskTelemetryFixture(context: TestContext) {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const actor = bdd.user();
  const owned: { runId?: string; sandboxToken?: string } = {};
  let accepted = captureConnectorExternalState(context);
  let previous: (() => void) | undefined;
  let restoreSetupWebhook: (() => void) | undefined;
  let databaseReady = false;

  onTestFinished(() => {
    previous?.();
  });
  const owner = createFixtureOperationOwner(
    async () => {
      const errors: unknown[] = [];
      async function settle<T>(operation: () => Promise<T>) {
        const result = await settleIncludingAbort(
          Promise.resolve().then(operation),
        );
        if (!result.ok) {
          errors.push(result.error);
        }
        return result;
      }
      context.mocks.ably.publish.mockResolvedValue(undefined);
      await settle(flushWaitUntilForTest);
      // Failed initialization must not make teardown query an uninitialized actor.
      if (!databaseReady) {
        if (errors.length) {
          throw new AggregateError(errors, "Disk telemetry cleanup failed");
        }
        return;
      }

      // A send may commit before its response reaches the fixture.
      const runIds = new Set(owned.runId ? [owned.runId] : []);
      const listed = await settle(() => {
        return createRunReadsApi(context).requestListLogs(
          actor,
          { limit: 50 },
          [200],
        );
      });
      if (listed.ok) {
        for (const item of listed.value.body.data) {
          runIds.add(item.id);
        }
      }
      for (const runId of runIds) {
        const current = await settle(() => {
          return runs.readRun(actor, runId);
        });
        if (
          current.ok &&
          ["queued", "pending", "running"].includes(current.value.status)
        ) {
          await settle(() => {
            return runs.requestCancelRun(actor, runId, [200]);
          });
        }
        // Public cancellation keeps a claimed slot until its actual Runner ACKs.
        if (
          owned.runId === runId &&
          owned.sandboxToken &&
          (!current.ok ||
            !["completed", "failed", "timeout"].includes(current.value.status))
        ) {
          const headers = { authorization: `Bearer ${owned.sandboxToken}` };
          await settle(() => {
            return webhooks.requestAgentComplete(
              {
                runId,
                exitCode: 1,
                error: "Cancelled by disk telemetry cleanup",
              },
              headers,
              [200],
            );
          });
        }
      }
      await settle(flushWaitUntilForTest);
      if (errors.length) {
        throw new AggregateError(errors, "Disk telemetry cleanup failed");
      }
    },
    {
      beforeDrain: () => {
        previous = captureConnectorExternalState(context);
        accepted();
        restoreSetupWebhook?.();
      },
    },
  );

  function run<T>(operation: () => Promise<T>): Promise<T> {
    return owner.run(async () => {
      const pending = settleIncludingAbort(operation);
      accepted = captureConnectorExternalState(context);
      const result = await pending;
      accepted = captureConnectorExternalState(context);
      if (!result.ok) {
        throw result.error;
      }
      return result.value;
    });
  }

  return {
    bdd,
    runs,
    webhooks,
    actor,
    owned,
    run,
    initializeDatabase() {
      return run(async () => {
        const client = await setupApp({
          context,
          routes: billingStatusRoutes,
        });
        databaseReady = true;
        createRouteMocks(context).clerk.session(
          actor.userId,
          actor.orgId,
          actor.orgRole,
        );
        const response = await accept(
          client(billingStatusContract).get({
            headers: { authorization: "Bearer clerk-session" },
          }),
          [200],
        );
        expect(response.body.tier).toBe("limited-free-1");
      });
    },
    grantEntitlement() {
      return run(async () => {
        const result = await runs.grantProEntitlement(actor, {
          run,
          onExternalStateReady: (restore) => {
            restoreSetupWebhook = restore;
          },
        });
        restoreSetupWebhook = undefined;
        return result;
      });
    },
  };
}

describe("Runner disk telemetry HTTP", () => {
  it("accepts independent, missing and malformed filesystem observations on an authenticated claimed run", async () => {
    mockSecretKmsHttp();
    const fixture = createDiskTelemetryFixture(context);
    const { bdd, runs, webhooks, actor } = fixture;
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const group = runs.configureRunnerGroup();
    await fixture.initializeDatabase();
    await fixture.grantEntitlement();
    await fixture.run(() => {
      return runs.ensurePersonalSubscriptionModel(actor, {
        model: "claude-fable-5-1",
      });
    });
    const agent = await fixture.run(() => {
      return bdd.createAgent(actor, {
        displayName: "Disk telemetry",
        visibility: "private",
      });
    });
    const run = await fixture.run(async () => {
      const created = await runs.createThreadRun(actor, {
        agentId: agent.agentId,
        prompt: "Observe disk independently",
      });
      fixture.owned.runId = created.runId;
      return created;
    });
    const runnerId = randomUUID();
    await fixture.run(() => {
      return runs.requestRawHeartbeatRunner(true, [200], {
        runnerId,
        group,
        snapshotGeneration: 1,
        snapshotSequence: 1,
        totalVcpu: 8,
        totalMemoryMb: 16_384,
        maxConcurrent: 2,
        allocatedVcpu: 0,
        allocatedMemoryMb: 0,
        runningCount: 0,
        admittableProfiles: ["vm0/default"],
        heldSandboxStates: [],
        heldHomeStates: [],
        activeReuseProducers: [],
        mode: "running",
      });
    });
    const polled = await fixture.run(() => {
      return runs.requestPollRunner(
        true,
        {
          runnerId,
          group,
          supportedProfiles: ["vm0/default"],
        },
        [200],
      );
    });
    expect(polled.body).toMatchObject({ job: { runId: run.runId } });
    const claimed = await fixture.run(async () => {
      const response = await runs.requestClaimRunnerJob(
        true,
        run.runId,
        [200],
        {
          runnerIdentity: { runnerId, heartbeatGeneration: 1 },
        },
      );
      if (response.status === 200) {
        fixture.owned.sandboxToken = response.body.sandboxToken;
      }
      return response;
    });
    if (claimed.status !== 200) {
      throw new Error("Expected claim");
    }
    const headers = { authorization: `Bearer ${claimed.body.sandboxToken}` };
    const metric = {
      ts: "2026-10-10T00:00:00Z",
      cpu: 1,
      mem_used: 10,
      mem_total: 100,
    };
    const rootfs = {
      used_bytes: 20,
      total_bytes: 100,
      available_bytes: 70,
      used_inodes: 4,
      total_inodes: 10,
      available_inodes: 5,
    };
    const home = {
      used_bytes: 200,
      total_bytes: 200,
      available_bytes: 0,
      used_inodes: 20,
      total_inodes: 20,
      available_inodes: 0,
    };
    for (const snapshot of [
      { ...metric, rootfs, home },
      { ...metric, rootfs },
      { ...metric, home },
      { ...metric, rootfs, home: { used_bytes: -1 } },
      { ...metric, rootfs: { used_bytes: -1 }, home },
      metric,
    ]) {
      const response = await fixture.run(() => {
        return webhooks.requestAgentTelemetryUnchecked(
          { runId: run.runId, systemLog: "ordinary log", metrics: [snapshot] },
          headers,
          [200],
        );
      });
      expect(response.body).toMatchObject({ success: true, id: run.runId });
    }
    const mismatched = await fixture.run(() => {
      return webhooks.requestAgentTelemetry(
        { runId: randomUUID(), metrics: [metric] },
        headers,
        [401],
      );
    });
    expect(mismatched.status).toBe(401);
    const completed = await fixture.run(() => {
      return webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 1,
          error: "disk full",
          failureReason: "guest_home_filesystem_full",
        },
        headers,
        [200],
      );
    });
    expect(completed.status).toBe(200);
    const readback = await fixture.run(() => {
      return runs.requestReadRun(actor, run.runId, [200]);
    });
    expect(readback.body).toMatchObject({ status: "failed" });
    // Queued/claimed identity and persisted terminal state are observed through
    // production endpoints, not private DB fixtures.
  });
});
