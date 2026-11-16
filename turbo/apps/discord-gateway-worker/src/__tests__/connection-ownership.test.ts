import { Response } from "miniflare";
import { describe, expect, it, onTestFinished } from "vitest";
import { createRelay, GatewayConnection } from "./relay-fixture";

describe("Gateway connection ownership", () => {
  it.each([
    { endpoint: "gatewayReply", stage: "gateway-discovery" },
    { endpoint: "applicationReply", stage: "application-discovery" },
    { endpoint: "handshakeReply", stage: "websocket-handshake" },
  ] satisfies Array<{
    endpoint: "gatewayReply" | "applicationReply" | "handshakeReply";
    stage: string;
  }>)(
    "keeps controls responsive during $stage",
    async ({ endpoint, stage }) => {
      const relay = await createRelay();
      const response = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<void>();
      onTestFinished(() => {
        response.resolve(new Response(null, { status: 503 }));
      });
      relay[endpoint] = () => {
        started.resolve();
        return response.promise;
      };

      expect((await relay.request("/start")).status).toBe(200);
      await started.promise;
      expect(await relay.health()).toMatchObject({
        running: true,
        connected: false,
        connection: { stage, failures: 0 },
      });
      const stopped = await relay.request("/stop");
      expect(stopped.status).toBe(200);
      expect(await stopped.json()).toMatchObject({
        running: false,
        connected: false,
        connection: { stage: "stopped", failures: 0 },
      });
    },
  );

  it.each([
    { endpoint: "gatewayReply", stage: "gateway-discovery" },
    { endpoint: "applicationReply", stage: "application-discovery" },
  ] satisfies Array<{
    endpoint: "gatewayReply" | "applicationReply";
    stage: string;
  }>)(
    "can stop and restart while the $stage body is pending",
    async ({ endpoint, stage }) => {
      const relay = await createRelay();
      const release = Promise.withResolvers<void>();
      onTestFinished(() => {
        release.resolve();
      });
      const metadata =
        endpoint === "gatewayReply"
          ? relay.gatewayMetadata
          : relay.applicationMetadata;
      const bytes = new TextEncoder().encode(JSON.stringify(metadata));
      let cancelled = false;
      relay[endpoint] = () => {
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(bytes.slice(0, 1));
              await release.promise;
              if (!cancelled) {
                controller.enqueue(bytes.slice(1));
                controller.close();
              }
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      };
      expect((await relay.request("/start")).status).toBe(200);
      await expect
        .poll(() => {
          return relay.health();
        })
        .toMatchObject({ connection: { stage, httpStatus: 200 } });
      expect((await relay.request("/stop")).status).toBe(200);

      relay[endpoint] = null;
      const replacement = await relay.start();
      replacement.hello();
      await replacement.next(2);
      replacement.ready();
      release.resolve();
      replacement.message();
      await relay.deliveries.next();
      await expect
        .poll(() => {
          return relay.health();
        })
        .toMatchObject({
          running: true,
          connected: true,
          pending: 0,
          connection: { stage: "ready", failures: 0 },
        });
    },
  );

  it("commits an accepted receipt while a reconnect handshake is pending", async () => {
    const relay = await createRelay();
    const receipt = Promise.withResolvers<Response>();
    const handshake = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    onTestFinished(() => {
      receipt.resolve(Response.json({ ok: true, outcome: "accepted" }));
      handshake.resolve(new Response(null, { status: 503 }));
    });
    relay.reply = () => {
      return receipt.promise;
    };
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready();
    gateway.message();
    await relay.deliveries.next();
    relay.handshakeReply = () => {
      started.resolve();
      return handshake.promise;
    };
    gateway.send({ op: 7, d: null });
    await gateway.closed.promise;
    await started.promise;

    receipt.resolve(Response.json({ ok: true, outcome: "accepted" }));
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({
        pending: 0,
        running: true,
        connected: false,
        connection: { stage: "websocket-handshake" },
      });
  });

  it("resumes a new run while a cancelled upgrade is still pending", async () => {
    const relay = await createRelay();
    const handshake = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    onTestFinished(() => {
      handshake.resolve(new Response(null, { status: 503 }));
    });
    const gateway = await relay.start();
    gateway.hello();
    await gateway.next(2);
    gateway.ready("preserved-session");
    relay.handshakeReply = () => {
      relay.handshakeReply = null;
      started.resolve();
      return handshake.promise;
    };
    gateway.send({ op: 7, d: null });
    await gateway.closed.promise;
    await started.promise;
    expect((await relay.request("/stop")).status).toBe(200);

    const replacement = await relay.start();
    replacement.hello();
    expect((await replacement.next(6)).d).toMatchObject({
      session_id: "preserved-session",
      seq: 1,
    });
    replacement.send({ op: 0, t: "RESUMED", s: 2, d: {} });
    const late = new GatewayConnection();
    onTestFinished(() => {
      // Cancellation can discard the response before the fixture transfers it.
      late.socket.close();
    });
    handshake.resolve(
      new Response(null, { status: 101, webSocket: late.client }),
    );
    replacement.message(3);
    await relay.deliveries.next();
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({
        running: true,
        connected: true,
        pending: 0,
        connection: { stage: "ready", failures: 0 },
      });
  });
});
