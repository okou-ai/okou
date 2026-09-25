import { Response } from "miniflare";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
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

describe("Discord Gateway API delivery", () => {
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
