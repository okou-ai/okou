import { createHash, randomUUID } from "node:crypto";
import { runnerFileDownloadsContract } from "@okouai/api-contracts/contracts/runner-file-downloads";
import { runnerWssTicketsContract } from "@okouai/api-contracts/contracts/runner-wss-tickets";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { runnerFileDownloadRoutes } from "../runner-file-downloads";
import { runnerWssTicketRoutes } from "../runner-wss-tickets";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicChatActor } from "./helpers/public-chat-actor";

describe("native file download authority", () => {
  const context = testContext();
  const hostname = "runner-a.example.com";
  const origin = `https://${hostname}:443`;
  const headers = {
    authorization:
      "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  };
  const path = ["home", "user", "binary.bin"].map((name) => {
    return Buffer.from(name).toString("base64url");
  });
  const client = () => {
    return setupApp({ context, routes: runnerFileDownloadRoutes })(
      runnerFileDownloadsContract,
    );
  };

  async function setup() {
    const owned = await publicChatActor(context, {
      restoreEnvironment: clearMockNow,
    });
    const api = createRunsApi(context);
    const bdd = createBddApi(context);
    return owned.run(async () => {
      const run = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "Download a file",
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
        snapshotSequence: 1,
        wssIngressServiceActive: true,
        fileDownloadServiceVersion: 1,
      });
      return { ...owned, api, bdd, runId: run.runId, runnerId };
    });
  }
  type Fixture = Awaited<ReturnType<typeof setup>>;
  function bootstrap(f: Fixture, actor = f.actor) {
    return f.run(async () => {
      await f.bdd.readMe(actor);
      return client().bootstrap({
        params: { runId: f.runId },
        headers: { authorization: "Bearer clerk-session" },
        body: { path },
      });
    });
  }
  function ticket(url: string) {
    return new URL(url).pathname.split("/").at(-1) ?? "";
  }
  function consume(
    f: Fixture,
    secret: string,
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
          authorization: overrides.authorization ?? headers.authorization,
        },
        body: {
          runId: overrides.runId ?? f.runId,
          runnerId: overrides.runnerId ?? f.runnerId,
          origin: overrides.origin ?? origin,
          ticket: secret,
        },
      });
    });
  }

  it("requires authentication before preparing a native download", async () => {
    const response = await accept(
      client().bootstrap({
        params: { runId: randomUUID() },
        headers: {},
        body: { path },
      }),
      [401],
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns only a short-lived native URL and atomically spends exact owner/path authority once", async () => {
    const f = await setup();
    await accept(bootstrap(f, f.bdd.user({ orgId: f.actor.orgId })), [404]);
    await accept(bootstrap(f, f.bdd.user()), [404]);
    const issued = await accept(bootstrap(f), [200]);
    expect(Object.keys(issued.body).sort()).toStrictEqual([
      "downloadUrl",
      "expiresAt",
    ]);
    const prefix = `${origin}/downloads/${f.runnerId}/${f.runId}/`;
    expect(issued.body.downloadUrl.startsWith(prefix)).toBeTruthy();
    expect(issued.body.downloadUrl.slice(prefix.length)).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const secret = ticket(issued.body.downloadUrl);
    for (const overrides of [
      { runId: randomUUID() },
      { runnerId: randomUUID() },
      { origin: "https://other.example.com:443" },
    ]) {
      await accept(consume(f, secret, overrides), [404]);
    }
    await accept(
      consume(f, secret, { authorization: "Bearer invalid" }),
      [401],
    );
    const pat = await f.api.createCliToken(f.actor);
    await accept(
      consume(f, secret, { authorization: `Bearer ${pat.token}` }),
      [403],
    );
    const redeemed = await accept(consume(f, secret), [200]);
    expect(redeemed.body).toStrictEqual({
      runId: f.runId,
      runnerId: f.runnerId,
      orgId: f.actor.orgId,
      userId: f.actor.userId,
      origin,
      path,
      digest: createHash("sha256").update(secret).digest("hex"),
    });
    expect(redeemed.headers.get("cache-control")).toBe("no-store");
    await accept(consume(f, secret), [404]);
    await accept(bootstrap(f), [200]);
  });

  it("has one pending grant per Run and exactly one concurrent consumer", async () => {
    const f = await setup();
    const pair = await Promise.all([bootstrap(f), bootstrap(f)]);
    expect(
      pair
        .map((r) => {
          return r.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    const issued = pair.find((r) => {
      return r.status === 200;
    });
    if (!issued || issued.status !== 200) {
      throw new Error("Expected one grant");
    }
    const redeemed = await Promise.all([
      consume(f, ticket(issued.body.downloadUrl)),
      consume(f, ticket(issued.body.downloadUrl)),
    ]);
    expect(
      redeemed
        .map((r) => {
          return r.status;
        })
        .sort(),
    ).toStrictEqual([200, 404]);
  });

  it("does not accept a WSS ticket as file authority", async () => {
    const f = await setup();
    const wss = await f.run(async () => {
      await f.bdd.readMe(f.actor);
      return accept(
        setupApp({ context, routes: runnerWssTicketRoutes })(
          runnerWssTicketsContract,
        ).bootstrap({
          params: { runId: f.runId },
          headers: { authorization: "Bearer clerk-session" },
          body: undefined,
        }),
        [200],
      );
    });
    const denied = await accept(consume(f, wss.body.ticket), [404]);
    expect(denied.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects malformed raw paths and extra fields without spending authority", async () => {
    const f = await setup();
    const raw = setupRawAppRequest({
      context,
      routes: runnerFileDownloadRoutes,
    });
    for (const invalidPath of [[".."], ["a/b"], [""]]) {
      const response = await f.run(async () => {
        await f.bdd.readMe(f.actor);
        return raw(`/api/runs/${f.runId}/files/download`, {
          method: "POST",
          headers: {
            authorization: "Bearer clerk-session",
            "content-type": "application/json",
          },
          body: JSON.stringify({ path: invalidPath }),
        });
      });
      expect(response.status).toBe(400);
    }
    const issued = await accept(bootstrap(f), [200]);
    const secret = ticket(issued.body.downloadUrl);
    const invalid = await f.run(() => {
      return raw("/api/runners/files/downloads/consume", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          runId: f.runId,
          runnerId: f.runnerId,
          origin,
          ticket: secret,
          path: ["etc", "passwd"],
        }),
      });
    });
    expect(invalid.status).toBe(400);
    await accept(consume(f, secret), [200]);
  });

  it("requires independent fresh official listener capability and respects heartbeat ordering", async () => {
    const f = await setup();
    const beat = (sequence: number, capability?: 1) => {
      return f.run(() => {
        return f.api.requestHeartbeatRunner(true, [200], {
          runnerId: f.runnerId,
          group: f.runnerGroup,
          snapshotSequence: sequence,
          wssIngressServiceActive: true,
          ...(capability === undefined
            ? {}
            : { fileDownloadServiceVersion: capability }),
        });
      });
    };
    await beat(2);
    await accept(bootstrap(f), [404]);
    await beat(1, 1);
    await accept(bootstrap(f), [404]);
    await beat(3, 1);
    mockNow(now() + 31_000);
    await accept(bootstrap(f), [404]);
    clearMockNow();
    const pat = await f.api.createCliToken(f.actor);
    await f.run(() => {
      return f.api.requestHeartbeatRunnerAs(`Bearer ${pat.token}`, [200], {
        runnerId: f.runnerId,
        group: f.runnerGroup,
        snapshotSequence: 4,
        wssIngressServiceActive: true,
        fileDownloadServiceVersion: 1,
      });
    });
    await accept(bootstrap(f), [404]);
    await beat(5, 1);
    const available = await accept(bootstrap(f), [200]);
    expect(available.body.downloadUrl).toContain(
      `/downloads/${f.runnerId}/${f.runId}/`,
    );
  });

  it("rejects grants when the Run ends or the listener is withdrawn", async () => {
    const f = await setup();
    const issued = await accept(bootstrap(f), [200]);
    await f.run(() => {
      return f.api.requestHeartbeatRunner(true, [200], {
        runnerId: f.runnerId,
        group: f.runnerGroup,
        snapshotSequence: 2,
        wssIngressServiceActive: true,
      });
    });
    await accept(consume(f, ticket(issued.body.downloadUrl)), [404]);
    await f.run(() => {
      return f.api.requestCancelRun(f.actor, f.runId, [200]);
    });
    await accept(consume(f, ticket(issued.body.downloadUrl)), [404]);
    const terminal = await accept(bootstrap(f), [404]);
    expect(terminal.headers.get("cache-control")).toBe("no-store");
  });

  it("expires abandoned credentials using database time and restores pending capacity", async () => {
    const f = await setup();
    const old = await accept(bootstrap(f), [200]);
    let sequence = 1;
    await expect
      .poll(
        async () => {
          await f.run(() => {
            return f.api.requestHeartbeatRunner(true, [200], {
              runnerId: f.runnerId,
              group: f.runnerGroup,
              snapshotSequence: ++sequence,
              wssIngressServiceActive: true,
              fileDownloadServiceVersion: 1,
            });
          });
          return (await bootstrap(f)).status;
        },
        { timeout: 40_000, interval: 1000 },
      )
      .toBe(200);
    await accept(consume(f, ticket(old.body.downloadUrl)), [404]);
  }, 45_000);
});
