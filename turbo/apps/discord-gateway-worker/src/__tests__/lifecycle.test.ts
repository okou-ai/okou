import { Response } from "miniflare";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BOT_TOKEN,
  BOT_USER_ID,
  CHANNEL_ID,
  GUILD_ID,
  MESSAGE_ID,
  createRelay,
  type RelayFixture,
} from "./relay-fixture";

const deadLettersSchema = z.object({
  deadLetters: z.array(
    z.object({
      eventType: z.string(),
      eventId: z.string(),
      reason: z.string(),
      bytes: z.number(),
    }),
  ),
});

async function deadLetters(relay: RelayFixture) {
  const response = await relay.request("/dead-letters");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return deadLettersSchema.parse(await response.json()).deadLetters;
}

function messageId(index: number): string {
  return (100000000000001000n + BigInt(index)).toString();
}

describe("Discord Gateway lifecycle", () => {
  it("resumes the same session after a Reconnect request (op 7)", async () => {
    const relay = await createRelay();
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready("reconnect-session");
    gateway.message(2);
    await relay.deliveries.next();

    gateway.send({ op: 7, d: null });
    await gateway.closed.promise;
    const resumed = await relay.connections.next();
    resumed.hello();
    expect(await resumed.next(6)).toEqual({
      op: 6,
      d: { token: BOT_TOKEN, session_id: "reconnect-session", seq: 2 },
    });
  });

  it("resumes rather than identifying after a resumable Invalid Session (op 9 d=true)", async () => {
    const relay = await createRelay();
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready("resumable-session");

    gateway.send({ op: 9, d: true });
    await gateway.closed.promise;
    const resumed = await relay.connections.next();
    resumed.hello();
    expect(await resumed.next(6)).toEqual({
      op: 6,
      d: { token: BOT_TOKEN, session_id: "resumable-session", seq: 1 },
    });
    expect(
      resumed.packets.some((packet) => {
        return packet.op === 2;
      }),
    ).toBe(false);
  }, 15_000);

  it("identifies again after an invalid sequence close instead of resuming it", async () => {
    const relay = await createRelay();
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready("invalid-sequence-session");
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({ resumable: true });
    gateway.socket.close(4007, "Invalid sequence");

    const replacement = await relay.connections.next();
    replacement.hello();
    expect((await replacement.next(2)).d).toMatchObject({ token: BOT_TOKEN });
    replacement.ready("new-session");
    replacement.message();
    expect(JSON.parse((await relay.deliveries.next()).rawBody).eventId).toBe(
      `MESSAGE_CREATE:${MESSAGE_ID}`,
    );
  }, 10_000);

  it("identifies a new session after close 4009 (session timed out)", async () => {
    const relay = await createRelay();
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready("timed-out-session");
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({ resumable: true });

    gateway.socket.close(4009, "Session timed out");
    const replacement = await relay.connections.next();
    replacement.hello();
    expect((await replacement.next(2)).d).toMatchObject({ token: BOT_TOKEN });
    expect(
      replacement.packets.some((packet) => {
        return packet.op === 6;
      }),
    ).toBe(false);
  }, 20_000);

  it("stops when READY belongs to another application", async () => {
    const relay = await createRelay();
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.send({
      op: 0,
      t: "READY",
      s: 1,
      d: {
        session_id: "foreign-session",
        resume_gateway_url: "wss://gateway.discord.gg",
        application: { id: "100000000000000099" },
        user: { id: BOT_USER_ID },
      },
    });

    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({
        running: false,
        resumable: false,
        fatal: "application-mismatch",
      });
    expect(relay.opened).toHaveLength(1);
  });

  it.each([401, 403])(
    "stops without connecting when Gateway discovery returns %i",
    async (status) => {
      const relay = await createRelay();
      relay.gatewayReply = () => {
        return new Response(null, { status });
      };
      expect((await relay.request("/start")).status).toBe(200);
      await relay.discoveries.next();

      await expect
        .poll(() => {
          return relay.health();
        })
        .toMatchObject({ running: false, fatal: "gateway-authentication" });
      expect(relay.opened).toEqual([]);
    },
  );

  it("waits for Retry-After when Gateway discovery is rate limited", async () => {
    const relay = await createRelay();
    relay.gatewayReply = () => {
      relay.gatewayReply = null;
      return new Response(null, {
        status: 429,
        headers: { "Retry-After": "1" },
      });
    };
    expect((await relay.request("/start")).status).toBe(200);
    await relay.discoveries.next();
    const limitedAt = Date.now();

    await relay.discoveries.next();
    expect(Date.now() - limitedAt).toBeGreaterThanOrEqual(900);
    const gateway = await relay.connections.next();
    gateway.hello();
    expect((await gateway.next(2)).d).toMatchObject({ token: BOT_TOKEN });
    expect(await relay.health()).toMatchObject({ running: true, fatal: null });
  }, 15_000);

  it("connects as one shard when Discord merely recommends more shards", async () => {
    const relay = await createRelay();
    relay.gatewayMetadata.shards = 2;
    const gateway = await relay.start();
    gateway.hello();

    expect((await gateway.next(2)).d).toMatchObject({ shard: [0, 1] });
    expect(await relay.health()).toMatchObject({ running: true, fatal: null });
  });

  it.each([401, 403, 404])(
    "halts on an API %i and redelivers the same event after /start",
    async (status) => {
      const relay = await createRelay();
      relay.reply = () => {
        return Response.json({ error: { code: "REJECTED" } }, { status });
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
          deadLettered: 0,
          fatal: `api-rejected-${status}`,
        });

      relay.reply = () => {
        return Response.json({ ok: true, outcome: "accepted" });
      };
      expect((await relay.request("/start")).status).toBe(200);
      expect((await relay.deliveries.next()).rawBody).toBe(first.rawBody);
      await expect
        .poll(() => {
          return relay.health();
        })
        .toMatchObject({ running: true, pending: 0, fatal: null });
    },
  );

  it.each([408, 429])(
    "retries the same event after an API %i and removes it once accepted",
    async (status) => {
      const relay = await createRelay();
      relay.reply = () => {
        return new Response(null, {
          status,
          headers: { "Retry-After": "1" },
        });
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
        .toMatchObject({ running: true, pending: 1, deliveryFailures: 1 });

      relay.reply = () => {
        return Response.json({ ok: true, outcome: "accepted" });
      };
      expect((await relay.deliveries.next()).rawBody).toBe(first.rawBody);
      await expect
        .poll(() => {
          return relay.health();
        })
        .toMatchObject({ running: true, pending: 0, deadLettered: 0 });
    },
    15_000,
  );

  it("records dead letters in the order they were set aside", async () => {
    const relay = await createRelay();
    relay.reply = () => {
      return new Response(null, { status: 503 });
    };
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready();
    // The held event occupies an earlier outbox slot than the oversized one.
    gateway.message(2);
    const held = await relay.deliveries.next();
    gateway.send({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 3,
      d: {
        id: messageId(1),
        channel_id: CHANNEL_ID,
        guild_id: GUILD_ID,
        author: { id: "100000000000000005", username: "member", bot: false },
        content: "x".repeat(120_001),
        mentions: [{ id: BOT_USER_ID, username: "okou", bot: true }],
        attachments: [],
        type: 0,
      },
    });
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({ deadLettered: 1 });

    relay.reply = () => {
      return Response.json({ error: { code: "BAD_REQUEST" } }, { status: 400 });
    };
    await expect
      .poll(
        () => {
          return relay.health();
        },
        { timeout: 10_000 },
      )
      .toMatchObject({ pending: 0, deadLettered: 2 });

    const records = await deadLetters(relay);
    expect(
      records.map((record) => {
        return [record.eventId, record.reason];
      }),
    ).toEqual([
      [`MESSAGE_CREATE:${messageId(1)}`, "exceeds-durable-record-limit"],
      [JSON.parse(held.rawBody).eventId, "api-rejected-400"],
    ]);
    // Records identify events without retaining message content.
    expect(JSON.stringify(records)).not.toContain("Hello");
  }, 15_000);

  it("retains only the newest 100 dead letters, evicting the oldest first", async () => {
    const relay = await createRelay();
    relay.reply = () => {
      return Response.json({ error: { code: "BAD_REQUEST" } }, { status: 400 });
    };
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready();
    for (let index = 1; index <= 101; index++) {
      gateway.message(index + 1, messageId(index));
    }

    await expect
      .poll(
        () => {
          return relay.health();
        },
        { timeout: 20_000 },
      )
      .toMatchObject({ running: true, pending: 0, deadLettered: 101 });
    const records = await deadLetters(relay);
    expect(records).toHaveLength(100);
    expect(records[0]?.eventId).toBe(`MESSAGE_CREATE:${messageId(2)}`);
    expect(records.at(-1)?.eventId).toBe(`MESSAGE_CREATE:${messageId(101)}`);
  }, 30_000);
});
