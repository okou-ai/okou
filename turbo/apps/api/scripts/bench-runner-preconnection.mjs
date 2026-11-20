// Set NODE_EXTRA_CA_CERTS to the fixture certificate before starting Node.
// Invoke with node bench-runner-preconnection.mjs <key-path> <cert-path>.
// Writes a JSON report to stdout. A failed transport identity control exits nonzero.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { connect, createSecureContext } from "node:tls";
import { setImmediate, setTimeout } from "node:timers/promises";

const [keyPath, certificatePath] = process.argv.slice(2);
assert(
  keyPath && certificatePath,
  "Pass the temporary TLS key and certificate",
);
const key = readFileSync(keyPath);
const cert = readFileSync(certificatePath);
const tlsContext = createSecureContext({ key, cert });
const setupDelayMs = 55;
const sampleCount = 20;

async function withPeer(run) {
  let connections = 0;
  const sockets = new WeakMap();
  const server = createServer(
    {
      key,
      cert,
      SNICallback(_name, callback) {
        // Inject a deterministic delay into new TLS connections. Reused
        // sockets bypass it. This delay represents a scenario, not CI network.
        setTimeout(setupDelayMs).then(() => callback(null, tlsContext));
      },
    },
    (request, response) => {
      request.resume();
      request.on("end", () => {
        response.end(JSON.stringify({ socket: sockets.get(request.socket) }));
      });
    },
  );
  server.on("secureConnection", (socket) => sockets.set(socket, ++connections));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    return await run({
      port,
      async request(method) {
        const startedAt = performance.now();
        const response = await fetch(`https://localhost:${port}/fixture`, {
          method,
          ...(method === "POST" ? { body: "{}" } : {}),
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });
        const elapsedMs = performance.now() - startedAt;
        assert.equal(response.status, 200);
        const { socket } = await response.json();
        assert(Number.isInteger(socket));
        return { socket, elapsedMs };
      },
    });
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
}

const rawTlsPost = await withPeer(async ({ port, request }) => {
  const socket = connect({
    host: "127.0.0.1",
    port,
    servername: "localhost",
    ca: cert,
  });
  try {
    await once(socket, "secureConnect", { signal: AbortSignal.timeout(5000) });
    return await request("POST");
  } finally {
    socket.destroy();
  }
});
assert.equal(
  rawTlsPost.socket,
  2,
  "A bare TLS socket is outside the fetch pool",
);

await withPeer(async ({ request }) => {
  const warmup = await request("GET");
  // Hand control back to Undici after consuming the entire response.
  await setImmediate();
  const dispatch = await request("POST");
  assert.equal(
    dispatch.socket,
    warmup.socket,
    "Completed warmup must prime the fetch pool",
  );
});

function percentiles(values) {
  const sorted = values.toSorted((left, right) => left - right);
  return Object.fromEntries(
    [50, 90].map((p) => {
      return [
        `p${p}`,
        Number(sorted[Math.ceil((p * sorted.length) / 100) - 1].toFixed(2)),
      ];
    }),
  );
}

const windows = [];
for (const leadMs of [25, 75]) {
  const plain = [];
  const warmed = [];
  const pairedSavings = [];
  let reused = 0;
  const baseline = () =>
    withPeer(async ({ request }) => {
      await setTimeout(leadMs);
      return await request("POST");
    });
  const prewarmed = () =>
    withPeer(async ({ request }) => {
      const [warmup, dispatch] = await Promise.all([
        request("GET"),
        setTimeout(leadMs).then(() => request("POST")),
      ]);
      reused += Number(warmup.socket === dispatch.socket);
      return dispatch;
    });

  for (let sample = 0; sample < sampleCount; sample++) {
    let control;
    let candidate;
    if (sample % 2 === 0) {
      control = await baseline();
      candidate = await prewarmed();
    } else {
      candidate = await prewarmed();
      control = await baseline();
    }
    plain.push(control.elapsedMs);
    warmed.push(candidate.elapsedMs);
    pairedSavings.push(control.elapsedMs - candidate.elapsedMs);
  }
  windows.push({
    leadMs,
    pairs: sampleCount,
    reused,
    plainPostToHeadersMs: percentiles(plain),
    warmedPostToHeadersMs: percentiles(warmed),
    pairedSavingsMs: percentiles(pairedSavings),
  });
}

console.log(
  JSON.stringify({ node: process.version, setupDelayMs, windows }, null, 2),
);
