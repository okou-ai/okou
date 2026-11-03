import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { URL } from "node:url";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { computed, createStore } from "ccstate";
import { build } from "esbuild";

// Exercise the real provider transport. The shared API SDK mock and MSW cannot
// expose retained TCP connections; no application state or routes are fabricated.
const apiRoot = resolve(import.meta.dirname, "..");
const { outputFiles } = await build({
  stdin: {
    contents: `
      export { createLazyS3Client, closeS3Clients } from "./src/lib/s3-client";
      export { withRequestRuntime } from "./src/lib/request-runtime";
    `,
    resolveDir: apiRoot,
  },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "cjs",
  write: false,
});
const runtimeRequire = createRequire(import.meta.url);

function loadRuntime(t) {
  const commonJsModule = { exports: {} };
  new Function("require", "module", "exports", outputFiles[0].text)(
    runtimeRequire,
    commonJsModule,
    commonJsModule.exports,
  );
  t.after(() => {
    return commonJsModule.exports.closeS3Clients();
  });
  return commonJsModule.exports;
}

async function mockStorage(t, respond, connectionChanged = () => {}) {
  const sockets = new Set();
  const requests = [];
  let peakConnections = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
      });
      respond(request, response);
    });
  });
  server.keepAliveTimeout = 120_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    peakConnections = Math.max(peakConnections, sockets.size);
    connectionChanged(1);
    socket.once("close", () => {
      sockets.delete(socket);
      connectionChanged(-1);
    });
  });
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening", { signal: t.signal });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    requests,
    sockets,
    peakConnections: () => {
      return peakConnections;
    },
  };
}

function ok(_request, response) {
  response.writeHead(200, { ETag: '"stored"', "Content-Length": "0" });
  response.end();
}

function config(endpoint, accessKeyId = "default-key") {
  return {
    endpoint,
    region: "auto",
    credentials: { accessKeyId, secretAccessKey: "diagnostic-secret" },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    maxAttempts: 1,
  };
}

function clientFactory(runtime, configuration) {
  return runtime.createLazyS3Client((requestHandler) => {
    return new S3Client({ ...configuration(), requestHandler });
  });
}

function put(client, key, signal) {
  return client.send(
    new PutObjectCommand({
      Bucket: "transport-test",
      Key: key,
      Body: "{}",
      ContentType: "application/json",
    }),
    { abortSignal: signal },
  );
}

test(
  "unused storage configuration stays lazy",
  { timeout: 10_000 },
  async (t) => {
    const runtime = loadRuntime(t);
    const storage = await mockStorage(t, ok);
    const optionalClient = clientFactory(runtime, () => {
      throw new Error("Optional storage is not configured");
    });
    const getClient = clientFactory(runtime, () => {
      return config(storage.endpoint);
    });
    assert.equal(
      (await put(getClient(), "configured", t.signal)).$metadata.httpStatusCode,
      200,
    );
    assert.throws(optionalClient, /Optional storage is not configured/);
  },
);

test(
  "many request Stores reuse sockets instead of retaining one pool per request",
  { timeout: 20_000 },
  async (t) => {
    const runtime = loadRuntime(t);
    const storage = await mockStorage(t, ok);
    const getClient = clientFactory(runtime, () => {
      return config(storage.endpoint);
    });
    const client$ = computed(() => {
      return getClient();
    });
    assert.equal(storage.requests.length, 0);
    let next = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < 1200) {
          const key = `manifest/${next++}.json`;
          const client = createStore().get(client$);
          const response = await put(client, key, t.signal);
          assert.equal(response.$metadata.httpStatusCode, 200);
        }
      }),
    );
    assert.equal(storage.requests.length, 1200);
    assert.ok(storage.peakConnections() <= 4);
  },
);

test(
  "credential families stay separate while sharing a bounded transport",
  { timeout: 10_000 },
  async (t) => {
    const runtime = loadRuntime(t);
    const storage = await mockStorage(t, ok);
    const firstClient = clientFactory(runtime, () => {
      return config(storage.endpoint, "first-key");
    });
    const first = firstClient();
    const secondClient = clientFactory(runtime, () => {
      return config(storage.endpoint, "second-key");
    });
    const second = secondClient();
    await put(first, "first", t.signal);
    await put(second, "second", t.signal);
    await put(firstClient(), "first-again", t.signal);
    assert.deepEqual(
      storage.requests.map((request) => {
        return request.authorization.match(/Credential=([^/]+)/)[1];
      }),
      ["first-key", "second-key", "first-key"],
    );
    assert.equal(storage.peakConnections(), 1);
  },
);

test(
  "the total socket budget spans clients and storage origins",
  { timeout: 10_000 },
  async (t) => {
    const runtime = loadRuntime(t);
    let connections = 0;
    let peak = 0;
    const changed = (delta) => {
      connections += delta;
      peak = Math.max(peak, connections);
    };
    const storage = await Promise.all(
      Array.from({ length: 3 }, () => {
        return mockStorage(t, ok, changed);
      }),
    );
    const names = ["default", "user-artifacts", "private-artifacts"];
    const results = await Promise.all(
      names.flatMap((name, index) => {
        const getClient = clientFactory(runtime, () => {
          return config(storage[index].endpoint, `${name}-key`);
        });
        const client = getClient();
        return Array.from({ length: 96 }, (_, key) => {
          return put(client, String(key), t.signal);
        });
      }),
    );
    assert.equal(results.length, 288);
    assert.ok(
      results.every((response) => {
        return response.$metadata.httpStatusCode === 200;
      }),
    );
    assert.ok(peak <= 64);
    assert.ok(
      storage.every((server) => {
        return server.peakConnections() <= 32;
      }),
    );
  },
);

test(
  "cancelling one request leaves the shared client usable",
  { timeout: 10_000 },
  async (t) => {
    const runtime = loadRuntime(t);
    const received = Promise.withResolvers();
    const storage = await mockStorage(t, (request, response) => {
      if (
        new URL(request.url, "http://storage.test").pathname.endsWith("/cancel")
      ) {
        received.resolve();
      } else {
        ok(request, response);
      }
    });
    const getClient = clientFactory(runtime, () => {
      return config(storage.endpoint);
    });
    const client = getClient();
    const controller = new globalThis.AbortController();
    const pending = put(client, "cancel", controller.signal);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await received.promise;
    controller.abort();
    await rejected;
    const response = await put(client, "after-cancel", t.signal);
    assert.equal(response.$metadata.httpStatusCode, 200);
  },
);

test(
  "Worker request contexts retain their own endpoint and credentials",
  { timeout: 10_000 },
  async (t) => {
    const runtime = loadRuntime(t);
    const first = await mockStorage(t, ok);
    const second = await mockStorage(t, ok);
    // Only transport ownership is exercised; database and telemetry are unused.
    const worker = Object.freeze({ nativeTelemetry: true });
    let currentConfig;
    const getClient = clientFactory(runtime, () => {
      return currentConfig;
    });
    for (const [storage, key] of [
      [first, "first-key"],
      [second, "second-key"],
    ]) {
      currentConfig = config(storage.endpoint, key);
      await runtime.withRequestRuntime(worker, async () => {
        const client = getClient();
        try {
          assert.equal(
            (await put(client, "worker", t.signal)).$metadata.httpStatusCode,
            200,
          );
        } finally {
          client.destroy();
        }
      });
    }
    assert.match(first.requests[0].authorization, /Credential=first-key\//);
    assert.match(second.requests[0].authorization, /Credential=second-key\//);
  },
);

test(
  "idle pooled connections close without an application request deadline",
  { timeout: 40_000 },
  async (t) => {
    const runtime = loadRuntime(t);
    const storage = await mockStorage(t, ok);
    const getClient = clientFactory(runtime, () => {
      return config(storage.endpoint);
    });
    const client = getClient();
    await put(client, "idle", t.signal);
    const [socket] = storage.sockets;
    assert.ok(socket);
    await once(socket, "close", { signal: t.signal });
    assert.equal(storage.sockets.size, 0);
    assert.equal(
      (await put(client, "after-idle", t.signal)).$metadata.httpStatusCode,
      200,
    );
  },
);
