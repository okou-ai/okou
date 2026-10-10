import { randomUUID } from "node:crypto";
import { runnersCancellationContract } from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { runnerCancellationRoutes } from "../runner-cancellation";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();

function client() {
  return setupApp({ context, routes: runnerCancellationRoutes })(
    runnersCancellationContract,
  );
}

async function fixture() {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Cancellation state agent",
    description: "Exercises cancellation reconciliation.",
    visibility: "private",
  });
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "exercise cancellation reconciliation",
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
    agentToken: claim.platformEnvironment.OKOU_TOKEN,
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
  it("reconciles cancellation and completion for a PAT claim without official attribution", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const workspaces = createAuthOrgAgentsBddApi(context);
    const actors = [bdd.user(), bdd.user()];
    const ownedRuns: {
      readonly actor: ApiTestUser;
      readonly runId: string;
      sandboxToken?: string;
      acknowledged: boolean;
    }[] = [];
    onTestFinished(async () => {
      for (const owned of [...ownedRuns].reverse()) {
        const current = await runs.readRun(owned.actor, owned.runId);
        if (current.status === "pending" || current.status === "running") {
          await runs.requestCancelRun(owned.actor, owned.runId, [200]);
        }
        if (owned.sandboxToken && !owned.acknowledged) {
          await webhooks.requestAgentComplete(
            { runId: owned.runId, exitCode: 1, error: "Run cancelled" },
            { authorization: `Bearer ${owned.sandboxToken}` },
            [200],
          );
        }
        await flushWaitUntilForTest();
      }
      for (const actor of [...actors].reverse()) {
        workspaces.mockClerkOrg(actor);
        await workspaces.deleteOrg(actor);
        await flushWaitUntilForTest();
      }
    });
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    const query = {
      runnerGroup,
      runnerId: randomUUID(),
      heartbeatGeneration: 5_000_000_000,
    };

    for (const actor of actors) {
      await runs.grantProEntitlement(actor);
      await runs.ensurePersonalSubscriptionModel(actor);
      const agent = await bdd.createAgent(actor, {
        displayName: "PAT cancellation agent",
        description: "Exercises cancellation with a current PAT claim.",
        visibility: "private",
      });
      const pat = await runs.createCliToken(actor);
      // A peer Run in the same organization also exercises token/path isolation.
      for (let index = 0; index < (actor === actors[0] ? 2 : 1); index++) {
        const run = await runs.createThreadRun(actor, {
          agentId: agent.agentId,
          prompt: "reconcile a PAT-claimed Run",
        });
        const owned: (typeof ownedRuns)[number] = {
          actor,
          runId: run.runId,
          acknowledged: false,
        };
        ownedRuns.push(owned);
        const claim = await runs.requestClaimRunnerJobAs(
          `Bearer ${pat.token}`,
          run.runId,
          [200],
          {
            runnerIdentity: { runnerId: randomUUID(), heartbeatGeneration: 13 },
          },
        );
        if (claim.status !== 200) {
          throw new Error("Expected public PAT claim to succeed");
        }
        owned.sandboxToken = claim.body.sandboxToken;
        const runner = await runs.requestRunRunner(actor, run.runId, [200]);
        expect(runner.body).toMatchObject({
          runnerId: null,
          runnerHeartbeatGeneration: null,
        });
      }
    }

    const [target, peer, foreign] = ownedRuns;
    if (
      !target?.sandboxToken ||
      !peer?.sandboxToken ||
      !foreign?.sandboxToken
    ) {
      throw new Error("Expected three publicly claimed PAT Runs");
    }
    const headers = { authorization: `Bearer ${target.sandboxToken}` };
    const readTarget = async () => {
      return await accept(
        client().get({ params: { runId: target.runId }, headers, query }),
        [200],
      );
    };
    const healthy = await readTarget();
    expect(healthy.body).toStrictEqual({
      protocolVersion: 1,
      runId: target.runId,
      state: "present",
      mode: null,
    });
    expect(healthy.headers.get("cache-control")).toBe("no-store");

    const wrongGroup = await accept(
      client().get({
        params: { runId: target.runId },
        headers,
        query: { ...query, runnerGroup: "vm0/another-group" },
      }),
      [200],
    );
    expect(wrongGroup.body).toStrictEqual({
      protocolVersion: 1,
      runId: target.runId,
      state: "unavailable",
    });
    for (const other of [peer, foreign]) {
      const response = await accept(
        client().get({
          params: { runId: target.runId },
          headers: { authorization: `Bearer ${other.sandboxToken}` },
          query,
        }),
        [401],
      );
      expect(response.body).toStrictEqual({
        error: {
          code: "UNAUTHORIZED",
          message: "Not authenticated or runId mismatch",
        },
      });
    }

    await runs.requestCancelRun(target.actor, target.runId, [200]);
    await flushWaitUntilForTest();
    const cancelled = {
      protocolVersion: 1,
      runId: target.runId,
      state: "present",
      mode: "cooperative",
    };
    expect((await readTarget()).body).toStrictEqual(cancelled);
    await webhooks.requestAgentComplete(
      { runId: target.runId, exitCode: 1, error: "Run cancelled" },
      headers,
      [200],
    );
    target.acknowledged = true;
    await expect(
      runs.readRun(target.actor, target.runId),
    ).resolves.toMatchObject({
      status: "cancelled",
    });
    expect((await readTarget()).body).toStrictEqual(cancelled);

    await webhooks.requestAgentComplete(
      { runId: peer.runId, exitCode: 1, error: "test execution failed" },
      { authorization: `Bearer ${peer.sandboxToken}` },
      [200],
    );
    peer.acknowledged = true;
    await expect(runs.readRun(peer.actor, peer.runId)).resolves.toMatchObject({
      status: "failed",
    });
    const completed = await accept(
      client().get({
        params: { runId: peer.runId },
        headers: { authorization: `Bearer ${peer.sandboxToken}` },
        query,
      }),
      [200],
    );
    expect(completed.body).toStrictEqual({
      protocolVersion: 1,
      runId: peer.runId,
      state: "present",
      mode: null,
    });
  });

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
    const agentToken = f.agentToken;
    if (!agentToken) {
      throw new Error("Expected the claim to issue an agent token");
    }
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
