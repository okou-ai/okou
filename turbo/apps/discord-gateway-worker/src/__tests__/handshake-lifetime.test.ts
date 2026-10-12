import { expect, it } from "vitest";
import { MESSAGE_ID, createRelay } from "./relay-fixture";

it("keeps an upgraded Gateway connected beyond the handshake deadline", async () => {
  const relay = await createRelay();
  const gateway = await relay.start();
  gateway.hello(1000);
  await gateway.next(2);
  gateway.ready();

  // Twelve acknowledged heartbeats cross the ten-second handshake deadline.
  // Await protocol traffic so a closed socket fails instead of sleeping.
  for (let heartbeat = 0; heartbeat < 12; heartbeat++) {
    await gateway.next(1);
  }
  gateway.message();
  const delivery = await relay.deliveries.next();
  expect(JSON.parse(delivery.rawBody)).toMatchObject({
    eventType: "MESSAGE_CREATE",
    eventId: `MESSAGE_CREATE:${MESSAGE_ID}`,
  });
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
}, 20_000);
