import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { on, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  createSecureContext,
  getCACertificates,
  setDefaultCACertificates,
} from "node:tls";
import "../src/__tests__/global-setup-env.ts";
import { createRunnerDispatchPool } from "../src/runner-dispatch-pool.node.ts";
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

async function withPeer(signal, run, pool, reply) {
  const handshake = Promise.withResolvers();
  const secure = Promise.withResolvers();
  const firstClosed = Promise.withResolvers();
  const context = createSecureContext({ key, cert });
  const transport = createRunnerDispatchTransport({ ...pool, observe() {} });
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
      ...(pool && { keepAliveTimeout: 35_000 }),
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
      if (pool) {
        // Omit the timeout hint so the client uses its configured idle limit.
        response.setHeader("keep-alive", "max=1000");
      }
      const chunks = [];
      request.on("data", (chunk) => {
        chunks.push(chunk);
      });
      request.once("end", () => {
        const bytes = Buffer.concat(chunks);
        const body =
          request.headers["content-encoding"] === "gzip"
            ? gunzipSync(bytes).toString("utf8")
            : bytes.toString("utf8");
        bodyPorts.push(request.socket.remotePort ?? 0);
        bodies.push(body);
        const accept = () => {
          response.end(JSON.stringify({ disposition: "accepted" }));
        };
        if (reply) {
          reply(accept);
        } else {
          accept();
        }
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

async function waitForFetchClientDrain(origin, signal) {
  // Observe the default dispatcher shared by native fetch and Undici. Node 22
  // uses the v1 key, while newer Node versions expose the agent under v2.
  const dispatcher =
    globalThis[Symbol.for("undici.globalDispatcher.2")] ??
    globalThis[Symbol.for("undici.globalDispatcher.1")];
  assert.ok(dispatcher, "Expected native fetch to initialize its dispatcher");
  for await (const [connectedOrigin, targets] of on(dispatcher, "connect", {
    signal,
  })) {
    if (connectedOrigin.origin === origin) {
      await once(targets.at(-1), "drain", { signal });
      return;
    }
  }
  throw new Error("Expected native fetch to connect to the HTTPS peer");
}

function reserve(transport, runId, url, signal, encoding = "identity") {
  transport.reserve(
    runId,
    url,
    (body, connectionSignal) => {
      return {
        response: transport.request(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(encoding === "gzip" ? { "content-encoding": "gzip" } : {}),
          },
          body,
          duplex: "half",
          signal: connectionSignal,
        }),
        timing: { startedAt: 0, sendCount: 0 },
      };
    },
    signal,
    encoding,
  );
}

async function send(transport, url) {
  const signal = globalThis.AbortSignal.timeout(3000);
  const reserved = transport.take(url, dispatchBody, 1, signal);
  try {
    const response = await (reserved?.response ??
      transport.request(url, {
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
  "releases gzip bytes on its reserved HTTPS request",
  { timeout: 5000 },
  async (t) => {
    await withPeer(t.signal, async (peer) => {
      reserve(peer.transport, "gzip", peer.origin, t.signal, "gzip");
      await peer.firstHandshake;
      assert.deepEqual(peer.requestPaths, []);
      const reserved = peer.transport.take(
        peer.origin,
        gzipSync(dispatchBody),
        1,
        t.signal,
        "gzip",
      );
      assert.ok(reserved);
      try {
        peer.releaseHandshake();
        const response = await reserved.response;
        assert.deepEqual(await response.json(), { disposition: "accepted" });
        assert.deepEqual(peer.bodies, [dispatchBody]);
        assert.deepEqual(peer.bodyPorts, peer.ports);
      } finally {
        reserved.clearDeadline();
      }
    });
  },
);

test(
  "discards a reserved gzip POST when the offer uses plain JSON",
  { timeout: 5000 },
  async (t) => {
    await withPeer(t.signal, async (peer) => {
      reserve(peer.transport, "gzip", peer.origin, t.signal, "gzip");
      await peer.firstHandshake;
      assert.equal(
        peer.transport.take(peer.origin, dispatchBody, 1, t.signal),
        undefined,
      );
      peer.releaseHandshake();
      await peer.firstClosed;
      assert.deepEqual(peer.requestPaths, []);
      await send(peer.transport, peer.origin);
      assert.deepEqual(peer.bodies, [dispatchBody]);
    });
  },
);

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
      // Consuming the response can finish before the pool can reuse the client.
      const reusable = waitForFetchClientDrain(peer.origin, test.signal);
      peer.releaseHandshake();
      await Promise.all([post, reusable]);
      assert.deepEqual(peer.bodyPorts, peer.ports);
      assert.deepEqual(peer.bodies, [dispatchBody]);

      await send(transport, peer.origin);
      assert.equal(peer.ports.length, 1);
      assert.deepEqual(peer.bodyPorts, [peer.ports[0], peer.ports[0]]);
    });
  },
);

test(
  "shares the socket across reserved and direct POSTs after an idle gap",
  { timeout: 12_000 },
  async (t) => {
    const pool = createRunnerDispatchPool();
    try {
      await withPeer(
        t.signal,
        async (peer) => {
          const { transport, origin } = peer;
          reserve(transport, "retained", origin, t.signal);
          await peer.firstHandshake;
          assert.deepEqual(peer.requestPaths, []);
          peer.releaseHandshake();
          await send(transport, origin);
          await delay(5500, undefined, { signal: t.signal });
          await send(transport, origin + "/next");
          assert.deepEqual(peer.requestPaths, ["/", "/next"]);
          assert.deepEqual(peer.bodies, [dispatchBody, dispatchBody]);
          assert.equal(peer.ports.length, 1);
          assert.deepEqual(peer.bodyPorts, [peer.ports[0], peer.ports[0]]);
          assert.equal(transport.poolStats(origin).connected, 1);
        },
        pool,
      );
    } finally {
      await pool.destroy();
    }
  },
);

test(
  "opens another socket while every existing socket is busy",
  { timeout: 5000 },
  async (t) => {
    const pool = createRunnerDispatchPool();
    const replies = [];
    const received = Promise.withResolvers();
    try {
      await withPeer(
        t.signal,
        async ({ transport, origin, bodyPorts, releaseHandshake }) => {
          releaseHandshake();
          const sends = Promise.all(
            Array.from({ length: 5 }, (_, i) => {
              return send(transport, origin + "/" + i);
            }),
          );
          await Promise.race([received.promise, sends]);
          assert.equal(new Set(bodyPorts).size, 5);
          for (const reply of replies) {
            reply();
          }
          await sends;
        },
        pool,
        (reply) => {
          replies.push(reply);
          if (replies.length === 5) {
            received.resolve();
          }
        },
      );
    } finally {
      await pool.destroy();
    }
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

      const { hostname, port } = new globalThis.URL(peer.origin);
      const client = Promise.withResolvers();
      const connected = channel("undici:client:connected");
      function onConnected({ connectParams, socket }) {
        if (
          connectParams.hostname === hostname &&
          String(connectParams.port) === port
        ) {
          client.resolve(socket);
        }
      }
      connected.subscribe(onConnected);
      test.after(() => {
        connected.unsubscribe(onConnected);
      });

      peer.releaseHandshake();
      const [, socket] = await Promise.all([
        peer.firstSecureConnection,
        client.promise,
      ]);
      assert.equal(socket.bytesWritten, 0);
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
