import { describe, expect, it } from "vitest";
import { CHANNEL_ID, MESSAGE_ID, createRelay } from "./relay-fixture";

describe("Discord Gateway session start limits", () => {
  it("starts with a zero reset delay and relays mentions and DMs", async () => {
    const relay = await createRelay();
    relay.gatewayMetadata.session_start_limit.reset_after = 0;

    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready();
    gateway.message();
    const directMessageId = "100000000000000020";
    gateway.send({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 3,
      d: {
        id: directMessageId,
        channel_id: CHANNEL_ID,
        author: { id: "100000000000000005", username: "member", bot: false },
        content: "Hello",
        mentions: [],
        attachments: [],
        type: 0,
      },
    });

    for (const id of [MESSAGE_ID, directMessageId]) {
      const delivery = await relay.deliveries.next();
      expect(JSON.parse(delivery.rawBody)).toMatchObject({
        eventType: "MESSAGE_CREATE",
        eventId: `MESSAGE_CREATE:${id}`,
        payload: { id },
      });
    }
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({
        connected: true,
        resumable: true,
        pending: 0,
        connection: { stage: "ready", failures: 0, lastFailure: null },
      });
  });

  it("waits for available sessions even when the reset delay is zero", async () => {
    const relay = await createRelay();
    relay.gatewayMetadata.session_start_limit.remaining = 0;
    relay.gatewayMetadata.session_start_limit.reset_after = 0;
    expect((await relay.request("/start")).status).toBe(200);
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({
        connected: false,
        connection: { stage: "session-limit-wait", lastFailure: null },
      });

    relay.gatewayMetadata.session_start_limit.remaining = 1;
    const gateway = await relay.connections.next();
    gateway.hello();
    await gateway.next(2);
    gateway.ready();
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({ connected: true, connection: { stage: "ready" } });
  });

  it.each([-1, 0.5])(
    "rejects an invalid reset delay of %s",
    async (resetAfter) => {
      const relay = await createRelay();
      relay.gatewayMetadata.session_start_limit.reset_after = resetAfter;
      expect((await relay.request("/start")).status).toBe(200);
      await expect
        .poll(() => {
          return relay.health();
        })
        .toMatchObject({
          connected: false,
          resumable: false,
          connection: {
            stage: "backoff",
            lastFailure: {
              stage: "gateway-discovery",
              httpStatus: 200,
              exceptionType: "ValidationError",
            },
          },
        });
    },
  );
});
