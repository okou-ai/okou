import { createHmac } from "node:crypto";
import { Response } from "miniflare";
import { describe, expect, it as baseTest } from "vitest";
import { number, object } from "zod";
import {
  APPLICATION_ID,
  BOT_TOKEN,
  BOT_USER_ID,
  CHANNEL_ID,
  GATEWAY_SECRET,
  GUILD_ID,
  MESSAGE_ID,
  createRelay,
} from "./relay-fixture";
import { createRelayPhases } from "./relay-phases";

describe("Discord Gateway relay", () => {
  const it = baseTest
    .extend("relayBindings", (): Record<string, string> => {
      return {};
    })
    .extend("relayPhases", ({ onTestFailed, signal }) => {
      const { elapsedMs, phases, wait } = createRelayPhases(signal);
      onTestFailed(() => {
        console.error("Discord relay test progress", {
          elapsedMs: elapsedMs(),
          phases,
        });
      });
      return { elapsedMs, wait };
    })
    .extend("relay", ({ relayBindings, relayPhases: { wait } }) => {
      return wait("create relay fixture", () => {
        return createRelay(relayBindings);
      });
    });

  it.beforeEach(({ relay, relayPhases: { wait } }) => {
    // Bound the cold process start with the setup deadline.
    return wait("workerd readiness", () => {
      return relay.ready();
    });
  });

  describe("disabled at startup", () => {
    it.override("relayBindings", { DISCORD_GATEWAY_ENABLED: "false" });
    it("authenticates management and keeps a disabled relay stopped", async ({
      relay,
      relayPhases: { wait },
    }) => {
      const unauthenticatedHealth = await wait("unauthenticated health", () => {
        return relay.request("/health", null);
      });
      expect(unauthenticatedHealth.status).toBe(401);
      const wrongTokenStart = await wait("start with delivery secret", () => {
        return relay.request("/start", GATEWAY_SECRET);
      });
      expect(wrongTokenStart.status).toBe(401);
      const start = await wait("authenticated disabled start", () => {
        return relay.request("/start");
      });
      expect(start.status).toBe(409);
      const health = await wait("authenticated health", () => {
        return relay.request("/health");
      });
      expect(health.headers.get("Cache-Control")).toBe("no-store");
      const state = await wait("decode health response", () => {
        return health.json();
      });
      expect(state).toEqual({
        enabled: false,
        running: false,
        connected: false,
        resumable: false,
        connection: {
          stage: "stopped",
          stageStartedAt: expect.any(Number),
          httpStatus: null,
          lastFailure: null,
          failures: 0,
          reconnectAt: null,
        },
        pending: 0,
        deadLettered: 0,
        deliveryFailures: 0,
        oldestPendingAgeMs: null,
        fatal: null,
      });
      expect(relay.opened).toEqual([]);
      expect(relay.forwarded).toEqual([]);
    });
  });

  it("identifies with least-privileged intents and signs the unchanged event", async ({
    relay,
  }) => {
    const gateway = await relay.start();
    gateway.hello();

    expect(await gateway.next(2)).toEqual({
      op: 2,
      d: {
        token: BOT_TOKEN,
        intents: 4609,
        properties: { os: "linux", browser: "okou", device: "okou" },
        shard: [0, 1],
      },
    });
    gateway.ready();
    gateway.message();

    const delivery = await relay.deliveries.next();
    expect(delivery.method).toBe("POST");
    expect(delivery.contentType).toBe("application/json");
    expect(delivery.timestamp).toMatch(/^\d+$/u);
    expect(JSON.parse(delivery.rawBody)).toEqual({
      version: 1,
      applicationId: APPLICATION_ID,
      eventType: "MESSAGE_CREATE",
      eventId: `MESSAGE_CREATE:${MESSAGE_ID}`,
      payload: {
        id: MESSAGE_ID,
        channel_id: CHANNEL_ID,
        guild_id: GUILD_ID,
        author: { id: "100000000000000005", username: "member", bot: false },
        content: `<@${BOT_USER_ID}> Hello`,
        mentions: [{ id: BOT_USER_ID, username: "okou", bot: true }],
        attachments: [],
        type: 0,
      },
    });
    // An independent crypto implementation verifies the exact transmitted bytes,
    // including the timestamp separator required by the API contract.
    expect(delivery.signature).toBe(
      createHmac("sha256", GATEWAY_SECRET)
        .update(`${delivery.timestamp}.${delivery.rawBody}`)
        .digest("hex"),
    );
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({ pending: 0, resumable: true, connected: true });
  });

  it("relays DMs, bot mentions and unparseable routing without forwarding other guild chatter", async ({
    onTestFailed,
    relay,
    relayPhases: { elapsedMs, wait },
  }) => {
    // Use existing fixture observations during teardown.
    onTestFailed(() => {
      console.error("Discord relay observations", {
        observedAtMs: elapsedMs(),
        forwarded: relay.forwarded.length,
        connections: relay.opened.map((connection) => {
          return connection.packets.map((packet) => {
            return packet.op;
          });
        }),
      });
    });
    const gateway = await wait("start and first connection", () => {
      return relay.start();
    });
    gateway.hello();
    await wait("Identify (op 2)", () => {
      return gateway.next(2);
    });
    gateway.ready("filter-session");
    const author = {
      id: "100000000000000005",
      username: "member",
      bot: false,
    };
    const guildMessage = (id: string, mentions: object[]) => {
      return {
        id,
        channel_id: CHANNEL_ID,
        guild_id: GUILD_ID,
        author,
        content: "hello",
        mentions,
        attachments: [],
        type: 0,
      };
    };
    // Mentioning another user, or only the application ID, does not address
    // the bot user reported by READY.
    gateway.send({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 2,
      d: guildMessage("100000000000000011", [
        { id: APPLICATION_ID, username: "app", bot: false },
      ]),
    });
    gateway.send({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 3,
      d: {
        id: "100000000000000012",
        channel_id: CHANNEL_ID,
        author,
        content: "direct message",
        mentions: [],
        attachments: [],
        type: 0,
      },
    });
    gateway.send({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 4,
      d: guildMessage("100000000000000013", [
        { id: BOT_USER_ID, username: "okou", bot: true },
      ]),
    });
    gateway.send({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 5,
      d: guildMessage("100000000000000014", []),
    });
    // Without a mentions array the relay cannot decide, so the API validates
    // (and rejects) the event instead of the relay silently dropping it.
    const { mentions: _omitted, ...withoutMentions } = guildMessage(
      "100000000000000015",
      [],
    );
    gateway.send({ op: 0, t: "MESSAGE_CREATE", s: 6, d: withoutMentions });

    const relayed: unknown[] = [];
    for (const name of [
      "DM delivery",
      "mention delivery",
      "unparseable routing delivery",
    ]) {
      const delivery = await wait(name, () => {
        return relay.deliveries.next();
      });
      relayed.push(JSON.parse(delivery.rawBody).eventId);
    }
    expect(relayed).toEqual([
      "MESSAGE_CREATE:100000000000000012",
      "MESSAGE_CREATE:100000000000000013",
      "MESSAGE_CREATE:100000000000000015",
    ]);
    await wait("outbox drained", () => {
      return expect
        .poll(() => {
          return relay.health();
        })
        .toMatchObject({ pending: 0, connected: true });
    });

    expect(relay.forwarded).toHaveLength(3);
  });

  it("resumes past ignored guild chatter without forwarding it", async ({
    relay,
  }) => {
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready("ignored-guild-session");
    for (const sequence of [2, 3]) {
      gateway.send({
        op: 0,
        t: "MESSAGE_CREATE",
        s: sequence,
        d: {
          id: `10000000000000001${sequence}`,
          channel_id: CHANNEL_ID,
          guild_id: GUILD_ID,
          author: {
            id: "100000000000000005",
            username: "member",
            bot: false,
          },
          content: "ordinary guild chatter",
          mentions: [],
          attachments: [],
          type: 0,
        },
      });
    }
    // A server-requested heartbeat observes the last consumed sequence before
    // requesting a reconnect; ignored dispatches have no delivery as a barrier.
    await expect
      .poll(async () => {
        gateway.send({ op: 1, d: null });
        return (await gateway.next(1)).d;
      })
      .toBe(3);
    gateway.send({ op: 7, d: null });
    expect((await gateway.closed.promise).code).toBe(4000);
    const resumed = await relay.connections.next();
    resumed.hello();
    expect(await resumed.next(6)).toEqual({
      op: 6,
      d: { token: BOT_TOKEN, session_id: "ignored-guild-session", seq: 3 },
    });
    expect(relay.forwarded).toStrictEqual([]);
  });

  it("reports head-of-queue delivery failures and the oldest pending age", async ({
    relay,
  }) => {
    relay.reply = () => {
      return new Response(null, { status: 503 });
    };
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready();
    gateway.message();
    await relay.deliveries.next();
    await expect
      .poll(async () => {
        const health = object({
          pending: number(),
          deliveryFailures: number(),
          oldestPendingAgeMs: number().nullable(),
        }).parse(await relay.health());
        return (
          health.pending === 1 &&
          health.deliveryFailures >= 1 &&
          health.oldestPendingAgeMs !== null &&
          health.oldestPendingAgeMs >= 0
        );
      })
      .toBe(true);

    relay.reply = () => {
      return Response.json({ ok: true, outcome: "accepted" });
    };
    await expect
      .poll(
        () => {
          return relay.health();
        },
        { timeout: 10_000 },
      )
      .toMatchObject({
        pending: 0,
        deliveryFailures: 0,
        oldestPendingAgeMs: null,
      });
  }, 15_000);

  it("keeps GUILD_DELETE unavailable unchanged and uses a stable lifecycle identity", async ({
    relay,
    onTestFailed,
    signal,
    task,
  }) => {
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready("lifecycle-session");
    gateway.send({
      op: 0,
      t: "GUILD_DELETE",
      s: 2,
      d: { id: GUILD_ID, unavailable: true },
    });

    const delivery = await relay.deliveries.next();
    expect(JSON.parse(delivery.rawBody)).toEqual({
      version: 1,
      applicationId: APPLICATION_ID,
      eventType: "GUILD_DELETE",
      eventId: "GUILD_DELETE:lifecycle-session:2",
      payload: { id: GUILD_ID, unavailable: true },
    });
    await relay.waitForHealth(
      { onTestFailed, signal, task },
      { running: true, pending: 0 },
    );
  });

  it("waits for a refreshed Identify budget before opening a socket", async ({
    relay,
    relayPhases: { wait },
  }) => {
    const openSocketsAtDiscovery: number[] = [];
    relay.gatewayReply = () => {
      openSocketsAtDiscovery.push(relay.opened.length);
      return Response.json({
        ...relay.gatewayMetadata,
        session_start_limit: {
          ...relay.gatewayMetadata.session_start_limit,
          remaining: openSocketsAtDiscovery.length === 1 ? 0 : 1,
          reset_after: 200,
        },
      });
    };
    const start = await wait("/start", () => {
      return relay.request("/start");
    });
    expect(start.status).toBe(200);
    await wait("discovery with exhausted budget", () => {
      return relay.discoveries.next();
    });
    await wait("discovery with refreshed budget", () => {
      return relay.discoveries.next();
    });
    const gateway = await wait("open socket after budget refresh", () => {
      return relay.connections.next();
    });
    expect(openSocketsAtDiscovery).toEqual([0, 0]);
    gateway.hello();
    const identify = await wait("Identify (op 2)", () => {
      return gateway.next(2);
    });
    expect(identify.d).toMatchObject({ token: BOT_TOKEN });
  });

  it("retains a redirected delivery without sending its signature to another origin", async ({
    relay,
  }) => {
    relay.reply = () => {
      return new Response(null, {
        status: 302,
        headers: { Location: "https://untrusted.example/collect" },
      });
    };
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready();
    gateway.message();
    await relay.deliveries.next();
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({ pending: 1, deliveryFailures: 1 });
    expect(relay.unhandled).toEqual([]);
  });

  it.for([503, 302])(
    "persists an unacknowledged %i delivery across process restart and resumes after its checkpoint",
    { timeout: 15_000 },
    async (status, { relay }) => {
      // An unavailable acknowledgement or an unsafe redirect leaves the genuine
      // durable envelope unacknowledged, including across process replacement.
      relay.reply = () => {
        return new Response(null, {
          status,
          headers:
            status === 302
              ? { Location: "https://untrusted.example/collect" }
              : undefined,
        });
      };
      const gateway = await relay.start();
      gateway.hello();
      await gateway.next(2);
      gateway.ready("persisted-session");
      gateway.message(2);
      const first = await relay.deliveries.next();
      await expect
        .poll(() => {
          return relay.health();
        })
        .toMatchObject({ pending: 1, resumable: true });

      await relay.restart();
      const attemptsBeforeRestart = relay.forwarded.length;
      relay.reply = () => {
        return Response.json({ ok: true, outcome: "duplicate" });
      };
      // Initialize the replacement process through its read-only endpoint. The
      // persisted alarm must recover without another operator /start request.
      expect(await relay.health()).toMatchObject({
        running: true,
        resumable: true,
      });
      const resumed = await relay.connections.next();
      resumed.hello();
      expect(await resumed.next(6)).toEqual({
        op: 6,
        d: { token: BOT_TOKEN, session_id: "persisted-session", seq: 2 },
      });
      resumed.send({ op: 0, t: "RESUMED", s: 3, d: {} });
      // Discord may replay the last observed message. Its checkpoint was committed
      // atomically with the outbox before the receiver saw the first attempt.
      resumed.message(2);

      await expect
        .poll(
          () => {
            return relay.health();
          },
          { timeout: 5000 },
        )
        .toMatchObject({ pending: 0, resumable: true });
      expect(relay.forwarded.length).toBeGreaterThan(attemptsBeforeRestart);
      expect(relay.forwarded.at(-1)?.rawBody).toBe(first.rawBody);
      expect(
        relay.forwarded.every((entry) => {
          return entry.rawBody === first.rawBody;
        }),
      ).toBe(true);
      expect(relay.unhandled).toEqual([]);
    },
  );

  it("preserves the outbox through Invalid Session and ignores queued stale dispatch", async ({
    relay,
    relayPhases: { wait },
    onTestFailed,
    onTestFinished,
    signal,
    task,
  }) => {
    const allowReceipt = Promise.withResolvers<void>();
    onTestFinished(() => {
      allowReceipt.resolve();
    });
    let firstAttempt = true;
    relay.reply = async () => {
      if (firstAttempt) {
        firstAttempt = false;
        return new Response(null, { status: 503 });
      }
      // Keep the original event pending throughout the session reset. A held
      // receipt avoids a timing-dependent series of 503s and longer backoffs.
      await allowReceipt.promise;
      return Response.json({ ok: true, outcome: "accepted" });
    };
    const gateway = await wait("start and first connection", () => {
      return relay.start();
    });
    gateway.hello();
    await wait("initial Identify (op 2)", () => {
      return gateway.next(2);
    });
    gateway.ready("expired-session");
    gateway.message(2);
    const first = await wait("first delivery", () => {
      return relay.deliveries.next();
    });

    gateway.send({ op: 9, d: false });
    gateway.message(3, "100000000000000006");
    await wait("old socket closed", () => {
      return gateway.closed.promise;
    });
    const replacement = await wait("replacement socket", () => {
      return relay.connections.next();
    });
    replacement.hello();
    const identify = await wait("replacement Identify (op 2)", () => {
      return replacement.next(2);
    });
    expect(identify.d).toMatchObject({ token: BOT_TOKEN });
    replacement.ready("replacement-session");
    const healthContext = { onTestFailed, signal, task };
    await wait("retained outbox after replacement READY", () => {
      return relay.waitForHealth(healthContext, {
        running: true,
        pending: 1,
        connection: { stage: "ready" },
      });
    });
    const retried = await wait("retry of retained delivery", () => {
      return relay.deliveries.next();
    });
    expect(retried.rawBody).toBe(first.rawBody);
    allowReceipt.resolve();

    replacement.message(2, "100000000000000007");
    const delivered = await wait("replacement session delivery", async () => {
      for (;;) {
        const delivery = await relay.deliveries.next();
        if (delivery.rawBody !== first.rawBody) return delivery;
      }
    });
    expect(JSON.parse(delivered.rawBody).eventId).toBe(
      "MESSAGE_CREATE:100000000000000007",
    );
    await wait("durable outbox drain", () => {
      return relay.waitForHealth(healthContext, {
        running: true,
        pending: 0,
      });
    });

    expect(
      relay.forwarded.map((entry) => {
        return JSON.parse(entry.rawBody).eventId;
      }),
    ).not.toContain("MESSAGE_CREATE:100000000000000006");
  }, 20_000);

  it("honors the disabled flag after restart while preserving an unacknowledged event", async ({
    relay,
  }) => {
    relay.reply = () => {
      return new Response(null, { status: 503 });
    };
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready();
    gateway.message();
    await relay.deliveries.next();

    await relay.restart({ DISCORD_GATEWAY_ENABLED: "false" });

    expect(await relay.health()).toMatchObject({
      enabled: false,
      running: false,
      connected: false,
      pending: 1,
    });
    expect((await relay.request("/start")).status).toBe(409);
    expect(relay.opened).toHaveLength(1);
  });

  it("serves heartbeat requests while an API acknowledgement is pending", async ({
    relay,
  }) => {
    const acknowledgement = Promise.withResolvers<Response>();
    relay.reply = () => {
      return acknowledgement.promise;
    };
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready();
    gateway.message();
    await relay.deliveries.next();

    gateway.send({ op: 1, d: null });
    expect(
      await gateway.next(1, (packet) => {
        return packet.d === 2;
      }),
    ).toEqual({ op: 1, d: 2 });
    acknowledgement.resolve(Response.json({ ok: true, outcome: "accepted" }));
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({ pending: 0, connected: true });
  });

  it("reconnects on a missing heartbeat ACK and resumes the last sequence", async ({
    relay,
  }) => {
    const gateway = await relay.start();
    gateway.hello(100);
    await gateway.next(2);
    gateway.ready("heartbeat-session");
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({ resumable: true });
    gateway.autoAcknowledge = false;
    await gateway.next(1);
    expect((await gateway.closed.promise).code).toBe(4000);

    const replacement = await relay.connections.next();
    replacement.hello(100);
    expect(await replacement.next(6)).toEqual({
      op: 6,
      d: { token: BOT_TOKEN, session_id: "heartbeat-session", seq: 1 },
    });
    // The replacement acknowledges heartbeats. Two observed requests prove the
    // relay continued its schedule without treating a received ACK as missing.
    await replacement.next(1);
    await replacement.next(1);
    expect(await relay.health()).toMatchObject({
      connected: true,
      running: true,
    });
  }, 10_000);

  it("keeps old application state stopped when deployment credentials change scope", async ({
    relay,
  }) => {
    relay.reply = () => {
      return new Response(null, { status: 503 });
    };
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready();
    gateway.message();
    await relay.deliveries.next();
    await relay.restart({ DISCORD_APPLICATION_ID: "100000000000000099" });

    // Infrastructure can deliver an old object's alarm after deployment changes
    // the application ID. The new Worker route necessarily selects another DO,
    // so address the existing DO through its real HTTP interface to observe the
    // infrastructure-created case without inspecting or writing its storage.
    // The two objects are independent, so read them together after redeployment.
    const [currentHealth, previousHealth] = await Promise.all([
      relay.health(),
      relay.durableObjectHealth(`test:${APPLICATION_ID}:0`),
    ]);
    expect(previousHealth).toMatchObject({
      running: false,
      connected: false,
      pending: 1,
      fatal: "configuration-scope-changed",
    });
    expect(currentHealth).toMatchObject({
      running: false,
      connected: false,
      pending: 0,
      fatal: null,
    });
    expect(relay.opened).toHaveLength(1);
  });

  it("continues scheduled heartbeats after acknowledging a requested heartbeat", async ({
    relay,
  }) => {
    const gateway = await relay.start();
    gateway.hello(1_500);
    await gateway.next(2);
    gateway.ready();
    await gateway.next(1);
    expect(await relay.health()).toMatchObject({ resumable: true });

    gateway.send({ op: 1, d: null });
    expect(await gateway.next(1)).toEqual({ op: 1, d: 1 });
    // The fixture acknowledges each heartbeat; the next scheduled tick must
    // still reach the same connection after the requested heartbeat.
    expect(await gateway.next(1)).toEqual({ op: 1, d: 1 });
    gateway.message();
    expect(JSON.parse((await relay.deliveries.next()).rawBody).eventId).toBe(
      `MESSAGE_CREATE:${MESSAGE_ID}`,
    );
    expect(relay.opened).toHaveLength(1);
  }, 10_000);

  it("stops after a fatal Discord close without exposing credentials", async ({
    relay,
  }) => {
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.socket.close(4004, "Authentication failed");

    await expect
      .poll(() => {
        return relay.health();
      })
      .toEqual({
        enabled: true,
        running: false,
        connected: false,
        resumable: false,
        connection: {
          stage: "stopped",
          stageStartedAt: expect.any(Number),
          httpStatus: null,
          lastFailure: {
            at: expect.any(Number),
            stage: "awaiting-ready",
            reason: "socket-close",
            httpStatus: null,
            exceptionType: null,
            closeCode: 4004,
            retryCount: 0,
            retryDelayMs: null,
          },
          failures: 0,
          reconnectAt: null,
        },
        pending: 0,
        deadLettered: 0,
        deliveryFailures: 0,
        oldestPendingAgeMs: null,
        fatal: "gateway-close-4004",
      });
    expect(relay.opened).toHaveLength(1);
  });
});
