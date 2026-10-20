import { createHash, randomUUID } from "node:crypto";

import { runnerWssTicketsContract } from "@okouai/api-contracts/contracts/runner-wss-tickets";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { runnerWssTicketRoutes } from "../runner-wss-tickets";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicChatActor } from "./helpers/public-chat-actor";

describe("direct Runner WSS ticket boundary", () => {
  const context = testContext();
  const hostname = "runner-a.example.com";
  const origin = `wss://${hostname}:443`;
  const officialHeaders = {
    authorization:
      "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  };

  function digestOf(ticket: string) {
    return createHash("sha256").update(ticket, "utf8").digest("hex");
  }

  function client() {
    return setupApp({ context, routes: runnerWssTicketRoutes })(
      runnerWssTicketsContract,
    );
  }

  async function setup() {
    // Native PostgreSQL owns the concurrent redemption and database-clock cases.
    const owned = await publicChatActor(context, {
      restoreEnvironment: clearMockNow,
    });
    const bdd = createBddApi(context);
    const api = createRunsApi(context);
    return await owned.run(async () => {
      const run = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "Connect directly",
      });
      await api.heartbeatRunner(owned.runnerGroup);
      const runnerId = randomUUID();
      await owned.claimRunnerRun(run.runId, {
        runnerIdentity: { runnerId, heartbeatGeneration: 1 },
        runnerHostname: hostname,
      });
      await api.requestHeartbeatRunner(true, [200], {
        runnerId,
        group: owned.runnerGroup,
        mode: "running",
        snapshotSequence: 1,
        wssIngressServiceActive: true,
      });
      return {
        ...owned,
        bdd,
        api,
        runId: run.runId,
        runnerId,
        group: owned.runnerGroup,
      };
    });
  }

  type Fixture = Awaited<ReturnType<typeof setup>>;

  async function bootstrap(f: Fixture, actor = f.actor) {
    return await f.run(async () => {
      await f.bdd.readMe(actor);
      return client().bootstrap({
        params: { runId: f.runId },
        headers: { authorization: "Bearer clerk-session" },
        body: undefined,
      });
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
    return f.run(() => {
      return client().consume({
        headers: {
          authorization:
            overrides.authorization ?? officialHeaders.authorization,
        },
        body: {
          ticket,
          runId: overrides.runId ?? f.runId,
          runnerId: overrides.runnerId ?? f.runnerId,
          origin: overrides.origin ?? origin,
        },
      });
    });
  }

  function heartbeat(
    f: Fixture,
    body: Parameters<
      ReturnType<typeof createRunsApi>["requestHeartbeatRunner"]
    >[2],
  ) {
    return f.run(() => {
      return f.api.requestHeartbeatRunner(true, [200], body);
    });
  }

  it("releases claimed slots after an owned operation", async () => {
    const observation: { fixture?: Fixture } = {};
    // Finished callbacks run in reverse order: observe after the actor cleans up.
    onTestFinished(async () => {
      const fixture = observation.fixture;
      if (fixture) {
        const queue = await fixture.api.readRunQueue(fixture.actor);
        expect(queue.body.concurrency.active).toBe(0);
      }
    });
    const f = await setup();
    observation.fixture = f;
    const queue = await f.api.readRunQueue(f.actor);
    expect(queue.body.concurrency.active).toBe(1);
  });

  it("issues for an eligible active run without a separate issuance flag", async () => {
    const f = await setup();
    const res = await accept(bootstrap(f), [200]);
    expect(res.body.wssUrl).toBe(`${origin}/ws/${f.runnerId}`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not issue a ticket when WSS ingress is absent, down or reported active by a PAT", async () => {
    const f = await setup();
    await heartbeat(f, {
      runnerId: f.runnerId,
      group: f.group,
      snapshotSequence: 2,
    });
    const missing = await accept(bootstrap(f), [404]);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
    await heartbeat(f, {
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
    await f.run(() => {
      return f.api.requestHeartbeatRunnerAs(`Bearer ${pat.token}`, [200], {
        runnerId: f.runnerId,
        group: f.group,
        snapshotSequence: 4,
        wssIngressServiceActive: true,
      });
    });
    const patReported = await accept(bootstrap(f), [404]);
    expect(patReported.body.error.code).toBe("NOT_FOUND");

    await heartbeat(f, {
      runnerId: f.runnerId,
      group: f.group,
      snapshotSequence: 5,
      wssIngressServiceActive: true,
    });
    await accept(bootstrap(f), [200]);
  });

  it("denies new tickets on inactive WSS ingress without recalling an issued ticket", async () => {
    const f = await setup();
    const issued = await accept(bootstrap(f), [200]);

    await heartbeat(f, {
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
      digest: digestOf(issued.body.ticket),
    });
  });

  it("requires authentication for ticket issuance without caching the rejection", async () => {
    const missingSession = await accept(
      client().bootstrap({
        params: { runId: randomUUID() },
        headers: {},
        body: undefined,
      }),
      [401],
    );
    expect(missingSession.headers.get("Cache-Control")).toBe("no-store");
  });

  it("accepts an owner CLI token for issuance and requires official Runner auth for redemption", async () => {
    const f = await setup();
    const pat = await f.api.createCliToken(f.actor);
    const issued = await accept(
      client().bootstrap({
        params: { runId: f.runId },
        headers: { authorization: `Bearer ${pat.token}` },
        body: undefined,
      }),
      [200],
    );
    expect(issued.headers.get("Cache-Control")).toBe("no-store");
    expect(issued.body.wssUrl).toBe(`${origin}/ws/${f.runnerId}`);
    await accept(
      consume(f, issued.body.ticket, {
        authorization: `Bearer ${pat.token}`,
      }),
      [403],
    );
    const redeemed = await accept(consume(f, issued.body.ticket), [200]);
    expect(redeemed.body).toMatchObject({
      runId: f.runId,
      runnerId: f.runnerId,
      userId: f.actor.userId,
      orgId: f.actor.orgId,
    });
  });

  it("denies CLI ticket issuance to another user or organization without revealing the Run", async () => {
    const f = await setup();
    for (const actor of [f.bdd.user({ orgId: f.actor.orgId }), f.bdd.user()]) {
      const pat = await f.api.createCliToken(actor);
      await f.bdd.readMe(actor);
      const denied = await accept(
        client().bootstrap({
          params: { runId: f.runId },
          headers: { authorization: `Bearer ${pat.token}` },
          body: undefined,
        }),
        [404],
      );
      expect(denied.body.error.code).toBe("NOT_FOUND");
      expect(denied.headers.get("Cache-Control")).toBe("no-store");
    }
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
    const wrongRun = await accept(
      consume(f, issued.body.ticket, { runId: randomUUID() }),
      [404],
    );
    expect(wrongRun.headers.get("Cache-Control")).toBe("no-store");
    const wrongRunner = await accept(
      consume(f, issued.body.ticket, { runnerId: randomUUID() }),
      [404],
    );
    expect(wrongRunner.headers.get("Cache-Control")).toBe("no-store");
    const wrongOrigin = await accept(
      consume(f, issued.body.ticket, {
        origin: "wss://attacker.example.com:443",
      }),
      [404],
    );
    expect(wrongOrigin.headers.get("Cache-Control")).toBe("no-store");
    const unauthenticated = await accept(
      consume(f, issued.body.ticket, { authorization: "Bearer invalid" }),
      [401],
    );
    expect(unauthenticated.headers.get("Cache-Control")).toBe("no-store");
    const accepted = await accept(consume(f, issued.body.ticket), [200]);
    expect(accepted.body).toStrictEqual({
      runId: f.runId,
      runnerId: f.runnerId,
      origin,
      orgId: f.actor.orgId,
      userId: f.actor.userId,
      digest: digestOf(issued.body.ticket),
    });
    const replay = await accept(consume(f, issued.body.ticket), [404]);
    expect(accepted.headers.get("Cache-Control")).toBe("no-store");
    expect(replay.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not infer listener capability from heartbeat alone, and requires a hostname and fresh snapshot", async () => {
    const f = await setup();
    // The claim has no version: a version floor is intentionally not used.
    await accept(bootstrap(f), [200]);
    await heartbeat(f, {
      runnerId: f.runnerId,
      group: f.group,
      mode: "stopping",
      snapshotSequence: 2,
    });
    const stopped = await accept(bootstrap(f), [404]);
    expect(stopped.body.error.code).toBe("NOT_FOUND");
    await heartbeat(f, {
      runnerId: f.runnerId,
      group: f.group,
      mode: "running",
      snapshotSequence: 3,
      wssIngressServiceActive: true,
    });
    mockNow(now() + 31_000);
    await accept(bootstrap(f), [404]);
    clearMockNow();

    const withoutHost = await f.run(async () => {
      const run = await f.api.createThreadRun(f.actor, {
        agentId: f.agentId,
        prompt: "No official hostname",
      });
      await f.api.heartbeatRunner(f.group);
      await f.claimRunnerRun(run.runId, {
        runnerIdentity: { runnerId: f.runnerId, heartbeatGeneration: 1 },
      });
      return run;
    });
    await accept(bootstrap({ ...f, runId: withoutHost.runId }), [404]);
  });

  it.each(["mode", "group", "freshness"] as const)(
    "preserves an issued ticket through temporary Runner %s ineligibility",
    async (reason) => {
      const f = await setup();
      const issued = await accept(bootstrap(f), [200]);
      if (reason === "freshness") {
        mockNow(now() + 31_000);
      } else {
        await heartbeat(f, {
          runnerId: f.runnerId,
          group: reason === "group" ? "vm0/other" : f.group,
          mode: reason === "mode" ? "stopping" : "running",
          snapshotSequence: 2,
          wssIngressServiceActive: true,
        });
      }
      const denied = await accept(consume(f, issued.body.ticket), [404]);
      expect(denied.body.error.code).toBe("NOT_FOUND");
      expect(denied.headers.get("Cache-Control")).toBe("no-store");
      clearMockNow();
      await heartbeat(f, {
        runnerId: f.runnerId,
        group: f.group,
        mode: "running",
        snapshotSequence: 3,
        wssIngressServiceActive: true,
      });
      const redeemed = await accept(consume(f, issued.body.ticket), [200]);
      expect(redeemed.body).toStrictEqual({
        runId: f.runId,
        runnerId: f.runnerId,
        origin,
        orgId: f.actor.orgId,
        userId: f.actor.userId,
        digest: digestOf(issued.body.ticket),
      });
      expect(redeemed.headers.get("Cache-Control")).toBe("no-store");
    },
  );

  it("rejects extra consume fields without spending the ticket or caching the response", async () => {
    const f = await setup();
    const issued = await accept(bootstrap(f), [200]);
    const raw = setupRawAppRequest({ context, routes: runnerWssTicketRoutes });
    const rejected = await f.run(() => {
      return raw("/api/runners/wss/tickets/consume", {
        method: "POST",
        headers: { ...officialHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          runId: f.runId,
          runnerId: f.runnerId,
          origin,
          ticket: issued.body.ticket,
          extra: true,
        }),
      });
    });
    expect(rejected.status).toBe(400);
    expect(rejected.headers.get("Cache-Control")).toBe("no-store");
    const redeemed = await accept(consume(f, issued.body.ticket), [200]);
    expect(redeemed.body.digest).toBe(digestOf(issued.body.ticket));
    expect(redeemed.headers.get("Cache-Control")).toBe("no-store");
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
  });

  it("expires pending tickets and reopens issuance quota", async () => {
    const f = await setup();
    const oldest = await accept(bootstrap(f), [200]);
    await Promise.all(
      Array.from({ length: 15 }, () => {
        return accept(bootstrap(f), [200]);
      }),
    );
    let fresh = await bootstrap(f);
    expect(fresh.status).toBe(404);

    // Observe quota reopening through the API, with real database time. Keep
    // Runner freshness independent of the ticket's redemption deadline.
    let sequence = 1;
    await expect
      .poll(
        async () => {
          await heartbeat(f, {
            runnerId: f.runnerId,
            group: f.group,
            snapshotSequence: ++sequence,
            wssIngressServiceActive: true,
          });
          fresh = await bootstrap(f);
          return fresh.status;
        },
        { timeout: 40_000, interval: 1000 },
      )
      .toBe(200);

    const expired = await accept(consume(f, oldest.body.ticket), [404]);
    expect(expired.body.error.code).toBe("NOT_FOUND");
    if (fresh.status !== 200) {
      throw new Error(
        "Expected a fresh ticket after the pending quota reopened",
      );
    }
    await accept(consume(f, fresh.body.ticket), [200]);
  }, 45_000);

  it("requires a fresh ticket for a second admission", async () => {
    const f = await setup();
    const first = await accept(bootstrap(f), [200]);
    const admitted = await accept(consume(f, first.body.ticket), [200]);
    await accept(consume(f, first.body.ticket), [404]);

    const fresh = await accept(bootstrap(f), [200]);
    expect(fresh.body.ticket).not.toBe(first.body.ticket);
    const next = await accept(consume(f, fresh.body.ticket), [200]);
    expect(next.body.digest).not.toBe(admitted.body.digest);
    expect(next.body.runId).toBe(f.runId);
    expect(next.headers.get("Cache-Control")).toBe("no-store");
    await accept(consume(f, fresh.body.ticket), [404]);
  });

  it("rejects tickets for a terminal Run", async () => {
    const f = await setup();
    const terminal = await accept(bootstrap(f), [200]);
    await f.run(() => {
      return f.api.requestCancelRun(f.actor, f.runId, [200]);
    });
    const denied = await accept(consume(f, terminal.body.ticket), [404]);
    expect(denied.body.error.code).toBe("NOT_FOUND");
    expect(denied.headers.get("Cache-Control")).toBe("no-store");
    await accept(bootstrap(f), [404]);
  });
});
