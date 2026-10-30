import { expect, test } from "vitest";
import {
  createTestRuntime,
  testContext,
} from "../../__tests__/test-helpers.ts";
import { createCdpClient } from "../cdp/client.ts";
import { isRecord } from "../cdp/errors.ts";
import { createTargetDirectory } from "../cdp/targets.ts";
import { CreatedTabFault, openTab } from "../cdp/tabs.ts";
import { releaseRuntimeObjects } from "../cdp/runtime-objects.ts";
import { createCanvasRenderer, type DecodedFrame } from "../render/canvas.ts";

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
  const client = createCdpClient(endpoint, context.signal, undefined, 20);
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
  const client = createCdpClient(endpoint, context.signal);
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

test("a failed created-tab preparation retains its receipt without replaying creation", async () => {
  const methods: string[] = [];
  context.mocks.browser.webSocket((data) => {
    const request: unknown = JSON.parse(data);
    if (!isRecord(request) || typeof request.method !== "string") {
      throw new Error("Invalid fixture request");
    }
    methods.push(request.method);
    return JSON.stringify({
      id: request.id,
      result:
        request.method === "Target.createTarget"
          ? { targetId: "already-created" }
          : { windowId: 1 },
    });
  });
  const client = createCdpClient(endpoint, context.signal);
  await client.opened;
  const result = openTab(client, createTargetDirectory(client, 0), null, () => {
    return !context.signal.aborted;
  });
  await expect(result).rejects.toBeInstanceOf(CreatedTabFault);
  await expect(result).rejects.toMatchObject({
    targetId: "already-created",
    kind: "scope",
  });
  expect(methods).toStrictEqual([
    "Target.createTarget",
    "Browser.getWindowForTarget",
  ]);
  client.close();
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
  const client = createCdpClient(endpoint, context.signal);
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
  const first = createCdpClient(endpoint, context.signal);
  const second = createCdpClient(otherEndpoint, context.signal);
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
  const client = createCdpClient(endpoint, context.signal);
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
  const client = createCdpClient(endpoint, context.signal);
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

test("an already-cancelled request never writes to the native connection", async () => {
  const operation = createTestRuntime(context);
  const requests: unknown[] = [];
  context.mocks.browser.webSocket((data) => {
    const request: unknown = JSON.parse(data);
    if (!isRecord(request)) {
      throw new Error("Invalid fixture request");
    }
    requests.push(request);
    return JSON.stringify({
      id: request.id,
      result: { product: "same-browser" },
    });
  });
  const client = createCdpClient(endpoint, context.signal);
  await client.opened;
  operation.dispose();
  await expect(
    client.request(
      "Target.createTarget",
      { url: "about:blank" },
      undefined,
      undefined,
      operation.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(requests).toHaveLength(0);
  await expect(
    client.request("Browser.getVersion", undefined),
  ).resolves.toMatchObject({ product: "same-browser" });
  client.close();
});

test("cancelling one connection rejects its request while another stays usable", async () => {
  const runtime = createTestRuntime(context);
  const sent = context.mocks.deferred<void>();
  const disconnected = context.mocks.deferred<string>();
  context.mocks.browser.webSocket((data) => {
    const request: unknown = JSON.parse(data);
    if (!isRecord(request)) {
      throw new Error("Invalid fixture request");
    }
    if (request.method === "Target.getTargets") {
      sent.resolve();
      return null;
    }
    return JSON.stringify({
      id: request.id,
      result: { product: "remaining-browser" },
    });
  });
  const first = createCdpClient(endpoint, runtime.signal);
  const second = createCdpClient(
    "wss://browser.example/remaining",
    context.signal,
  );
  first.onClose((fault) => {
    disconnected.resolve(fault.kind);
  });
  await Promise.all([first.opened, second.opened]);
  const result = first.request("Target.getTargets", undefined);
  await sent.promise;
  runtime.dispose();
  await expect(result).rejects.toMatchObject({ kind: "connection" });
  await expect(disconnected.promise).resolves.toBe("connection");
  await expect(
    second.request("Browser.getVersion", undefined),
  ).resolves.toMatchObject({ product: "remaining-browser" });
  second.close();
});

test("late Runtime objects are released on their original connection and session", async () => {
  const sent = context.mocks.deferred<number>();
  const released = context.mocks.deferred<{
    url: string;
    sessionId: unknown;
    params: unknown;
  }>();
  const socket = context.mocks.browser.webSocket((data, url) => {
    const request: unknown = JSON.parse(data);
    if (!isRecord(request) || typeof request.id !== "number") {
      throw new Error("Invalid fixture request");
    }
    if (request.method === "Runtime.evaluate") {
      sent.resolve(request.id);
    } else if (request.method === "Runtime.releaseObject") {
      released.resolve({
        url,
        sessionId: request.sessionId,
        params: request.params,
      });
    }
    return null;
  });
  const original = createCdpClient(endpoint, context.signal, undefined, 20);
  const replacement = createCdpClient(
    "wss://browser.example/replacement",
    context.signal,
  );
  await Promise.all([original.opened, replacement.opened]);
  const result = original.request(
    "Runtime.evaluate",
    { expression: "({})" },
    "original-session",
    (reply) => {
      releaseRuntimeObjects(original, "original-session", reply);
    },
  );
  const id = await sent.promise;
  await expect(result).rejects.toMatchObject({
    kind: "protocol",
    message: "The browser request timed out.",
  });
  socket.receive(
    endpoint,
    JSON.stringify({
      id,
      result: { result: { type: "object", objectId: "original-object" } },
    }),
  );
  await expect(released.promise).resolves.toStrictEqual({
    url: endpoint,
    sessionId: "original-session",
    params: { objectId: "original-object" },
  });
  original.close();
  replacement.close();
});

test("canvas decoding coalesces queued frames and reports only completed draws", async () => {
  const rendering = context.mocks.browser.canvasRendering();
  const first = context.mocks.deferred<DecodedFrame>();
  const latest = context.mocks.deferred<DecodedFrame>();
  const finished = context.mocks.deferred<void>();
  const canvas = document.createElement("canvas");
  const decoded: string[] = [];
  const closed: string[] = [];
  const painted: { frame: string; draws: number }[] = [];
  const failures: unknown[] = [];
  const renderer = createCanvasRenderer(canvas, (data) => {
    decoded.push(data);
    return data === "first" ? first.promise : latest.promise;
  });
  const push = (frame: string) => {
    renderer.push(
      frame,
      () => {
        painted.push({ frame, draws: rendering.imageDraws.length });
      },
      (error) => {
        failures.push(error);
      },
    );
  };
  push("first");
  push("superseded");
  push("latest");
  first.resolve({
    source: document.createElement("canvas"),
    width: 640,
    height: 480,
    close: () => {
      closed.push("first");
    },
  });
  latest.resolve({
    source: document.createElement("canvas"),
    width: 800,
    height: 600,
    close: () => {
      closed.push("latest");
      finished.resolve();
    },
  });
  await finished.promise;
  expect(decoded).toStrictEqual(["first", "latest"]);
  expect(closed).toStrictEqual(["first", "latest"]);
  expect(painted).toStrictEqual([
    { frame: "first", draws: 1 },
    { frame: "latest", draws: 2 },
  ]);
  expect(failures).toStrictEqual([]);
  expect({ width: canvas.width, height: canvas.height }).toStrictEqual({
    width: 800,
    height: 600,
  });
  renderer.dispose();
});

test("invalidated decodes are released and admission cannot paint an invalidated frame", async () => {
  const rendering = context.mocks.browser.canvasRendering();
  const stale = context.mocks.deferred<DecodedFrame>();
  const current = context.mocks.deferred<DecodedFrame>();
  const finished = context.mocks.deferred<void>();
  const closed: string[] = [];
  const painted: string[] = [];
  const failures: unknown[] = [];
  const renderer = createCanvasRenderer(
    document.createElement("canvas"),
    (data) => {
      return data === "stale" ? stale.promise : current.promise;
    },
  );
  const failed = (error: unknown) => {
    failures.push(error);
  };
  renderer.push(
    "stale",
    () => {
      painted.push("stale");
    },
    failed,
  );
  renderer.invalidate();
  renderer.push(
    "current",
    () => {
      painted.push("current");
    },
    failed,
    () => {
      renderer.invalidate();
      return true;
    },
  );
  stale.resolve({
    source: document.createElement("canvas"),
    width: 640,
    height: 480,
    close: () => {
      closed.push("stale");
    },
  });
  current.resolve({
    source: document.createElement("canvas"),
    width: 800,
    height: 600,
    close: () => {
      closed.push("current");
      finished.resolve();
    },
  });
  await finished.promise;
  expect(closed).toStrictEqual(["stale", "current"]);
  expect(rendering.imageDraws).toStrictEqual([]);
  expect(painted).toStrictEqual([]);
  expect(failures).toStrictEqual([]);
  renderer.dispose();
});
