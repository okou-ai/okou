import { createHash, randomUUID } from "node:crypto";

import { runnerWssTicketsContract } from "@okouai/api-contracts/contracts/runner-wss-tickets";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { runnerWssTicketRoutes } from "../runner-wss-tickets";
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

  function digestOf(ticket: string) {
    return createHash("sha256").update(ticket, "utf8").digest("hex");
  }

  function client() {
    return setupApp({ context, routes: runnerWssTicketRoutes })(
      runnerWssTicketsContract,
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

  async function revoke(f: Fixture, actor = f.actor, runId = f.runId) {
    await f.bdd.readMe(actor);
    return client().revoke({
      params: { runId },
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
      digest: digestOf(issued.body.ticket),
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
      digest: digestOf(issued.body.ticket),
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

  it("accepts repeated owned-run revocation with no pending tickets, including a terminal run", async () => {
    const f = await setup();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await accept(revoke(f), [204]);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
    await accept(revoke(f), [204]);
    await accept(revoke(f), [204]);
    await accept(bootstrap(f), [404]);
  });

  it("rejects unauthorized and unavailable revocation without invalidating the owner's ticket", async () => {
    const f = await setup();
    const issued = await accept(bootstrap(f), [200]);
    const unauthenticated = await accept(
      client().revoke({
        params: { runId: f.runId },
        headers: {},
        body: undefined,
      }),
      [401],
    );
    expect(unauthenticated.headers.get("Cache-Control")).toBe("no-store");
    const pat = await f.api.createCliToken(f.actor);
    const forbidden = await accept(
      client().revoke({
        params: { runId: f.runId },
        headers: { authorization: `Bearer ${pat.token}` },
        body: undefined,
      }),
      [403],
    );
    expect(forbidden.headers.get("Cache-Control")).toBe("no-store");
    const foreignUser = f.bdd.user({ orgId: f.actor.orgId });
    const otherOrg = f.bdd.user({ userId: f.actor.userId });
    const unavailable = [
      await accept(revoke(f, foreignUser), [404]),
      await accept(revoke(f, otherOrg), [404]),
      await accept(revoke(f, f.actor, randomUUID()), [404]),
    ];
    for (const response of unavailable) {
      expect(response.body.error).toStrictEqual({
        code: "NOT_FOUND",
        message: "WSS connection unavailable",
      });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    const accepted = await accept(consume(f, issued.body.ticket), [200]);
    expect(accepted.body.userId).toBe(f.actor.userId);
    expect(accepted.body.orgId).toBe(f.actor.orgId);
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
  });

  it("revokes every pending ticket while preserving one-use consumption and later issuance", async () => {
    const f = await setup();
    const consumed = await accept(bootstrap(f), [200]);
    await accept(consume(f, consumed.body.ticket), [200]);
    const pending = [];
    // Revoked pending tickets must not consume the fresh 16-ticket quota.
    for (let index = 0; index < 16; index++) {
      pending.push(await accept(bootstrap(f), [200]));
    }
    await accept(revoke(f), [204]);
    await accept(revoke(f), [204]);
    await accept(consume(f, consumed.body.ticket), [404]);
    for (const issued of pending) {
      const denied = await accept(consume(f, issued.body.ticket), [404]);
      expect(denied.body.error.code).toBe("NOT_FOUND");
    }
    const fresh = await accept(bootstrap(f), [200]);
    await accept(consume(f, fresh.body.ticket), [200]);
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
  });

  it("revokes pending tickets when revocation races consumption", async () => {
    const f = await setup();
    const first = await accept(bootstrap(f), [200]);
    const second = await accept(bootstrap(f), [200]);
    await f.bdd.readMe(f.actor);
    const [raced] = await Promise.all([
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
    if (raced.status === 200) {
      const checked = await accept(
        client().check({
          headers: officialHeaders,
          body: {
            runnerId: f.runnerId,
            origin,
            authorizations: [
              {
                runId: f.runId,
                digest: raced.body.digest,
              },
            ],
          },
        }),
        [200],
      );
      expect(checked.body).toStrictEqual({ authorized: [] });
    }
    const fresh = await accept(bootstrap(f), [200]);
    const accepted = await accept(consume(f, fresh.body.ticket), [200]);
    expect(accepted.body).toStrictEqual({
      runId: f.runId,
      runnerId: f.runnerId,
      origin,
      orgId: f.actor.orgId,
      userId: f.actor.userId,
      digest: digestOf(fresh.body.ticket),
    });
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
  });

  it("revokes consumed access without cancelling the Run and permits a fresh bootstrap", async () => {
    const f = await setup();
    const issued = await accept(bootstrap(f), [200]);
    const admitted = await accept(consume(f, issued.body.ticket), [200]);
    const old = {
      runId: f.runId,
      digest: admitted.body.digest,
    };
    const check = (authorizations: (typeof old)[]) => {
      return client().check({
        headers: officialHeaders,
        body: { runnerId: f.runnerId, origin, authorizations },
      });
    };
    const current = await accept(check([old]), [200]);
    expect(current.body).toStrictEqual({ authorized: [old] });
    expect(current.headers.get("Cache-Control")).toBe("no-store");
    // Wrong owner cannot revoke a consumed stream's ticket.
    await f.bdd.readMe(f.bdd.user({ orgId: f.actor.orgId }));
    await accept(
      client().revoke({
        params: { runId: f.runId },
        headers: { authorization: "Bearer clerk-session" },
        body: undefined,
      }),
      [404],
    );
    expect((await accept(check([old]), [200])).body).toStrictEqual({
      authorized: [old],
    });
    await f.bdd.readMe(f.actor);
    await accept(
      client().revoke({
        params: { runId: f.runId },
        headers: { authorization: "Bearer clerk-session" },
        body: undefined,
      }),
      [204],
    );
    expect((await accept(check([old]), [200])).body).toStrictEqual({
      authorized: [],
    });
    // Same live Run remains eligible; only its WSS access changed.
    const fresh = await accept(bootstrap(f), [200]);
    const next = await accept(consume(f, fresh.body.ticket), [200]);
    expect(next.body.digest).not.toBe(old.digest);
    const newer = {
      runId: f.runId,
      digest: next.body.digest,
    };
    expect((await accept(check([old, newer]), [200])).body).toStrictEqual({
      authorized: [newer],
    });
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
    expect((await accept(check([newer]), [200])).body).toStrictEqual({
      authorized: [],
    });
  });

  it("checks only the exact official audience and bounds current-state reads", async () => {
    const f = await setup();
    const issued = await accept(bootstrap(f), [200]);
    const admitted = await accept(consume(f, issued.body.ticket), [200]);
    const key = {
      runId: f.runId,
      digest: admitted.body.digest,
    };
    const body = { runnerId: f.runnerId, origin, authorizations: [key] };
    const missing = await accept(client().check({ headers: {}, body }), [401]);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
    const pat = await f.api.createCliToken(f.actor);
    await accept(
      client().check({
        headers: { authorization: `Bearer ${pat.token}` },
        body,
      }),
      [403],
    );
    for (const wrong of [
      { ...body, runnerId: randomUUID() },
      { ...body, origin: "wss://wrong.example.com:443" },
      { ...body, authorizations: [{ ...key, runId: randomUUID() }] },
      {
        ...body,
        authorizations: [{ ...key, digest: "0".repeat(64) }],
      },
    ]) {
      expect(
        (
          await accept(
            client().check({ headers: officialHeaders, body: wrong }),
            [200],
          )
        ).body,
      ).toStrictEqual({ authorized: [] });
    }
    await accept(
      client().check({
        headers: officialHeaders,
        body: { ...body, authorizations: [] },
      }),
      [400],
    );
    await accept(
      client().check({
        headers: officialHeaders,
        body: {
          ...body,
          authorizations: Array.from({ length: 33 }, () => {
            return key;
          }),
        },
      }),
      [400],
    );
    await accept(
      client().check({
        headers: officialHeaders,
        body: {
          ...body,
          authorizations: [{ ...key, digest: "invalid" }],
        },
      }),
      [400],
    );
    // Ingress down suppresses issuance, not live authorization or ordinary work.
    await f.api.requestHeartbeatRunner(true, [200], {
      runnerId: f.runnerId,
      group: f.group,
      mode: "draining",
      snapshotSequence: 2,
      wssIngressServiceActive: false,
    });
    expect(
      (await accept(client().check({ headers: officialHeaders, body }), [200]))
        .body,
    ).toStrictEqual({ authorized: [key] });
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
  });

  it("requires one-use consumption before a ticket can renew established access", async () => {
    const f = await setup();
    const issued = await accept(bootstrap(f), [200]);
    const key = { runId: f.runId, digest: digestOf(issued.body.ticket) };
    const check = () => {
      return client().check({
        headers: officialHeaders,
        body: { runnerId: f.runnerId, origin, authorizations: [key] },
      });
    };
    expect((await accept(check(), [200])).body).toStrictEqual({
      authorized: [],
    });
    const consumed = await accept(consume(f, issued.body.ticket), [200]);
    expect(consumed.body.digest).toBe(key.digest);
    expect((await accept(check(), [200])).body).toStrictEqual({
      authorized: [key],
    });
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
  });

  it("retains consumed authority beyond redemption expiry and bounded daily cleanup", async () => {
    const f = await setup();
    const issued = await accept(bootstrap(f), [200]);
    const consumed = await accept(consume(f, issued.body.ticket), [200]);
    const key = { runId: f.runId, digest: consumed.body.digest };
    mockNow(now() + 2 * 24 * 60 * 60 * 1000);
    await f.api.requestHeartbeatRunner(true, [200], {
      runnerId: f.runnerId,
      group: f.group,
      mode: "running",
      snapshotSequence: 2,
      wssIngressServiceActive: true,
    });
    // New issuance exercises the real cleanup path with the old row >1 day old.
    await accept(bootstrap(f), [200]);
    expect(
      (
        await accept(
          client().check({
            headers: officialHeaders,
            body: { runnerId: f.runnerId, origin, authorizations: [key] },
          }),
          [200],
        )
      ).body,
    ).toStrictEqual({ authorized: [key] });
    await accept(consume(f, issued.body.ticket), [404]);
    await accept(revoke(f), [204]);
    expect(
      (
        await accept(
          client().check({
            headers: officialHeaders,
            body: { runnerId: f.runnerId, origin, authorizations: [key] },
          }),
          [200],
        )
      ).body,
    ).toStrictEqual({ authorized: [] });
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
  });

  it("revokes every consumed ticket, not just pending tickets or one connection", async () => {
    const f = await setup();
    const authorizations: { runId: string; digest: string }[] = [];
    for (let index = 0; index < 2; index++) {
      const issued = await accept(bootstrap(f), [200]);
      const consumed = await accept(consume(f, issued.body.ticket), [200]);
      authorizations.push({ runId: f.runId, digest: consumed.body.digest });
    }
    const check = () => {
      return client().check({
        headers: officialHeaders,
        body: { runnerId: f.runnerId, origin, authorizations },
      });
    };
    const granted = await accept(check(), [200]);
    expect(granted.body.authorized).toHaveLength(2);
    expect(granted.body.authorized).toStrictEqual(
      expect.arrayContaining(authorizations),
    );
    await accept(revoke(f), [204]);
    expect((await accept(check(), [200])).body).toStrictEqual({
      authorized: [],
    });
    await accept(bootstrap(f), [200]);
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
  });

  it("rejects revoked tickets and a terminal run", async () => {
    const f = await setup();
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
    const revokedDenial = await accept(consume(f, revoked.body.ticket), [404]);
    expect(revokedDenial.body.error.code).toBe("NOT_FOUND");
    const terminal = await accept(bootstrap(f), [200]);
    await f.api.requestCancelRun(f.actor, f.runId, [200]);
    await accept(consume(f, terminal.body.ticket), [404]);
    await accept(bootstrap(f), [404]);
  });
});
