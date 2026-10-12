import { Response } from "miniflare";
import { describe, expect, it } from "vitest";
import { createRelay } from "./relay-fixture";

describe("Discord Gateway connection health", () => {
  it.each([
    { endpoint: "gatewayReply", stage: "gateway-discovery" },
    { endpoint: "applicationReply", stage: "application-discovery" },
    { endpoint: "handshakeReply", stage: "websocket-handshake" },
  ] as const)(
    "reports $stage failures separately from delivery and recovers",
    async ({ endpoint, stage }) => {
      const relay = await createRelay();
      relay[endpoint] = () => {
        return new Response("private provider error", { status: 503 });
      };
      expect((await relay.request("/start")).status).toBe(200);
      await expect
        .poll(() => {
          return relay.health();
        })
        .toMatchObject({
          running: true,
          connected: false,
          deliveryFailures: 0,
          connection: {
            stage: "backoff",
            failures: 1,
            reconnectAt: expect.any(Number),
            lastFailure: {
              stage,
              reason: "connection-error",
              httpStatus: 503,
              exceptionType: "Error",
              retryCount: 1,
              retryDelayMs: expect.any(Number),
            },
          },
        });

      relay[endpoint] = null;
      const gateway = await relay.connections.next();
      gateway.hello();
      await gateway.next(2);
      gateway.ready();
      await expect
        .poll(() => {
          return relay.health();
        })
        .toMatchObject({
          connected: true,
          resumable: true,
          connection: {
            stage: "ready",
            httpStatus: null,
            failures: 0,
            reconnectAt: null,
            lastFailure: { stage, httpStatus: 503 },
          },
        });
    },
    15_000,
  );

  it.each([
    { status: 401, reason: "authentication", running: false },
    { status: 403, reason: "authentication", running: false },
    { status: 429, reason: "rate-limit", running: true },
  ])(
    "distinguishes discovery HTTP $status",
    async ({ status, reason, running }) => {
      const relay = await createRelay();
      relay.gatewayReply = () => {
        return new Response(null, { status, headers: { "Retry-After": "30" } });
      };
      expect((await relay.request("/start")).status).toBe(200);
      await expect
        .poll(() => {
          return relay.health();
        })
        .toMatchObject({
          running,
          fatal: running ? null : "gateway-authentication",
          connection: {
            stage: running ? "backoff" : "stopped",
            failures: running ? 1 : 0,
            lastFailure: {
              stage: "gateway-discovery",
              reason,
              httpStatus: status,
              exceptionType: null,
              retryDelayMs: running ? 30_000 : null,
            },
          },
        });
    },
  );

  it.each([
    { body: "private invalid JSON", exceptionType: "SyntaxError" },
    {
      body: '{"url":"private malformed metadata"}',
      exceptionType: "ValidationError",
    },
  ])(
    "classifies $exceptionType without the response body",
    async ({ body, exceptionType }) => {
      const relay = await createRelay();
      relay.gatewayReply = () => {
        return new Response(body, {
          headers: { "Content-Type": "application/json" },
        });
      };
      expect((await relay.request("/start")).status).toBe(200);
      await expect
        .poll(() => {
          return relay.health();
        })
        .toMatchObject({
          connection: {
            lastFailure: {
              stage: "gateway-discovery",
              httpStatus: 200,
              exceptionType,
            },
          },
        });
      expect(JSON.stringify(await relay.health())).not.toContain("private");
    },
  );

  it("distinguishes an open socket, Hello, READY and RESUMED", async () => {
    const relay = await createRelay();
    const gateway = await relay.start();
    expect(await relay.health()).toMatchObject({
      connected: true,
      resumable: false,
      connection: { stage: "awaiting-hello" },
    });
    gateway.hello();
    await gateway.next(2);
    expect(await relay.health()).toMatchObject({
      resumable: false,
      connection: { stage: "awaiting-ready" },
    });
    gateway.ready();
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({ connection: { stage: "ready" } });

    gateway.send({ op: 7, d: null });
    await gateway.closed.promise;
    const resumed = await relay.connections.next();
    resumed.hello();
    await resumed.next(6);
    expect(await relay.health()).toMatchObject({
      resumable: true,
      connection: {
        stage: "awaiting-resumed",
        failures: 1,
        lastFailure: { stage: "ready", reason: "server-reconnect" },
      },
    });
    resumed.send({ op: 0, t: "RESUMED", s: 2, d: {} });
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({
        connection: { stage: "ready", failures: 0 },
      });

    resumed.socket.close(4014, "private close reason");
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({
        running: false,
        fatal: "gateway-close-4014",
        connection: {
          stage: "stopped",
          lastFailure: {
            stage: "ready",
            reason: "socket-close",
            closeCode: 4014,
          },
        },
      });
    expect(JSON.stringify(await relay.health())).not.toContain("private");
  });

  it("reports an exhausted Identify budget without inventing a connection failure", async () => {
    const relay = await createRelay();
    relay.gatewayMetadata.session_start_limit.remaining = 0;
    expect((await relay.request("/start")).status).toBe(200);
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({
        running: true,
        connected: false,
        connection: {
          stage: "session-limit-wait",
          failures: 0,
          reconnectAt: expect.any(Number),
          lastFailure: null,
        },
      });
  });

  it("retains the durable retry count but discards runtime details on restart", async () => {
    const relay = await createRelay();
    relay.gatewayReply = () => {
      return new Response(null, {
        status: 429,
        headers: { "Retry-After": "30" },
      });
    };
    expect((await relay.request("/start")).status).toBe(200);
    await expect
      .poll(() => {
        return relay.health();
      })
      .toMatchObject({
        connection: { failures: 1, lastFailure: { reason: "rate-limit" } },
      });
    expect((await relay.request("/stop")).status).toBe(200);
    await relay.restart();
    expect(await relay.health()).toMatchObject({
      running: false,
      connection: { stage: "stopped", failures: 1, lastFailure: null },
    });
  });
});
