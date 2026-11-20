import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createSecureContext } from "node:tls";
import { setImmediate } from "node:timers/promises";
import { createRunnerDispatchExperiment } from "../src/runner-dispatch-experiment.node.ts";
import { runnerDispatchCohort } from "../src/signals/external/runner-dispatch-experiment.ts";

test("enrolls all production runs and splits preview runs evenly", () => {
  const runIds = Array.from({ length: 100 }, (_, bucket) => {
    const runId =
      bucket.toString(16).padStart(8, "0") + "-0000-4000-8000-000000000000";
    return runId;
  });
  assert.ok(
    runIds.every((runId) => {
      return runnerDispatchCohort(runId, 100) === "preconnect";
    }),
  );
  const preview = runIds.map((runId) => {
    return runnerDispatchCohort(runId, 50);
  });
  assert.deepEqual(preview.slice(0, 50), new Array(50).fill("preconnect"));
  assert.deepEqual(preview.slice(50), new Array(50).fill("control"));
});

let directory;
let cert;
let key;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "runner-preview-tls-"));
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

async function send(preview, origin, cohort) {
  const response = await preview.fetch(cohort, origin, {
    method: "POST",
    cache: "no-store",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: globalThis.AbortSignal.timeout(3000),
  });
  assert.deepEqual(await response.json(), { disposition: "accepted" });
}

test(
  "adopts a pending handshake and reuses the resulting pooled socket",
  { timeout: 5000 },
  async (test) => {
    await withPeer(async (peer) => {
      const observe = test.mock.fn();
      const preview = createRunnerDispatchExperiment({ ca: cert, observe });
      const run = new globalThis.AbortController();
      preview.reserve("first", peer.origin, run.signal);
      preview.reserve("duplicate", peer.origin, run.signal);
      await peer.firstHandshake;
      assert.deepEqual(peer.bodyPorts, []);

      const connecting = Promise.withResolvers();
      const beforeConnect = channel("undici:client:beforeConnect");
      const sendHeaders = channel("undici:client:sendHeaders");
      const socketUses = [];
      const onSend = ({ socket }) => {
        socketUses.push(preview.takeSocketUse(socket));
      };
      beforeConnect.subscribe(connecting.resolve);
      sendHeaders.subscribe(onSend);
      try {
        const post = send(preview, peer.origin, "preconnect");
        await connecting.promise;
        peer.releaseHandshake();
        await post;
      } finally {
        beforeConnect.unsubscribe(connecting.resolve);
        sendHeaders.unsubscribe(onSend);
      }
      assert.deepEqual(socketUses, ["pending"]);
      assert.deepEqual(observe.mock.calls[0].arguments.slice(0, 2), [
        "first",
        "pending",
      ]);
      assert.deepEqual(peer.bodyPorts, peer.ports);

      await setImmediate();
      preview.reserve("second", peer.origin, run.signal);
      await send(preview, peer.origin, "preconnect");
      run.abort();
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
      const preview = createRunnerDispatchExperiment({ ca: cert, observe });
      preview.reserve("ready", peer.origin, test.signal);
      await peer.firstHandshake;
      peer.releaseHandshake();
      await peer.firstSecureConnection;
      assert.deepEqual(peer.bodyPorts, []);

      await send(preview, peer.origin, "preconnect");
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
  "closes a cancelled speculative socket and keeps the control pool independent",
  { timeout: 5000 },
  async (test) => {
    await withPeer(async (peer) => {
      const observe = test.mock.fn();
      const preview = createRunnerDispatchExperiment({ ca: cert, observe });
      const run = new globalThis.AbortController();
      preview.reserve("cancelled", peer.origin, run.signal);
      await peer.firstHandshake;
      run.abort();
      await peer.firstClosed;
      assert.deepEqual(observe.mock.calls[0].arguments.slice(0, 2), [
        "cancelled",
        "cancelled",
      ]);
      peer.releaseHandshake();

      await send(preview, peer.origin, "control");
      assert.equal(peer.ports.length, 2);
      assert.deepEqual(peer.bodyPorts, [peer.ports[1]]);
    });
  },
);

test(
  "expires an unused handshake and never adopts it for a different origin",
  { timeout: 5000 },
  async (test) => {
    await withPeer(async (first) => {
      await withPeer(async (second) => {
        const outcome = Promise.withResolvers();
        const preview = createRunnerDispatchExperiment({
          ca: cert,
          observe(runId, result) {
            outcome.resolve({ runId, result });
          },
        });
        preview.reserve("unused", first.origin, test.signal);
        await first.firstHandshake;
        second.releaseHandshake();
        await send(preview, second.origin, "preconnect");
        assert.deepEqual(second.bodyPorts, second.ports);
        assert.deepEqual(first.bodyPorts, []);
        assert.deepEqual(await outcome.promise, {
          runId: "unused",
          result: "expired",
        });
        await first.firstClosed;
      });
    });
  },
);
