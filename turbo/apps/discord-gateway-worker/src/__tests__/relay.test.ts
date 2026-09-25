import { createHmac } from "node:crypto";
import { Response } from "miniflare";
import { describe, expect, it } from "vitest";
import { z } from "zod";
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

describe("Discord Gateway relay", () => {
  it("authenticates management and keeps a disabled relay stopped", async () => {
    const relay = await createRelay({ DISCORD_GATEWAY_ENABLED: "false" });

    expect((await relay.request("/health", null)).status).toBe(401);
    expect((await relay.request("/start", GATEWAY_SECRET)).status).toBe(401);
    expect((await relay.request("/start")).status).toBe(409);
    const health = await relay.request("/health");
    expect(health.headers.get("Cache-Control")).toBe("no-store");
    expect(await health.json()).toEqual({
      enabled: false,
      running: false,
      connected: false,
      resumable: false,
      pending: 0,
      deadLettered: 0,
      deliveryFailures: 0,
      oldestPendingAgeMs: null,
      fatal: null,
    });
    expect(relay.opened).toEqual([]);
    expect(relay.forwarded).toEqual([]);
  });

  it("identifies with least-privileged intents and signs the unchanged event", async () => {
    const relay = await createRelay();
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

  it("relays only DMs and bot mentions while checkpointing past other guild chatter", async () => {
    const relay = await createRelay();
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready("filter-session");
    const author = { id: "100000000000000005", username: "member", bot: false };
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

    const relayed = [
      JSON.parse((await relay.deliveries.next()).rawBody).eventId,
      JSON.parse((await relay.deliveries.next()).rawBody).eventId,
      JSON.parse((await relay.deliveries.next()).rawBody).eventId,
    ];
    expect(relayed).toEqual([
      "MESSAGE_CREATE:100000000000000012",
      "MESSAGE_CREATE:100000000000000013",
      "MESSAGE_CREATE:100000000000000015",
    ]);
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({ pending: 0, connected: true });

    gateway.socket.close(4000, "Unknown error");
    const resumed = await relay.connections.next();
    resumed.hello();
    expect(await resumed.next(6)).toEqual({
      op: 6,
      d: { token: BOT_TOKEN, session_id: "filter-session", seq: 6 },
    });
    expect(relay.forwarded).toHaveLength(3);
  });

  it("reports head-of-queue delivery failures and the oldest pending age", async () => {
    const relay = await createRelay();
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
        const health = z
          .object({
            pending: z.number(),
            deliveryFailures: z.number(),
            oldestPendingAgeMs: z.number().nullable(),
          })
          .parse(await relay.health());
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

  it.each(["missing-receipt", "non-json-200", "empty-204"])(
    "retains delivery after %s until a durable receipt is returned",
    async (kind) => {
      const relay = await createRelay();
      relay.reply = () => {
        if (kind === "missing-receipt") return Response.json({ ok: true });
        if (kind === "non-json-200") return new Response("ok");
        return new Response(null, { status: 204 });
      };
      const gateway = await relay.start();
      gateway.hello();
      await gateway.next(2);
      gateway.ready();
      gateway.message();
      const first = await relay.deliveries.next();
      await expect
        .poll(() => {
          return relay.health();
        })
        .toMatchObject({
          running: false,
          pending: 1,
          fatal: "api-invalid-receipt",
        });

      relay.reply = () => {
        return Response.json({
          ok: true,
          outcome: "ignored",
          reason: "feature-disabled",
        });
      };
      expect((await relay.request("/start")).status).toBe(200);
      const retried = await relay.deliveries.next();
      expect(retried.rawBody).toBe(first.rawBody);
      await expect
        .poll(() => {
          return relay.health();
        })
        .toMatchObject({ running: true, pending: 0, fatal: null });
    },
  );

  it.each([400, 413])(
    "sets aside an event rejected with %i and keeps relaying later events",
    async (status) => {
      const relay = await createRelay();
      relay.reply = (delivery) => {
        return JSON.parse(delivery.rawBody).eventId ===
          `MESSAGE_CREATE:${MESSAGE_ID}`
          ? Response.json({ error: { code: "BAD_REQUEST" } }, { status })
          : Response.json({ ok: true, outcome: "accepted" });
      };
      const gateway = await relay.start();
      gateway.hello();
      await gateway.next(2);
      gateway.ready();
      gateway.message();
      gateway.message(3, "100000000000000006");

      const rejected = await relay.deliveries.next();
      expect(JSON.parse(rejected.rawBody).eventId).toBe(
        `MESSAGE_CREATE:${MESSAGE_ID}`,
      );
      const later = await relay.deliveries.next();
      expect(JSON.parse(later.rawBody).eventId).toBe(
        "MESSAGE_CREATE:100000000000000006",
      );
      await expect
        .poll(() => {
          return relay.health();
        })
        .toMatchObject({
          running: true,
          connected: true,
          pending: 0,
          deadLettered: 1,
          fatal: null,
        });
      expect(relay.forwarded).toHaveLength(2);
    },
  );

  it("keeps GUILD_DELETE unavailable unchanged and uses a stable lifecycle identity", async () => {
    const relay = await createRelay();
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
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({ running: true, pending: 0 });
  });

  it("waits for a refreshed Identify budget before opening a socket", async () => {
    const relay = await createRelay();
    relay.gatewayMetadata.session_start_limit.remaining = 0;
    relay.gatewayMetadata.session_start_limit.reset_after = 200;
    expect((await relay.request("/start")).status).toBe(200);
    await relay.discoveries.next();
    expect(relay.opened).toEqual([]);

    relay.gatewayMetadata.session_start_limit.remaining = 1;
    await relay.discoveries.next();
    const gateway = await relay.connections.next();
    gateway.hello();
    expect((await gateway.next(2)).d).toMatchObject({ token: BOT_TOKEN });
  });

  it("retains a redirected delivery without sending its signature to another origin", async () => {
    const relay = await createRelay();
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
    const first = await relay.deliveries.next();
    const retry = await relay.deliveries.next();

    expect(retry.rawBody).toBe(first.rawBody);
    expect(relay.unhandled).toEqual([]);
    expect(await relay.health()).toMatchObject({ pending: 1 });
  });

  it("persists uncertain delivery across process restart and resumes after its checkpoint", async () => {
    const relay = await createRelay();
    // The receiver durably accepted this event but its acknowledgement was lost.
    // Returning 503 models the externally observable uncertainty at the relay.
    relay.reply = () => {
      return new Response(null, { status: 503 });
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
  }, 15_000);

  it("preserves the outbox through Invalid Session and ignores queued stale dispatch", async () => {
    const relay = await createRelay();
    relay.reply = () => {
      return new Response(null, { status: 503 });
    };
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready("expired-session");
    gateway.message(2);
    const first = await relay.deliveries.next();

    gateway.send({ op: 9, d: false });
    gateway.message(3, "100000000000000006");
    await gateway.closed.promise;
    const replacement = await relay.connections.next();
    replacement.hello();
    expect((await replacement.next(2)).d).toMatchObject({ token: BOT_TOKEN });
    replacement.ready("replacement-session");
    relay.reply = () => {
      return Response.json({ ok: true, outcome: "accepted" });
    };
    replacement.message(2, "100000000000000007");

    await expect
      .poll(
        () => {
          return relay.health();
        },
        { timeout: 10_000 },
      )
      .toMatchObject({ running: true, pending: 0 });
    expect(relay.forwarded[0]?.rawBody).toBe(first.rawBody);
    expect(
      relay.forwarded.map((entry) => {
        return JSON.parse(entry.rawBody).eventId;
      }),
    ).not.toContain("MESSAGE_CREATE:100000000000000006");
    expect(JSON.parse(relay.forwarded.at(-1)!.rawBody).eventId).toBe(
      "MESSAGE_CREATE:100000000000000007",
    );
  }, 20_000);

  it("honors the disabled flag after restart while preserving an unacknowledged event", async () => {
    const relay = await createRelay();
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

  it("serves heartbeat requests while an API acknowledgement is pending", async () => {
    const relay = await createRelay();
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

  it("reconnects on a missing heartbeat ACK and resumes the last sequence", async () => {
    const relay = await createRelay();
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

  it("keeps old application state stopped when deployment credentials change scope", async () => {
    const relay = await createRelay();
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
    expect(
      await relay.durableObjectHealth(`test:${APPLICATION_ID}:0`),
    ).toMatchObject({
      running: false,
      connected: false,
      pending: 1,
      fatal: "configuration-scope-changed",
    });
    expect(await relay.health()).toMatchObject({
      running: false,
      connected: false,
      pending: 0,
      fatal: null,
    });
    expect(relay.opened).toHaveLength(1);
  });

  it("gives a requested heartbeat its full ACK interval across the next scheduled tick", async () => {
    const relay = await createRelay();
    const gateway = await relay.start();
    // Each ACK must arrive within one interval, so leave slack for loaded CI.
    gateway.hello(1_500);
    await gateway.next(2);
    gateway.ready();
    await gateway.next(1);
    // The health response is an I/O barrier after the scheduled heartbeat's ACK.
    // The requested heartbeat below therefore has a later deadline than the
    // next regular tick, even though its acknowledgement is still pending.
    expect(await relay.health()).toMatchObject({ resumable: true });
    gateway.autoAcknowledge = false;
    gateway.send({ op: 1, d: null });
    expect(await gateway.next(1)).toEqual({ op: 1, d: 1 });

    expect(await gateway.next(1)).toEqual({ op: 1, d: 1 });
    gateway.autoAcknowledge = true;
    gateway.send({ op: 11, d: null });
    gateway.message();
    expect(JSON.parse((await relay.deliveries.next()).rawBody).eventId).toBe(
      `MESSAGE_CREATE:${MESSAGE_ID}`,
    );
    expect(relay.opened).toHaveLength(1);
  }, 15_000);

  it("stops after a fatal Discord close without exposing credentials", async () => {
    const relay = await createRelay();
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
        pending: 0,
        deadLettered: 0,
        deliveryFailures: 0,
        oldestPendingAgeMs: null,
        fatal: "gateway-close-4004",
      });
    expect(relay.opened).toHaveLength(1);
  });
});
