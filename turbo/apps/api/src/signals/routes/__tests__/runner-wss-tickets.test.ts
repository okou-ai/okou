import { randomUUID } from "node:crypto";

import { runnerWssTicketsContract } from "@okouai/api-contracts/contracts/runner-wss-tickets";
import { testRuntimeStateContract } from "@okouai/api-contracts/contracts/test-runtime-state";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { runnerWssTicketRoutes } from "../runner-wss-tickets";
import { testRuntimeStateRoutes } from "../test-runtime-state";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";

describe("direct Runner WSS ticket boundary", () => {
  const context = testContext();
  const hostname = "runner-a.example.com";
  const origin = `wss://${hostname}:443`;
  const officialHeaders = {
    authorization:
      "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  };

  function client() {
    return setupApp({ context, routes: runnerWssTicketRoutes })(
      runnerWssTicketsContract,
    );
  }

  function testState() {
    return setupApp({ context, routes: testRuntimeStateRoutes })(
      testRuntimeStateContract,
    );
  }

  async function setup() {
    const bdd = createBddApi(context);
    const api = createRunsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    const group = api.configureRunnerGroup();
    await api.grantProEntitlement(actor);
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    const agent = await bdd.createAgent(actor, {
      displayName: "WSS ticket fixture",
      description: "Tests a one-use ticket on an official Runner",
      visibility: "private",
    });
    const run = await api.createThreadRun(actor, {
      agentId: agent.agentId,
      prompt: "Connect directly",
    });
    await api.heartbeatRunner(group);
    const runnerId = randomUUID();
    await api.claimRunnerJob(run.runId, {
      runnerIdentity: { runnerId, heartbeatGeneration: 1 },
      runnerHostname: hostname,
    });
    await api.requestHeartbeatRunner(true, [200], {
      runnerId,
      group,
      mode: "running",
      snapshotSequence: 1,
      wssIngressServiceActive: true,
    });
    return {
      bdd,
      api,
      actor,
      runId: run.runId,
      runnerId,
      agentId: agent.agentId,
      group,
    };
  }

  type Fixture = Awaited<ReturnType<typeof setup>>;

  async function bootstrap(f: Fixture, actor = f.actor) {
    await f.bdd.readMe(actor);
    return client().bootstrap({
      params: { runId: f.runId },
      headers: { authorization: "Bearer clerk-session" },
      body: undefined,
    });
  }

  function consume(
    f: Fixture,
    ticket: string,
    overrides: Partial<{
      runId: string;
      runnerId: string;
      origin: string;
      authorization: string;
    }> = {},
  ) {
    return client().consume({
      headers: {
        authorization: overrides.authorization ?? officialHeaders.authorization,
      },
      body: {
        ticket,
        runId: overrides.runId ?? f.runId,
        runnerId: overrides.runnerId ?? f.runnerId,
        origin: overrides.origin ?? origin,
      },
    });
  }

  it("issues for an eligible active run without a separate issuance flag", async () => {
    const f = await setup();
    const res = await accept(bootstrap(f), [200]);
    expect(res.body.wssUrl).toBe(`${origin}/ws/${f.runnerId}`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
  });

  it("does not issue a ticket when WSS ingress is absent, down or reported active by a PAT", async () => {
    const f = await setup();
    await f.api.requestHeartbeatRunner(true, [200], {
      runnerId: f.runnerId,
      group: f.group,
      snapshotSequence: 2,
    });
    const missing = await accept(bootstrap(f), [404]);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
    await f.api.requestHeartbeatRunner(true, [200], {
      runnerId: f.runnerId,
      group: f.group,
      mode: "running",
      snapshotSequence: 3,
      wssIngressServiceActive: false,
    });
    const down = await accept(bootstrap(f), [404]);
    expect(down.headers.get("Cache-Control")).toBe("no-store");
    expect(down.body.error.code).toBe("NOT_FOUND");

    const pat = await f.api.createCliToken(f.actor);
    await f.api.requestHeartbeatRunnerAs(`Bearer ${pat.token}`, [200], {
      runnerId: f.runnerId,
      group: f.group,
      snapshotSequence: 4,
      wssIngressServiceActive: true,
    });
    const patReported = await accept(bootstrap(f), [404]);
    expect(patReported.body.error.code).toBe("NOT_FOUND");

    await f.api.requestHeartbeatRunner(true, [200], {
      runnerId: f.runnerId,
      group: f.group,
      snapshotSequence: 5,
      wssIngressServiceActive: true,
    });
    await accept(bootstrap(f), [200]);
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
  });

  it("denies new tickets on inactive WSS ingress without recalling an issued ticket", async () => {
    const f = await setup();
    const issued = await accept(bootstrap(f), [200]);

    await f.api.requestHeartbeatRunner(true, [200], {
      runnerId: f.runnerId,
      group: f.group,
      snapshotSequence: 2,
      wssIngressServiceActive: false,
    });
    const denied = await accept(bootstrap(f), [404]);
    expect(denied.body.error.code).toBe("NOT_FOUND");
    expect(denied.headers.get("Cache-Control")).toBe("no-store");
    const accepted = await accept(consume(f, issued.body.ticket), [200]);
    expect(accepted.body).toStrictEqual({
      runId: f.runId,
      runnerId: f.runnerId,
      origin,
      orgId: f.actor.orgId,
      userId: f.actor.userId,
    });
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
  });

  it("requires a Web session for issuance and official Runner auth for redemption", async () => {
    const f = await setup();
    const missingSession = await accept(
      client().bootstrap({
        params: { runId: f.runId },
        headers: {},
        body: undefined,
      }),
      [401],
    );
    expect(missingSession.headers.get("Cache-Control")).toBe("no-store");
    const pat = await f.api.createCliToken(f.actor);
    await accept(
      client().bootstrap({
        params: { runId: f.runId },
        headers: { authorization: `Bearer ${pat.token}` },
        body: undefined,
      }),
      [403],
    );
    const issued = await accept(bootstrap(f), [200]);
    await accept(
      consume(f, issued.body.ticket, {
        authorization: `Bearer ${pat.token}`,
      }),
      [403],
    );
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
  });

  it("issues owner-only without credential in the URL; consumes once on exact official audience", async () => {
    const f = await setup();
    await accept(bootstrap(f, f.bdd.user({ orgId: f.actor.orgId })), [404]);
    const issued = await accept(bootstrap(f), [200]);
    expect(issued.headers.get("Cache-Control")).toBe("no-store");
    expect(issued.body.wssUrl).toBe(`${origin}/ws/${f.runnerId}`);
    expect(issued.body.wssUrl).not.toContain(issued.body.ticket);
    expect(issued.body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(issued.body.expiresAt).getTime()).toBeGreaterThan(now());
    await accept(
      consume(f, issued.body.ticket, { runId: randomUUID() }),
      [404],
    );
    await accept(
      consume(f, issued.body.ticket, { runnerId: randomUUID() }),
      [404],
    );
    await accept(
      consume(f, issued.body.ticket, {
        origin: "wss://attacker.example.com:443",
      }),
      [404],
    );
    await accept(
      consume(f, issued.body.ticket, { authorization: "Bearer invalid" }),
      [401],
    );
    const accepted = await accept(consume(f, issued.body.ticket), [200]);
    expect(accepted.body).toStrictEqual({
      runId: f.runId,
      runnerId: f.runnerId,
      origin,
      orgId: f.actor.orgId,
      userId: f.actor.userId,
    });
    await accept(consume(f, issued.body.ticket), [404]);
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
  });

  it("does not infer listener capability from heartbeat alone, and requires a hostname and fresh snapshot", async () => {
    const f = await setup();
    // The claim has no version: a version floor is intentionally not used.
    await accept(bootstrap(f), [200]);
    await f.api.requestHeartbeatRunner(true, [200], {
      runnerId: f.runnerId,
      group: f.group,
      mode: "stopping",
      snapshotSequence: 2,
    });
    const stopped = await accept(bootstrap(f), [404]);
    expect(stopped.body.error.code).toBe("NOT_FOUND");
    await f.api.requestHeartbeatRunner(true, [200], {
      runnerId: f.runnerId,
      group: f.group,
      mode: "running",
      snapshotSequence: 3,
      wssIngressServiceActive: true,
    });
    mockNow(now() + 31_000);
    await accept(bootstrap(f), [404]);
    clearMockNow();

    const withoutHost = await f.api.createThreadRun(f.actor, {
      agentId: f.agentId,
      prompt: "No official hostname",
    });
    await f.api.heartbeatRunner(f.group);
    await f.api.claimRunnerJob(withoutHost.runId, {
      runnerIdentity: { runnerId: f.runnerId, heartbeatGeneration: 1 },
    });
    await accept(bootstrap({ ...f, runId: withoutHost.runId }), [404]);
    await f.api.requestCancelRun(f.actor, withoutHost.runId, [200]);
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
  });

  it("allows exactly one of two concurrent redemptions", async () => {
    const f = await setup();
    const issued = await accept(bootstrap(f), [200]);
    const pair = await Promise.all([
      consume(f, issued.body.ticket),
      consume(f, issued.body.ticket),
    ]);
    expect(
      pair
        .map((r) => {
          return r.status;
        })
        .sort(),
    ).toStrictEqual([200, 404]);
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
  });

  it("keeps concurrent issuance within the pending-ticket capacity", async () => {
    const f = await setup();
    const issued = await Promise.all(
      Array.from({ length: 17 }, () => {
        return bootstrap(f);
      }),
    );
    expect(
      issued.filter((result) => {
        return result.status === 200;
      }),
    ).toHaveLength(16);
    expect(
      issued.filter((result) => {
        return result.status === 404;
      }),
    ).toHaveLength(1);
    const first = issued.find((result) => {
      return result.status === 200;
    });
    if (!first || first.status !== 200) {
      throw new Error("Expected an issued ticket at the capacity boundary");
    }
    await accept(consume(f, first.body.ticket), [200]);
    await accept(bootstrap(f), [200]);
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
  });

  it("revokes pending tickets when revocation races consumption", async () => {
    const f = await setup();
    const first = await accept(bootstrap(f), [200]);
    const second = await accept(bootstrap(f), [200]);
    await f.bdd.readMe(f.actor);
    await Promise.all([
      accept(consume(f, first.body.ticket), [200, 404]),
      accept(
        client().revoke({
          params: { runId: f.runId },
          headers: { authorization: "Bearer clerk-session" },
          body: undefined,
        }),
        [204],
      ),
    ]);
    await accept(consume(f, first.body.ticket), [404]);
    await accept(consume(f, second.body.ticket), [404]);
    const fresh = await accept(bootstrap(f), [200]);
    const accepted = await accept(consume(f, fresh.body.ticket), [200]);
    expect(accepted.body).toStrictEqual({
      runId: f.runId,
      runnerId: f.runnerId,
      origin,
      orgId: f.actor.orgId,
      userId: f.actor.userId,
    });
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
  });

  it("rejects expired and revoked tickets and a terminal run", async () => {
    const f = await setup();
    const expired = await accept(bootstrap(f), [200]);
    await accept(
      testState().action({
        body: { action: "expire-runner-wss-tickets", run_id: f.runId },
      }),
      [200],
    );
    const expiryDenial = await accept(consume(f, expired.body.ticket), [404]);
    expect(expiryDenial.body.error.code).toBe("NOT_FOUND");
    const revoked = await accept(bootstrap(f), [200]);
    await f.bdd.readMe(f.actor);
    await accept(
      client().revoke({
        params: { runId: f.runId },
        headers: { authorization: "Bearer clerk-session" },
        body: undefined,
      }),
      [204],
    );
    await accept(consume(f, revoked.body.ticket), [404]);
    const terminal = await accept(bootstrap(f), [200]);
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
    await accept(consume(f, terminal.body.ticket), [404]);
    await accept(bootstrap(f), [404]);
  });
});
