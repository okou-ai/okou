import { randomUUID } from "node:crypto";
import {
  runnersCancellationContract,
  CANCELLATION_RECOVERY_STALE_AFTER_MS,
} from "@okouai/api-contracts/contracts/runners";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { runnerCancellationRoutes } from "../runner-cancellation";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();

function client() {
  return setupApp({ context, routes: runnerCancellationRoutes })(
    runnersCancellationContract,
  );
}

async function fixture(triggerSource: "test" | "web" = "test") {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agentName = `cancel-state-${randomUUID().slice(0, 8)}`;
  const agent = await runs.createDirectAgent(actor, {
    version: "1",
    agents: { [agentName]: { framework: "claude-code" } },
  });
  const run = await runs.createDirectRun(actor, {
    agentId: agent.agentId,
    prompt: "exercise cancellation reconciliation",
    modelProviderType: "anthropic-api-key",
    triggerSource,
  });
  onTestFinished(async () => {
    await runs.requestCancelRun(actor, run.runId, [200, 400, 404]);
    await flushWaitUntilForTest();
    await bdd.requestDeleteAgent(actor, agent.agentId, [204, 404]);
  });
  const identity = {
    runnerId: randomUUID(),
    heartbeatGeneration: 5_000_000_000,
  };
  await runs.heartbeatRunner(runnerGroup);
  const claim = await runs.claimRunnerJob(run.runId, {
    runnerIdentity: identity,
  });
  return {
    bdd,
    runs,
    actor,
    agentId: agent.agentId,
    runId: run.runId,
    headers: { authorization: `Bearer ${claim.sandboxToken}` },
    query: { runnerGroup, ...identity },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function read(f: Fixture) {
  return await accept(
    client().get({
      params: { runId: f.runId },
      headers: f.headers,
      query: f.query,
    }),
    [200],
  );
}

describe("Run cancellation reconciliation", () => {
  it("recovers committed cooperative cancellation after publication fails", async () => {
    const f = await fixture();
    const healthy = await read(f);
    expect(healthy.body).toStrictEqual({
      protocolVersion: 1,
      runId: f.runId,
      state: "present",
      mode: null,
    });
    expect(healthy.headers.get("cache-control")).toBe("no-store");
    context.mocks.ably.publish.mockRejectedValueOnce(
      new Error("synthetic cancellation transport failure"),
    );
    await f.runs.requestCancelRun(f.actor, f.runId, [200]);
    await flushWaitUntilForTest();
    await f.runs.requestCancelRun(f.actor, f.runId, [200]);
    expect((await read(f)).body).toStrictEqual({
      protocolVersion: 1,
      runId: f.runId,
      state: "present",
      mode: "cooperative",
    });
  });

  it("confirms physical absence after permitted Agent deletion with the original claim token", async () => {
    const f = await fixture();
    await f.runs.requestCancelRun(f.actor, f.runId, [200]);
    await flushWaitUntilForTest();
    await f.bdd.deleteAgent(f.actor, f.agentId);
    expect((await read(f)).body).toStrictEqual({
      protocolVersion: 1,
      runId: f.runId,
      state: "gone",
    });
  });

  it("redrives threadless cleanup without escalating the user's cooperative stop", async () => {
    const f = await fixture("web");
    await f.runs.requestCancelRun(f.actor, f.runId, [200]);
    await flushWaitUntilForTest();
    await withMockNowForTest(
      now() + CANCELLATION_RECOVERY_STALE_AFTER_MS,
      async () => {
        // The existing test endpoint restricts the real cron to this fixture's IDs.
        const cleanup = await accept(
          setupApp({ context, routes: testCronCleanupSandboxesStateRoutes })(
            testCronCleanupSandboxesStateContract,
          ).cleanup({
            body: {
              runIds: [f.runId],
              orgIds: [],
              chatThreadIds: [],
              exportJobIds: [],
            },
          }),
          [200],
        );
        expect(cleanup.body.threadlessRuns).toMatchObject({
          deleted: 1,
          failed: 0,
        });
      },
    );
    expect((await read(f)).body).toMatchObject({ state: "gone" });
    const cancellations = context.mocks.ably.publish.mock.calls.filter(
      ([channel, payload]) => {
        return (
          channel === "cancel" &&
          typeof payload === "object" &&
          payload !== null &&
          "runId" in payload &&
          payload.runId === f.runId
        );
      },
    );
    expect(cancellations).toStrictEqual([
      ["cancel", { runId: f.runId, mode: "cooperative" }],
    ]);
  });

  it("does not mistake a present row with another group or official claim for deletion", async () => {
    const f = await fixture();
    for (const query of [
      { ...f.query, runnerGroup: "vm0/another-group" },
      { ...f.query, runnerId: randomUUID() },
      { ...f.query, heartbeatGeneration: f.query.heartbeatGeneration + 1 },
    ]) {
      const response = await accept(
        client().get({ params: { runId: f.runId }, headers: f.headers, query }),
        [200],
      );
      expect(response.body).toStrictEqual({
        protocolVersion: 1,
        runId: f.runId,
        state: "unavailable",
      });
    }
    expect((await read(f)).body).toMatchObject({
      state: "present",
      mode: null,
    });
  });

  it("rejects missing, forged, agent-scope and wrong-Run credentials", async () => {
    const f = await fixture();
    const agentToken = f.runs.okouTokenForRunWithCapabilities(
      f.actor,
      f.runId,
      [],
    );
    for (const headers of [
      {},
      { authorization: "Bearer vm0_sandbox_invalid" },
      { authorization: `Bearer ${agentToken}` },
    ]) {
      const response = await accept(
        client().get({ params: { runId: f.runId }, headers, query: f.query }),
        [401],
      );
      expect(response.body.error.code).toBe("UNAUTHORIZED");
    }
    await accept(
      client().get({
        params: { runId: randomUUID() },
        headers: f.headers,
        query: f.query,
      }),
      [401],
    );
  });

  it("does not turn an expired token into a disappearance decision", async () => {
    const f = await fixture();
    await withMockNowForTest(now() + 3 * 60 * 60 * 1000 + 1000, async () => {
      await accept(
        client().get({
          params: { runId: f.runId },
          headers: f.headers,
          query: f.query,
        }),
        [401],
      );
    });
    expect((await read(f)).body).toMatchObject({
      state: "present",
      mode: null,
    });
  });

  it("preserves ordinary Guest completion without inventing a hard stop", async () => {
    const f = await fixture();
    const webhooks = createWebhookCallbackApi(context);
    await webhooks.requestAgentComplete(
      { runId: f.runId, exitCode: 1, error: "test execution failed" },
      f.headers,
      [200],
    );
    expect((await read(f)).body).toMatchObject({
      state: "present",
      mode: null,
    });
  });

  it("persists hard cancellation on member revocation without depending on live membership", async () => {
    const f = await fixture();
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "organizationMembership.deleted",
      data: {
        id: `membership-${randomUUID()}`,
        organization_id: f.actor.orgId,
        user_id: f.actor.userId,
      },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();
    expect((await read(f)).body).toMatchObject({
      state: "present",
      mode: "hard",
    });
  });

  it.each(["user.deleted", "organization.deleted"])(
    "keeps authenticated absence readable after %s",
    async (type) => {
      const f = await fixture();
      const webhooks = createWebhookCallbackApi(context);
      webhooks.configureClerkWebhookSecret();
      webhooks.verifyNextClerkWebhook({
        type,
        data: { id: type === "user.deleted" ? f.actor.userId : f.actor.orgId },
      });
      await webhooks.requestClerkWebhook("{}", {}, [200]);
      await flushWaitUntilForTest();
      expect((await read(f)).body).toStrictEqual({
        protocolVersion: 1,
        runId: f.runId,
        state: "gone",
      });
    },
  );
});
