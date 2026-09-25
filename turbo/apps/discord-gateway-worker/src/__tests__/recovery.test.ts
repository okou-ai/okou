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

  it("halts before checkpointing an oversized event and resumes after explicit correction", async () => {
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

    const correctedId = "100000000000000006";
    gateway.send({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 3,
      d: {
        id: correctedId,
        channel_id: CHANNEL_ID,
        guild_id: GUILD_ID,
        author: { id: "100000000000000005", bot: false },
        content: "x".repeat(120_001),
        attachments: [],
      },
    });
    await gateway.closed.promise;
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({
        running: false,
        connected: false,
        resumable: true,
        pending: 1,
        fatal: "event-exceeds-durable-record-limit",
      });
    expect(
      relay.forwarded.every((delivery) => {
        return delivery.rawBody === retained.rawBody;
      }),
    ).toBe(true);

    relay.reply = () => {
      return Response.json({ ok: true, outcome: "accepted" });
    };
    const resumed = await relay.start();
    resumed.hello();
    expect(await resumed.next(6)).toEqual({
      op: 6,
      d: { token: BOT_TOKEN, session_id: "oversized-session", seq: 2 },
    });
    resumed.message(3, correctedId);
    let corrected = await relay.deliveries.next();
    while (
      JSON.parse(corrected.rawBody).eventId !== `MESSAGE_CREATE:${correctedId}`
    ) {
      corrected = await relay.deliveries.next();
    }
    expect(JSON.parse(corrected.rawBody)).toMatchObject({
      eventId: `MESSAGE_CREATE:${correctedId}`,
      payload: {
        id: correctedId,
        content: "<@100000000000000001> Hello",
      },
    });
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({ running: true, pending: 0, fatal: null });
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
