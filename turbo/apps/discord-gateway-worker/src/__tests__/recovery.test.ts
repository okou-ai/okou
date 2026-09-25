import { Response } from "miniflare";
import { describe, expect, it } from "vitest";
import { BOT_TOKEN, CHANNEL_ID, GUILD_ID, createRelay } from "./relay-fixture";

describe("Discord Gateway durable recovery", () => {
  it("resumes before the overflow event after an acknowledgement frees outbox capacity", async () => {
    const relay = await createRelay();
    relay.reply = () => {
      return new Response(null, { status: 503 });
    };
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready("capacity-session");

    const messageId = (sequence: number) => {
      return (100_000_000_000_000_000n + BigInt(sequence)).toString();
    };
    // A real provider stream fills the durable capacity. The next dispatch
    // must close the socket without advancing past the last retained event.
    for (let sequence = 2; sequence <= 1002; sequence++) {
      gateway.message(sequence, messageId(sequence));
    }
    expect((await gateway.closed.promise).code).toBe(4000);
    expect(await relay.health()).toMatchObject({
      running: true,
      connected: false,
      resumable: true,
      pending: 1000,
      fatal: null,
    });

    // Recover only one receiver acknowledgement, leaving the receiver
    // unavailable for the rest of the retained backlog.
    let acknowledgeNext = true;
    relay.reply = () => {
      if (acknowledgeNext) {
        acknowledgeNext = false;
        return Response.json({ ok: true, outcome: "accepted" });
      }
      return new Response(null, { status: 503 });
    };
    await expect
      .poll(
        () => {
          return relay.health();
        },
        { timeout: 10_000 },
      )
      .toMatchObject({ pending: 999 });

    const resumed = await relay.connections.next();
    resumed.hello();
    expect(await resumed.next(6)).toEqual({
      op: 6,
      d: { token: BOT_TOKEN, session_id: "capacity-session", seq: 1001 },
    });
    resumed.message(1002, messageId(1002));
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({
        running: true,
        connected: true,
        pending: 1000,
        fatal: null,
      });
    resumed.send({ op: 1, d: null });
    expect(
      await resumed.next(1, (packet) => {
        return packet.d === 1002;
      }),
    ).toEqual({ op: 1, d: 1002 });
  }, 20_000);

  it("sets aside an oversized event past the checkpoint so its replay cannot stall the relay", async () => {
    const relay = await createRelay();
    relay.reply = () => {
      return new Response(null, { status: 503 });
    };
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready("oversized-session");
    gateway.message(2);
    const retained = await relay.deliveries.next();

    const oversizedId = "100000000000000006";
    const oversized = {
      op: 0,
      t: "MESSAGE_CREATE",
      s: 3,
      d: {
        id: oversizedId,
        channel_id: CHANNEL_ID,
        guild_id: GUILD_ID,
        author: { id: "100000000000000005", username: "member", bot: false },
        content: "x".repeat(120_001),
        mentions: [],
        attachments: [],
        type: 0,
      },
    };
    gateway.send(oversized);
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({
        running: true,
        connected: true,
        pending: 1,
        deadLettered: 1,
        fatal: null,
      });

    // A dropped connection resumes after the oversized event. Even if Discord
    // replays it, the relay neither forwards it nor counts it again.
    relay.reply = () => {
      return Response.json({ ok: true, outcome: "accepted" });
    };
    gateway.socket.close(4000, "Unknown error");
    const resumed = await relay.connections.next();
    resumed.hello();
    expect(await resumed.next(6)).toEqual({
      op: 6,
      d: { token: BOT_TOKEN, session_id: "oversized-session", seq: 3 },
    });
    resumed.send(oversized);
    resumed.message(4, "100000000000000007");
    const eventIds: string[] = [];
    while (!eventIds.includes("MESSAGE_CREATE:100000000000000007")) {
      eventIds.push(
        JSON.parse((await relay.deliveries.next()).rawBody).eventId,
      );
    }
    expect(eventIds).not.toContain(`MESSAGE_CREATE:${oversizedId}`);
    expect(eventIds).toContain(JSON.parse(retained.rawBody).eventId);
    expect(
      relay.forwarded.some((delivery) => {
        return delivery.rawBody.includes(oversizedId);
      }),
    ).toBe(false);
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({
        running: true,
        pending: 0,
        deadLettered: 1,
        fatal: null,
      });
  }, 20_000);

  it.each([undefined, "http://api.example.test"])(
    "halts automatic recovery when the API origin becomes invalid (%s)",
    async (origin) => {
      const relay = await createRelay();
      relay.reply = () => {
        return new Response(null, { status: 503 });
      };
      const gateway = await relay.start();
      gateway.hello();
      await gateway.next(2);
      gateway.ready("configuration-session");
      gateway.message(2);
      await relay.deliveries.next();
      await expect
        .poll(() => {
          return relay.health();
        })
        .toMatchObject({ running: true, pending: 1, resumable: true });

      await relay.restart({ DISCORD_API_ORIGIN: origin });

      // Reading health initializes the restarted process. Only the retained
      // alarm may attempt recovery; no /start request repairs its state.
      await expect
        .poll(
          () => {
            return relay.health();
          },
          { timeout: 10_000 },
        )
        .toMatchObject({
          running: false,
          connected: false,
          resumable: true,
          pending: 1,
          fatal: "configuration",
        });
      expect(relay.opened).toHaveLength(1);
      expect((await relay.request("/start")).status).toBe(503);
    },
    20_000,
  );
});
