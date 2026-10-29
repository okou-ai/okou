import { expect, test } from "vitest";
import { testContext } from "../../__tests__/test-helpers.ts";
import { CdpClient } from "../cdp/client.ts";
import { isRecord } from "../cdp/errors.ts";

const context = testContext();
const endpoint = "wss://browser.example/cdp";

test("a late attach receipt releases only its original session after the deadline", async () => {
  const attached = context.mocks.deferred<number>();
  const detached = context.mocks.deferred<unknown>();
  const socket = context.mocks.browser.webSocket((data) => {
    const request: unknown = JSON.parse(data);
    if (!isRecord(request)) {
      throw new Error("Invalid fixture request");
    }
    if (request.method === "Target.attachToTarget") {
      attached.resolve(request.id as number);
    }
    if (request.method === "Target.detachFromTarget") {
      detached.resolve(request.params);
    }
    return null;
  });
  const client = new CdpClient(endpoint, context.signal, undefined, 20);
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
  );
  const id = await attached.promise;
  await expect(result).rejects.toMatchObject({
    kind: "protocol",
    message: "The browser request timed out.",
  });
  socket.receive(
    endpoint,
    JSON.stringify({ id, result: { sessionId: "original-session" } }),
  );
  await expect(detached.promise).resolves.toStrictEqual({
    sessionId: "original-session",
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
  const client = new CdpClient(endpoint, context.signal);
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

test("an ambiguous CDP response rejects its pending request", async () => {
  context.mocks.browser.webSocket((data) => {
    const request: unknown = JSON.parse(data);
    if (!isRecord(request)) {
      throw new Error("Invalid fixture request");
    }
    return JSON.stringify({
      id: request.id,
      result: {},
      error: { code: -32_000, message: "private provider details" },
    });
  });
  const client = new CdpClient(endpoint, context.signal);
  await client.opened;
  await expect(
    client.request("Target.getTargets", undefined),
  ).rejects.toMatchObject({
    kind: "protocol",
    message: "Invalid CDP response.",
  });
  await expect(
    client.request("Browser.getVersion", undefined),
  ).rejects.toMatchObject({ kind: "connection" });
});

test("native events remain private to the originating connection", async () => {
  const socket = context.mocks.browser.webSocket(() => {
    return null;
  });
  const otherEndpoint = "wss://browser.example/other";
  const first = new CdpClient(endpoint, context.signal);
  const second = new CdpClient(otherEndpoint, context.signal);
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
