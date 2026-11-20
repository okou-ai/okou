import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import process from "node:process";
import { test } from "node:test";
import { createSecureContext } from "node:tls";
import { setImmediate } from "node:timers/promises";
import { createRunnerDispatchTransport } from "../src/runner-dispatch-transport.node.ts";

const [certPath, keyPath] = process.argv.slice(2);
assert(certPath && keyPath);
const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);

async function withPeer(run) {
  const handshake = Promise.withResolvers();
  const secure = Promise.withResolvers();
  const firstClosed = Promise.withResolvers();
  const context = createSecureContext({ key, cert });
  const ports = [];
  const bodyPorts = [];
  const bodies = [];
  const requestPaths = [];
  const pending = [];
  let released = false;
  function releaseHandshake() {
    released = true;
    for (const callback of pending.splice(0)) {
      callback(null, context);
    }
  }
  const server = createServer(
    {
      key,
      cert,
      SNICallback(_servername, callback) {
        handshake.resolve();
        if (released) {
          callback(null, context);
        } else {
          pending.push(callback);
        }
      },
    },
    (request, response) => {
      requestPaths.push(request.url);
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.once("end", () => {
        bodyPorts.push(request.socket.remotePort ?? 0);
        bodies.push(body);
        response.end(JSON.stringify({ disposition: "accepted" }));
      });
    },
  );
  server.on("connection", (socket) => {
    ports.push(socket.remotePort ?? 0);
    if (ports.length === 1) {
      socket.once("close", firstClosed.resolve);
    }
  });
  server.once("secureConnection", secure.resolve);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP fixture address");
  }
  try {
    await run({
      origin: `https://localhost:${address.port}`,
      ports,
      bodyPorts,
      bodies,
      requestPaths,
      firstHandshake: handshake.promise,
      firstSecureConnection: secure.promise,
      firstClosed: firstClosed.promise,
      releaseHandshake,
    });
  } finally {
    releaseHandshake();
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
}

function reserve(transport, runId, url, signal) {
  transport.reserve(
    runId,
    url,
    (body, connectionSignal) => {
      return {
        response: globalThis.fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          duplex: "half",
          signal: connectionSignal,
        }),
        timing: { startedAt: 0, sendCount: 0 },
      };
    },
    signal,
  );
}

async function send(transport, url) {
  const signal = globalThis.AbortSignal.timeout(3000);
  const reserved = transport.take(url, "{}", 1, signal);
  const response = await (reserved?.response ??
    globalThis.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal,
    }));
  try {
    assert.deepEqual(await response.json(), { disposition: "accepted" });
  } finally {
    reserved?.clearDeadline();
  }
}
test(
  "starts TLS before sending a POST and reuses the resulting socket",
  { timeout: 5000 },
  async (test) => {
    await withPeer(async (peer) => {
      const observe = test.mock.fn();
      const transport = createRunnerDispatchTransport({ observe });
      const run = new globalThis.AbortController();
      reserve(transport, "first", peer.origin, run.signal);
      reserve(transport, "duplicate", peer.origin, run.signal);
      await peer.firstHandshake;
      assert.deepEqual(peer.requestPaths, []);

      const post = send(transport, peer.origin);
      run.abort();
      peer.releaseHandshake();
      await post;
      assert.deepEqual(observe.mock.calls[0].arguments.slice(0, 2), [
        "first",
        "used",
      ]);
      assert.deepEqual(peer.bodyPorts, peer.ports);
      assert.deepEqual(peer.bodies, ["{}"]);

      await setImmediate();
      const nextRun = new globalThis.AbortController();
      await send(transport, peer.origin);
      nextRun.abort();
      assert.equal(peer.ports.length, 1);
      assert.deepEqual(peer.bodyPorts, [peer.ports[0], peer.ports[0]]);
      assert.equal(observe.mock.callCount(), 1);
    });
  },
);

test(
  "sends the POST on a handshake that completed before dispatch",
  { timeout: 5000 },
  async (test) => {
    await withPeer(async (peer) => {
      const observe = test.mock.fn();
      const transport = createRunnerDispatchTransport({ observe });
      reserve(transport, "ready", peer.origin, test.signal);
      await peer.firstHandshake;
      peer.releaseHandshake();
      await peer.firstSecureConnection;
      await setImmediate();
      assert.deepEqual(peer.requestPaths, []);

      await send(transport, peer.origin);
      assert.deepEqual(observe.mock.calls[0].arguments.slice(0, 2), [
        "ready",
        "used",
      ]);
      assert.equal(peer.ports.length, 1);
      assert.deepEqual(peer.bodyPorts, peer.ports);
      assert.deepEqual(peer.bodies, ["{}"]);
    });
  },
);

test(
  "cancels a speculative POST during TLS before it can send headers",
  { timeout: 5000 },
  async (test) => {
    await withPeer(async (peer) => {
      const observe = test.mock.fn();
      const transport = createRunnerDispatchTransport({ observe });
      const run = new globalThis.AbortController();
      reserve(transport, "cancelled", peer.origin, run.signal);
      await peer.firstHandshake;
      run.abort();
      assert.deepEqual(observe.mock.calls[0].arguments.slice(0, 2), [
        "cancelled",
        "cancelled",
      ]);
      peer.releaseHandshake();

      await send(transport, peer.origin);
      assert.deepEqual(peer.requestPaths, ["/"]);
      assert.equal(peer.bodyPorts.length, 1);
    });
  },
);

test(
  "expires an unused handshake and never adopts it for a different request path",
  { timeout: 5000 },
  async (test) => {
    await withPeer(async (peer) => {
      const outcome = Promise.withResolvers();
      const transport = createRunnerDispatchTransport({
        observe(runId, result) {
          outcome.resolve({ runId, result });
        },
      });
      reserve(transport, "unused", `${peer.origin}/unused`, test.signal);
      await peer.firstHandshake;
      peer.releaseHandshake();
      await send(transport, `${peer.origin}/other`);
      assert.deepEqual(peer.requestPaths, ["/other"]);
      assert.equal(peer.ports.length, 2);
      assert.deepEqual(await outcome.promise, {
        runId: "unused",
        result: "expired",
      });
      await peer.firstClosed;
    });
  },
);
