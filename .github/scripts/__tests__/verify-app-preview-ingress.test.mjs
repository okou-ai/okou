import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(
  new URL("../verify-app-preview-ingress.sh", import.meta.url),
);
const artifactSha = "a".repeat(40);

async function probe(handler, attempts = 1) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    handler(response, requests.length);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    const child = spawn("bash", [
      script,
      `http://127.0.0.1:${port}`,
      artifactSha,
      String(attempts),
    ]);
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const [code] = await once(child, "close");
    return { code, output, requests };
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("public preview readiness retries a stale alias until the uploaded artifact is served", async () => {
  const result = await probe((response, count) => {
    response.writeHead(200, {
      "x-vm0-preview-gateway": "1",
      "x-okou-preview-build-sha": count === 1 ? "b".repeat(40) : artifactSha,
    });
    response.end("sign-in");
  }, 2);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.requests.length, 2);
  for (const request of result.requests) {
    assert.equal(request.url, "/sign-in");
    assert.equal(request.headers["sec-fetch-mode"], "navigate");
    assert.equal(request.headers["sec-fetch-dest"], "document");
  }
});

test("public preview readiness fails when the gateway still serves another artifact", async () => {
  const result = await probe((response) => {
    response.writeHead(200, {
      "x-vm0-preview-gateway": "1",
      "x-okou-preview-build-sha": "b".repeat(40),
    });
    response.end("old preview");
  });
  assert.equal(result.code, 1, result.output);
  assert.equal(result.requests.length, 1);
});

test("public preview readiness requires gateway traversal as well as artifact identity", async () => {
  const result = await probe((response) => {
    response.writeHead(200, { "x-okou-preview-build-sha": artifactSha });
    response.end("direct Worker");
  });
  assert.equal(result.code, 1, result.output);
});

test("public preview readiness does not accept a redirect to the provider", async () => {
  const result = await probe((response) => {
    response.writeHead(302, {
      location: "https://unexpected.example/",
      "x-vm0-preview-gateway": "1",
      "x-okou-preview-build-sha": artifactSha,
    });
    response.end();
  });
  assert.equal(result.code, 1, result.output);
  assert.equal(result.requests.length, 1);
});
