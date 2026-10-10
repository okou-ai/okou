import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { computerUseCommand } from "../index";
import { server } from "../../../mocks/server";
import {
  ablyRealtimeFake,
  deferred,
} from "../../../test-fixtures/ably-realtime";

vi.mock("ably", async () => {
  const { FakeRealtime } = await import("../../../test-fixtures/ably-realtime");
  return { Realtime: FakeRealtime };
});

const baseUrl = "http://localhost:3000/api/computer-use";
const commandId = "command-notification";
const subscription = {
  channelName: `computer-use-result:user:org:${commandId}`,
  eventName: "resultChanged",
  tokenRequest: {
    keyName: "test.key",
    timestamp: 1,
    nonce: "nonce",
    mac: "mac",
    capability: JSON.stringify({
      [`computer-use-result:user:org:${commandId}`]: ["subscribe"],
    }),
  },
};
const log = vi.spyOn(console, "log").mockImplementation(() => {});
const error = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation(() => {
  throw new Error("process.exit called");
});

function response(status: "running" | "succeeded" | "failed") {
  return HttpResponse.json({
    id: commandId,
    kind: "apps.list",
    status,
    hostId: "host",
    hostName: "Desktop",
    payload: {},
    timeoutMs: 30_000,
    createdAt: "2026-10-10T00:00:00Z",
    claimedAt: "2026-10-10T00:00:01Z",
    completedAt: status === "running" ? null : "2026-10-10T00:00:02Z",
    ...(status === "succeeded"
      ? {
          result: { apps: [{ name: "Chrome", bundleId: "com.google.Chrome" }] },
        }
      : {}),
    ...(status === "failed"
      ? { error: { code: "permission_denied", message: "Access denied" } }
      : {}),
  });
}

function serveCreate(realtime = true) {
  let count = 0;
  server.use(
    http.post(`${baseUrl}/commands`, async ({ request }) => {
      expect(await request.json()).toMatchObject({
        kind: "apps.list",
        realtime: true,
      });
      count++;
      return HttpResponse.json({
        commandId,
        status: "queued",
        ...(realtime ? { realtime: subscription } : {}),
      });
    }),
  );
  return () => {
    return count;
  };
}

function run(timeout = "3") {
  return computerUseCommand.parseAsync([
    "node",
    "okou",
    "list-apps",
    "--timeout",
    timeout,
  ]);
}

beforeEach(() => {
  ablyRealtimeFake.reset();
  vi.stubEnv("OKOU_TOKEN", "sandbox-token");
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
  log.mockClear();
  error.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Computer Use result notifications", () => {
  it("prints an already-complete result without opening a subscription", async () => {
    const creates = serveCreate();
    server.use(
      http.get(`${baseUrl}/commands/${commandId}`, () => {
        return response("succeeded");
      }),
    );
    await run();
    expect(log.mock.calls.flat().join("\n")).toContain("Chrome");
    expect(ablyRealtimeFake.clients).toHaveLength(0);
    expect(creates()).toBe(1);
  });

  it("reads completion on notification and coalesces events during a pending HTTP read", async () => {
    const creates = serveCreate();
    const secondRead = deferred<void>();
    const release = deferred<void>();
    let reads = 0;
    let active = 0;
    let maximumActive = 0;
    let complete = false;
    server.use(
      http.get(`${baseUrl}/commands/${commandId}`, async () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        reads++;
        const observed = complete;
        if (reads === 2) {
          secondRead.resolve();
          await release.promise;
        }
        active--;
        return response(observed ? "succeeded" : "running");
      }),
    );
    const running = run();
    const client = await ablyRealtimeFake.created.promise;
    await secondRead.promise;
    for (let i = 0; i < 10; i++) client.publish();
    release.resolve();
    complete = true;
    await running;
    expect(log.mock.calls.flat().join("\n")).toContain("Chrome");
    expect(maximumActive).toBe(1);
    expect(creates()).toBe(1);
    expect(client.channelName).toBe(subscription.channelName);
    expect(client.closed).toBe(true);
  });

  it("recovers completion during attachment without needing a message", async () => {
    ablyRealtimeFake.mode = "pending";
    serveCreate();
    let complete = false;
    server.use(
      http.get(`${baseUrl}/commands/${commandId}`, () => {
        return response(complete ? "succeeded" : "running");
      }),
    );
    const running = run();
    const client = await ablyRealtimeFake.created.promise;
    await client.subscribed.promise;
    complete = true;
    client.attach();
    await running;
    expect(log.mock.calls.flat().join("\n")).toContain("Chrome");
    expect(client.closed).toBe(true);
  });

  it("does not hold a fast result behind an unfinished connection", async () => {
    ablyRealtimeFake.mode = "pending";
    serveCreate();
    let reads = 0;
    server.use(
      http.get(`${baseUrl}/commands/${commandId}`, () => {
        return response(++reads > 1 ? "succeeded" : "running");
      }),
    );
    await run();
    expect(log.mock.calls.flat().join("\n")).toContain("Chrome");
    expect(ablyRealtimeFake.clients[0]?.closed).toBe(true);
  });

  it("re-reads after a reconnect even if the completion event was lost", async () => {
    serveCreate();
    const secondRead = deferred<void>();
    let complete = false;
    let reads = 0;
    server.use(
      http.get(`${baseUrl}/commands/${commandId}`, () => {
        if (++reads === 2) secondRead.resolve();
        return response(complete ? "succeeded" : "running");
      }),
    );
    const running = run();
    const client = await ablyRealtimeFake.created.promise;
    await secondRead.promise;
    complete = true;
    client.disconnect();
    client.reconnect();
    await running;
    expect(log.mock.calls.flat().join("\n")).toContain("Chrome");
    expect(client.closed).toBe(true);
  });

  it.each(["missing", "failed"] as const)(
    "continues reading the original command with %s notification metadata/transport",
    async (mode) => {
      ablyRealtimeFake.mode = "failed";
      const creates = serveCreate(mode !== "missing");
      let reads = 0;
      server.use(
        http.get(`${baseUrl}/commands/${commandId}`, () => {
          return response(++reads > 1 ? "succeeded" : "running");
        }),
      );
      await run();
      expect(log.mock.calls.flat().join("\n")).toContain("Chrome");
      expect(creates()).toBe(1);
      expect(
        ablyRealtimeFake.clients.every((client) => {
          return client.closed;
        }),
      ).toBe(true);
    },
  );

  it("reports an execution failure and releases the connection", async () => {
    serveCreate();
    let reads = 0;
    server.use(
      http.get(`${baseUrl}/commands/${commandId}`, () => {
        return response(++reads > 1 ? "failed" : "running");
      }),
    );
    await expect(run()).rejects.toThrow("process.exit called");
    expect(error.mock.calls.flat().join("\n")).toContain(
      "permission_denied: Access denied",
    );
    expect(ablyRealtimeFake.clients[0]?.closed).toBe(true);
  });

  it.each([401, 403] as const)(
    "stops with the HTTP authority error %s even while Ably is connected",
    async (status) => {
      const creates = serveCreate();
      let reads = 0;
      server.use(
        http.get(`${baseUrl}/commands/${commandId}`, () => {
          if (++reads === 1) return response("running");
          return HttpResponse.json(
            {
              error: {
                code: status === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
                message: "Computer Use access revoked",
              },
            },
            { status },
          );
        }),
      );
      await expect(run()).rejects.toThrow("process.exit called");
      expect(error.mock.calls.flat().join("\n")).toContain(
        status === 401
          ? "Authentication failed"
          : "Computer Use access revoked",
      );
      expect(log.mock.calls).toHaveLength(0);
      expect(ablyRealtimeFake.clients[0]?.closed).toBe(true);
      expect(creates()).toBe(1);
    },
  );

  it("recovers a missed completion message through a status read", async () => {
    serveCreate();
    let reads = 0;
    server.use(
      http.get(`${baseUrl}/commands/${commandId}`, () => {
        return response(++reads > 2 ? "succeeded" : "running");
      }),
    );
    await run();
    expect(log.mock.calls.flat().join("\n")).toContain("Chrome");
    expect(ablyRealtimeFake.clients[0]?.closed).toBe(true);
  });

  it("aborts a stalled status request at the command deadline and closes the subscription", async () => {
    serveCreate();
    const aborted = deferred<void>();
    let reads = 0;
    server.use(
      http.get(`${baseUrl}/commands/${commandId}`, async ({ request }) => {
        if (++reads > 1) {
          await new Promise<void>((resolve) => {
            request.signal.addEventListener(
              "abort",
              () => {
                aborted.resolve();
                resolve();
              },
              { once: true },
            );
          });
        }
        return response("running");
      }),
    );
    await expect(run("1")).rejects.toThrow("process.exit called");
    await aborted.promise;
    expect(error.mock.calls.flat().join("\n")).toContain(
      `Computer-use command timed out: ${commandId}`,
    );
    expect(ablyRealtimeFake.clients[0]?.closed).toBe(true);
  });
});
