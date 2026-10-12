import { Response } from "miniflare";
import { describe, expect, it } from "vitest";
import { APPLICATION_ID, createRelay } from "./relay-fixture";

// Exercise the deployed Worker and external Discord HTTP/WebSocket boundaries.
describe("Discord application message-content capability", () => {
  it.each([
    { flags: 0, expected: 4609 },
    { flags: 1 << 14, expected: 4609 },
    { flags: 1 << 18, expected: 4609 + 32768 },
    { flags: 1 << 19, expected: 4609 + 32768 },
    { flags: (1 << 18) | (1 << 19), expected: 4609 + 32768 },
    { flags: 1 << 18, flags_new: "0", expected: 4609 },
    { flags_new: String((1n << 40n) | (1n << 19n)), expected: 4609 + 32768 },
  ])(
    "identifies with intents $expected for verified metadata $flags/$flags_new",
    async ({ expected, ...flags }) => {
      const relay = await createRelay();
      relay.applicationMetadata = { id: APPLICATION_ID, ...flags };
      const gateway = await relay.start();
      gateway.hello();
      expect((await gateway.next(2)).d).toMatchObject({ intents: expected });
    },
  );

  it("rejects a bot credential for a different application before opening a socket", async () => {
    const relay = await createRelay();
    relay.applicationMetadata = { id: "100000000000000099", flags: 1 << 18 };
    expect((await relay.request("/start")).status).toBe(200);
    await relay.applications.next();
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({ running: false, fatal: "application-mismatch" });
    expect(relay.opened).toEqual([]);
  });

  it.each([401, 403])(
    "halts without identifying when capability discovery returns %i",
    async (status) => {
      const relay = await createRelay();
      relay.applicationReply = () => {
        return new Response(null, { status });
      };
      expect((await relay.request("/start")).status).toBe(200);
      await relay.applications.next();
      await expect
        .poll(() => {
          return relay.health();
        })
        .toMatchObject({ running: false, fatal: "gateway-authentication" });
      expect(relay.opened).toEqual([]);
    },
  );

  it.each([
    { id: APPLICATION_ID },
    { id: APPLICATION_ID, flags: -1 },
    { id: APPLICATION_ID, flags_new: "invalid" },
    "unavailable",
  ])(
    "does not identify from failed or malformed discovery, and recovers on a verified read",
    async (application) => {
      const relay = await createRelay();
      relay.applicationReply = () => {
        return application === "unavailable"
          ? new Response(null, { status: 500 })
          : Response.json(application);
      };
      expect((await relay.request("/start")).status).toBe(200);
      await relay.applications.next();
      expect(relay.opened).toEqual([]);
      relay.applicationReply = null;
      const gateway = await relay.connections.next();
      gateway.hello();
      expect((await gateway.next(2)).d).toMatchObject({ intents: 4609 });
    },
  );

  it("honors capability-discovery Retry-After before identifying", async () => {
    const relay = await createRelay();
    relay.applicationReply = () => {
      relay.applicationReply = null;
      return new Response(null, {
        status: 429,
        headers: { "Retry-After": "3" },
      });
    };
    expect((await relay.request("/start")).status).toBe(200);
    await relay.applications.next();
    const limitedAt = Date.now();
    await relay.applications.next();
    expect(Date.now() - limitedAt).toBeGreaterThanOrEqual(2_900);
    const gateway = await relay.connections.next();
    gateway.hello();
    expect((await gateway.next(2)).d).toMatchObject({ intents: 4609 });
  });

  it("refreshes the capability before a new Identify after session invalidation", async () => {
    const relay = await createRelay();
    relay.applicationMetadata.flags = 1 << 19;
    const gateway = await relay.start();
    gateway.hello();
    expect((await gateway.next(2)).d).toMatchObject({ intents: 4609 + 32768 });
    gateway.ready("authorized-session");
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({ resumable: true });
    relay.applicationMetadata.flags = 0;
    gateway.socket.close(4007, "Invalid sequence");
    const replacement = await relay.connections.next();
    replacement.hello();
    expect((await replacement.next(2)).d).toMatchObject({ intents: 4609 });
  }, 10_000);
});
