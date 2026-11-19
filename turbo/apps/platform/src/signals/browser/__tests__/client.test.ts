import { expect, test } from "vitest";
import { mockMonotonicNow } from "../../../lib/time.ts";
import {
  createTestRuntime,
  testContext,
} from "../../__tests__/test-helpers.ts";
import { createCdpClient } from "../cdp/client.ts";
import { isRecord } from "../cdp/errors.ts";
import { connectNative } from "../cdp/native.ts";

const context = testContext();
const endpoint = "wss://browser.example/cdp";

test("a version-probe deadline leaves the CDP connection usable", async () => {
  let elapsed = 0;
  mockMonotonicNow(() => {
    return elapsed;
  }, context.signal);
  const requested = context.mocks.deferred<void>();
  context.mocks.browser.webSocket((data) => {
    const request: unknown = JSON.parse(data);
    if (!isRecord(request) || typeof request.id !== "number") {
      throw new Error("Invalid fixture request");
    }
    if (request.method === "Browser.getVersion") {
      requested.resolve();
      return null;
    }
    return JSON.stringify({ id: request.id, result: { targetInfos: [] } });
  });
  const client = createCdpClient(endpoint, {}, context.signal);
  await client.opened;
  const probe = client.request("Browser.getVersion", undefined);
  await requested.promise;
  elapsed = 31_000;
  await expect(probe).rejects.toMatchObject({
    kind: "protocol",
    readOnly: true,
  });
  await expect(
    client.request("Target.getTargets", undefined),
  ).resolves.toStrictEqual({
    targetInfos: [],
  });
  client.close();
});

test("closing a viewer rejects pending requests without closing the remote browser", async () => {
  const received: string[] = [];
  context.mocks.browser.webSocket((data) => {
    const request: unknown = JSON.parse(data);
    if (!isRecord(request) || typeof request.method !== "string") {
      throw new Error("Invalid fixture request");
    }
    received.push(request.method);
    return null;
  });
  const client = createCdpClient(endpoint, {}, context.signal);
  await client.opened;
  const results = Promise.allSettled([
    client.request("Target.getTargets", undefined),
    client.request("Browser.getVersion", undefined),
  ]);
  client.close();
  const replies = await results;
  expect(
    replies.map((reply) => {
      return reply.status;
    }),
  ).toStrictEqual(["rejected", "rejected"]);
  client.notify("Target.activateTarget", { targetId: "retired-page" });
  expect(received).toStrictEqual(["Target.getTargets", "Browser.getVersion"]);
});

test("raw native attachment cancellation preserves its original parent session", async () => {
  const operation = createTestRuntime(context);
  const sent = context.mocks.deferred<number>();
  const released = context.mocks.deferred<unknown>();
  const socket = context.mocks.browser.webSocket((data) => {
    const request: unknown = JSON.parse(data);
    if (!isRecord(request) || typeof request.id !== "number") {
      throw new Error("Invalid fixture request");
    }
    if (request.method === "Target.attachToBrowserTarget") {
      sent.resolve(request.id);
      return null;
    }
    if (request.method === "Target.detachFromTarget") {
      released.resolve({
        sessionId: request.sessionId,
        params: request.params,
      });
    }
    return JSON.stringify({
      id: request.id,
      result: { product: "original-browser" },
    });
  });
  const client = createCdpClient(endpoint, {}, context.signal);
  await client.opened;
  const result = client.requestRaw(
    "Target.attachToBrowserTarget",
    {},
    "original-parent",
    async (value) => {
      if (isRecord(value) && typeof value.sessionId === "string") {
        await client.requestRaw(
          "Target.detachFromTarget",
          { sessionId: value.sessionId },
          "original-parent",
        );
      }
    },
    operation.signal,
  );
  const id = await sent.promise;
  operation.dispose();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  await expect(
    client.request("Browser.getVersion", undefined),
  ).resolves.toMatchObject({ product: "original-browser" });
  socket.receive(
    endpoint,
    JSON.stringify({ id, result: { sessionId: "late-browser-session" } }),
  );
  await expect(released.promise).resolves.toStrictEqual({
    sessionId: "original-parent",
    params: { sessionId: "late-browser-session" },
  });
  client.close();
});

test("cancelling native bridge startup releases its late original attachment", async () => {
  const operation = createTestRuntime(context);
  const sent = context.mocks.deferred<number>();
  const released = context.mocks.deferred<unknown>();
  const socket = context.mocks.browser.webSocket((data) => {
    const request: unknown = JSON.parse(data);
    if (!isRecord(request) || typeof request.id !== "number") {
      throw new Error("Invalid fixture request");
    }
    if (request.method === "Target.attachToBrowserTarget") {
      sent.resolve(request.id);
      return null;
    }
    if (request.method === "Target.detachFromTarget") {
      released.resolve({
        sessionId: request.sessionId,
        params: request.params,
      });
    }
    return JSON.stringify({
      id: request.id,
      result: { product: "original-browser" },
    });
  });
  const client = createCdpClient(endpoint, {}, context.signal);
  await client.opened;
  const pending = connectNative(client, "a".repeat(32), operation.signal);
  const id = await sent.promise;
  operation.dispose();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  socket.receive(
    endpoint,
    JSON.stringify({ id, result: { sessionId: "late-native-session" } }),
  );
  await expect(released.promise).resolves.toStrictEqual({
    sessionId: undefined,
    params: { sessionId: "late-native-session" },
  });
  await expect(
    client.request("Browser.getVersion", undefined),
  ).resolves.toMatchObject({ product: "original-browser" });
  client.close();
});

test("native events remain private to the originating connection", async () => {
  const socket = context.mocks.browser.webSocket(() => {
    return null;
  });
  const otherEndpoint = "wss://browser.example/other";
  const first = createCdpClient(endpoint, {}, context.signal);
  const second = createCdpClient(otherEndpoint, {}, context.signal);
  await Promise.all([first.opened, second.opened]);
  const firstEvents: string[] = [];
  const secondEvents: string[] = [];
  first.onEvent((event) => {
    return firstEvents.push(event.method);
  });
  second.onEvent((event) => {
    return secondEvents.push(event.method);
  });
  socket.receive(
    endpoint,
    JSON.stringify({
      method: "Page.loadEventFired",
      sessionId: "same-session",
      params: { timestamp: 1 },
    }),
  );
  expect(firstEvents).toStrictEqual(["Page.loadEventFired"]);
  expect(secondEvents).toStrictEqual([]);
  socket.receive(
    endpoint,
    JSON.stringify({
      method: "Runtime.executionContextsCleared",
      sessionId: "same-session",
    }),
  );
  expect(firstEvents).toStrictEqual([
    "Page.loadEventFired",
    "Runtime.executionContextsCleared",
  ]);
  expect(secondEvents).toStrictEqual([]);
  first.close();
  socket.receive(
    endpoint,
    JSON.stringify({
      method: "Page.loadEventFired",
      sessionId: "same-session",
      params: { timestamp: 2 },
    }),
  );
  expect(firstEvents).toStrictEqual([
    "Page.loadEventFired",
    "Runtime.executionContextsCleared",
  ]);
  second.close();
});

test("parallel requests keep independent results when replies arrive out of order", async () => {
  const firstSent = context.mocks.deferred<number>();
  const secondSent = context.mocks.deferred<number>();
  const socket = context.mocks.browser.webSocket((data) => {
    const request: unknown = JSON.parse(data);
    if (!isRecord(request) || typeof request.id !== "number") {
      throw new Error("Invalid fixture request");
    }
    if (request.sessionId === "first-session") {
      firstSent.resolve(request.id);
    } else if (request.sessionId === "second-session") {
      secondSent.resolve(request.id);
    }
    return null;
  });
  const client = createCdpClient(endpoint, {}, context.signal);
  await client.opened;
  const first = client.request(
    "Page.navigate",
    { url: "https://first.example/" },
    "first-session",
  );
  const second = client.request(
    "Page.navigate",
    { url: "https://second.example/" },
    "second-session",
  );
  const [firstId, secondId] = await Promise.all([
    firstSent.promise,
    secondSent.promise,
  ]);
  socket.receive(
    endpoint,
    JSON.stringify({ id: secondId, result: { frameId: "second-frame" } }),
  );
  await expect(second).resolves.toStrictEqual({ frameId: "second-frame" });
  socket.receive(
    endpoint,
    JSON.stringify({ id: firstId, result: { frameId: "first-frame" } }),
  );
  await expect(first).resolves.toStrictEqual({ frameId: "first-frame" });
  client.close();
});

test("cancelling one request preserves its socket and releases a late original attachment", async () => {
  const operation = createTestRuntime(context);
  const sent = context.mocks.deferred<number>();
  const released = context.mocks.deferred<unknown>();
  const socket = context.mocks.browser.webSocket((data) => {
    const request: unknown = JSON.parse(data);
    if (!isRecord(request) || typeof request.id !== "number") {
      throw new Error("Invalid fixture request");
    }
    if (request.method === "Target.attachToTarget") {
      sent.resolve(request.id);
      return null;
    }
    if (request.method === "Target.detachFromTarget") {
      released.resolve(request.params);
      return null;
    }
    return JSON.stringify({
      id: request.id,
      result: { product: "same-browser" },
    });
  });
  const client = createCdpClient(endpoint, {}, context.signal);
  await client.opened;
  const result = client.request(
    "Target.attachToTarget",
    { targetId: "original-page", flatten: true },
    undefined,
    (reply) => {
      if (isRecord(reply) && typeof reply.sessionId === "string") {
        client.notify("Target.detachFromTarget", {
          sessionId: reply.sessionId,
        });
      }
    },
    operation.signal,
  );
  const id = await sent.promise;
  operation.dispose();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  await expect(
    client.request("Browser.getVersion", undefined),
  ).resolves.toMatchObject({ product: "same-browser" });
  socket.receive(
    endpoint,
    JSON.stringify({ id, result: { sessionId: "original-session" } }),
  );
  await expect(released.promise).resolves.toStrictEqual({
    sessionId: "original-session",
  });
  await expect(
    client.request("Browser.getVersion", undefined),
  ).resolves.toMatchObject({ product: "same-browser" });
  client.close();
});
