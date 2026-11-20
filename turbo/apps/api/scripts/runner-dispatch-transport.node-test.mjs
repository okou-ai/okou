import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createSecureContext } from "node:tls";
import { setImmediate } from "node:timers/promises";
import { createRunnerDispatchTransport } from "../src/runner-dispatch-transport.node.ts";

let directory;
let cert;
let key;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "runner-transport-tls-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function withPeer(run) {
  const handshake = Promise.withResolvers();
  const secure = Promise.withResolvers();
  const firstClosed = Promise.withResolvers();
  const context = createSecureContext({ key, cert });
  const ports = [];
  const bodyPorts = [];
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
      request.resume();
      request.once("end", () => {
        bodyPorts.push(request.socket.remotePort ?? 0);
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

async function send(transport, url, observe) {
  const response = await transport.fetch(
    url,
    {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
    observe,
    globalThis.AbortSignal.timeout(3000),
  );
  assert.deepEqual(await response.json(), { disposition: "accepted" });
}

test(
  "starts TLS before sending a POST and reuses the resulting socket",
  { timeout: 5000 },
  async (test) => {
    await withPeer(async (peer) => {
      const observe = test.mock.fn();
      const transport = createRunnerDispatchTransport({ ca: cert, observe });
      const run = new globalThis.AbortController();
      transport.reserve("first", peer.origin, run.signal);
      transport.reserve("duplicate", peer.origin, run.signal);
      await peer.firstHandshake;
      assert.deepEqual(peer.requestPaths, []);

      const socketUses = [];
      const post = send(
        transport,
        peer.origin,
        (_connection, preconnection) => {
          socketUses.push(preconnection);
        },
      );
      run.abort();
      peer.releaseHandshake();
      await post;
      assert.deepEqual(socketUses, ["pending"]);
      assert.deepEqual(observe.mock.calls[0].arguments.slice(0, 2), [
        "first",
        "pending",
      ]);
      assert.deepEqual(peer.bodyPorts, peer.ports);

      await setImmediate();
      const nextRun = new globalThis.AbortController();
      transport.reserve("second", peer.origin, nextRun.signal);
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
      const transport = createRunnerDispatchTransport({ ca: cert, observe });
      transport.reserve("ready", peer.origin, test.signal);
      await peer.firstHandshake;
      peer.releaseHandshake();
      await peer.firstSecureConnection;
      await setImmediate();
      assert.deepEqual(peer.requestPaths, []);

      await send(transport, peer.origin);
      assert.deepEqual(observe.mock.calls[0].arguments.slice(0, 2), [
        "ready",
        "ready",
      ]);
      assert.equal(peer.ports.length, 1);
      assert.deepEqual(peer.bodyPorts, peer.ports);
    });
  },
);

test(
  "closes a cancelled speculative socket before falling back to a new connection",
  { timeout: 5000 },
  async (test) => {
    await withPeer(async (peer) => {
      const observe = test.mock.fn();
      const transport = createRunnerDispatchTransport({ ca: cert, observe });
      const run = new globalThis.AbortController();
      transport.reserve("cancelled", peer.origin, run.signal);
      await peer.firstHandshake;
      run.abort();
      await peer.firstClosed;
      assert.deepEqual(observe.mock.calls[0].arguments.slice(0, 2), [
        "cancelled",
        "cancelled",
      ]);
      peer.releaseHandshake();

      await send(transport, peer.origin);
      assert.equal(peer.ports.length, 2);
      assert.deepEqual(peer.bodyPorts, [peer.ports[1]]);
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
        ca: cert,
        observe(runId, result) {
          outcome.resolve({ runId, result });
        },
      });
      transport.reserve("unused", `${peer.origin}/unused`, test.signal);
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
