import { Response } from "miniflare";
import { describe, expect, it } from "vitest";
import {
  BOT_TOKEN,
  BOT_USER_ID,
  MESSAGE_ID,
  createRelay,
} from "./relay-fixture";

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
        headers: { "Retry-After": "3" },
      });
    };
    expect((await relay.request("/start")).status).toBe(200);
    await relay.discoveries.next();
    const limitedAt = Date.now();

    // The default first backoff is under 2 s, so only honoring the
    // 3 s Retry-After delays rediscovery this long.
    await relay.discoveries.next();
    expect(Date.now() - limitedAt).toBeGreaterThanOrEqual(2_900);
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
});
