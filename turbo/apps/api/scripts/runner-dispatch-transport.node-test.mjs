import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createSecureContext,
  getCACertificates,
  setDefaultCACertificates,
} from "node:tls";
import { setImmediate } from "node:timers/promises";
import "../src/__tests__/global-setup-env.ts";
import { createRunnerDispatchTransport } from "../src/runner-dispatch-transport.node.ts";
import { awaitWithSignal } from "../src/signals/utils.ts";

async function createPeerCredentials() {
  const directory = await mkdtemp(join(tmpdir(), "runner-transport-tls-"));
  try {
    const cert = join(directory, "cert.pem");
    const key = join(directory, "key.pem");
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
        key,
        "-out",
        cert,
      ],
      { stdio: "ignore" },
    );
    return await Promise.all([readFile(cert), readFile(key)]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const [cert, key] = await createPeerCredentials();
setDefaultCACertificates([
  ...getCACertificates("default"),
  cert.toString("utf8"),
]);
const dispatchBody = JSON.stringify({ prompt: "Summarize the café menu" });

async function withPeer(signal, run) {
  const handshake = Promise.withResolvers();
  const secure = Promise.withResolvers();
  const firstClosed = Promise.withResolvers();
  const context = createSecureContext({ key, cert });
  const transport = createRunnerDispatchTransport({ observe() {} });
  const sockets = new Set();
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
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
    ports.push(socket.remotePort ?? 0);
    if (ports.length === 1) {
      socket.once("close", firstClosed.resolve);
    }
  });
  server.once("secureConnection", secure.resolve);
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening", { signal });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP fixture address");
    }
    await awaitWithSignal(
      run({
        origin: `https://localhost:${address.port}`,
        transport,
        ports,
        bodyPorts,
        bodies,
        requestPaths,
        firstHandshake: handshake.promise,
        firstSecureConnection: secure.promise,
        firstClosed: firstClosed.promise,
        releaseHandshake,
      }),
      signal,
    );
  } finally {
    releaseHandshake();
    const closed = once(server, "close");
    server.close();
    for (const socket of sockets) {
      socket.destroy();
    }
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
  const reserved = transport.take(url, dispatchBody, 1, signal);
  try {
    const response = await (reserved?.response ??
      globalThis.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: dispatchBody,
        signal,
      }));
    assert.deepEqual(await response.json(), { disposition: "accepted" });
  } finally {
    reserved?.clearDeadline();
  }
}
test(
  "starts TLS before sending a POST and reuses the resulting socket",
  { timeout: 5000 },
  async (test) => {
    await withPeer(test.signal, async (peer) => {
      const { transport } = peer;
      const run = new globalThis.AbortController();
      reserve(transport, "first", peer.origin, run.signal);
      reserve(transport, "second", `${peer.origin}/second`, run.signal);
      await peer.firstHandshake;
      assert.deepEqual(peer.requestPaths, []);

      const post = send(transport, peer.origin);
      run.abort();
      peer.releaseHandshake();
      await post;
      assert.deepEqual(peer.bodyPorts, peer.ports);
      assert.deepEqual(peer.bodies, [dispatchBody]);

      await setImmediate();
      await send(transport, peer.origin);
      assert.equal(peer.ports.length, 1);
      assert.deepEqual(peer.bodyPorts, [peer.ports[0], peer.ports[0]]);
    });
  },
);

test(
  "sends the POST on a handshake that completed before dispatch",
  { timeout: 5000 },
  async (test) => {
    await withPeer(test.signal, async (peer) => {
      const { transport } = peer;
      reserve(transport, "ready", peer.origin, test.signal);
      await peer.firstHandshake;
      peer.releaseHandshake();
      await peer.firstSecureConnection;
      await setImmediate();
      assert.deepEqual(peer.requestPaths, []);

      await send(transport, peer.origin);
      assert.equal(peer.ports.length, 1);
      assert.deepEqual(peer.bodyPorts, peer.ports);
      assert.deepEqual(peer.bodies, [dispatchBody]);
    });
  },
);

test(
  "cancels a speculative POST during TLS before it can send headers",
  { timeout: 5000 },
  async (test) => {
    await withPeer(test.signal, async (peer) => {
      const { transport } = peer;
      const run = new globalThis.AbortController();
      reserve(transport, "cancelled", peer.origin, run.signal);
      await peer.firstHandshake;
      run.abort();
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
    await withPeer(test.signal, async (peer) => {
      const { transport } = peer;
      reserve(transport, "unused", `${peer.origin}/unused`, test.signal);
      await peer.firstHandshake;
      peer.releaseHandshake();
      await send(transport, `${peer.origin}/other`);
      assert.deepEqual(peer.requestPaths, ["/other"]);
      assert.equal(peer.ports.length, 2);
      await peer.firstClosed;
    });
  },
);
