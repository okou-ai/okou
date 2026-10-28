import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { probeResource } from "./probe.mjs";
import { safeHeaders, sanitizeNetlog } from "./netlog.mjs";

test("transport evidence excludes credentials, bodies, unexpected URLs and browser command lines", () => {
  const allowed = "https://preview.example/okou-app/assets/index.js";
  const log = sanitizeNetlog(
    {
      constants: {
        logEventTypes: { HTTP2_SESSION_RECV_RST_STREAM: 1 },
        clientInfo: { command_line: "secret-command" },
      },
      events: [
        {
          time: "123",
          type: 1,
          phase: 0,
          source: { id: 5, type: 3 },
          params: {
            url: "https://preview.example/?token=secret-query",
            stream_id: 7,
            error_code: "2 (INTERNAL_ERROR)",
            source_dependency: { id: 8, type: 3 },
            token: 424242,
            headers: [
              "authorization: Bearer secret-auth",
              "cookie: secret-cookie",
              "set-cookie: secret-set-cookie",
              "content-encoding: zstd",
              "cf-ray: a518116a48097c11-IAD",
            ],
            bytes: "secret-body",
            description: "secret-description",
          },
        },
        {
          time: "124",
          type: 1,
          phase: 0,
          source: { id: 5, type: 3 },
          params: { url: allowed, net_error: -337 },
        },
      ],
    },
    new Set([allowed]),
  );
  assert.doesNotMatch(JSON.stringify(log), /secret|424242/u);
  assert.equal(log.events[0].params.stream_id, 7);
  assert.equal(log.events[0].params.error_code, "2 (INTERNAL_ERROR)");
  assert.deepEqual(log.events[0].params.source_dependency, { id: 8, type: 3 });
  assert.deepEqual(log.events[0].params.headers, [
    "content-encoding: zstd",
    "cf-ray: a518116a48097c11-IAD",
  ]);
  assert.equal(log.events[1].params.url, allowed);
  assert.equal(log.events[1].params.net_error, -337);
  assert.deepEqual(
    safeHeaders({ "Set-Cookie": "secret", "Content-Encoding": "zstd" }),
    { "Content-Encoding": "zstd" },
  );
  assert.throws(
    () => sanitizeNetlog({ events: [] }, new Set()),
    /Invalid Chromium NetLog/u,
  );
});

test("real curl preserves a 200 partial-transfer failure and validates complete bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preview-resource-probe-"));
  const bytes = Buffer.from("complete public resource");
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    const payload = request.url === "/gzip" ? gzipSync(bytes) : bytes;
    response.writeHead(200, {
      "Content-Length":
        request.url === "/partial" ? bytes.length + 10 : payload.length,
      "Content-Type": "application/javascript",
      "Set-Cookie": "must-not-publish",
      ...(request.url === "/gzip" ? { "Content-Encoding": "gzip" } : {}),
    });
    response.end(payload);
  });
  server.keepAliveTimeout = 1;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const options = {
      protocol: "h1",
      encoding: "identity",
      bodyPath: join(directory, "body"),
      headerPath: join(directory, "headers"),
      expected: {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
    const partial = await probeResource({ ...options, url: `${url}/partial` });
    assert.equal(partial.metrics.http_code, 200);
    assert.equal(partial.ok, false);
    assert.equal(partial.curlExitCode, 18);
    assert.equal(partial.bytes, bytes.length);
    assert.doesNotMatch(JSON.stringify(partial), /must-not-publish/u);
    const complete = await probeResource({
      ...options,
      url: `${url}/complete`,
    });
    assert.equal(complete.ok, true);
    assert.equal(complete.curlExitCode, 0);
    const wrongBody = await probeResource({
      ...options,
      url: `${url}/complete`,
      expected: { bytes: bytes.length, sha256: "0".repeat(64) },
    });
    assert.equal(wrongBody.ok, false);
    const wrongEncoding = await probeResource({
      ...options,
      url: `${url}/gzip`,
    });
    assert.equal(wrongEncoding.bytes, bytes.length);
    assert.equal(wrongEncoding.encodingMatches, false);
    assert.equal(wrongEncoding.ok, false);
    assert.equal(
      requests,
      4,
      "a failed transfer must not be automatically retried",
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true });
  }
});
