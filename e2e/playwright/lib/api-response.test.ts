import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { readApiJson } from "./api-response";

test("E2E HTTP and JSON failures include response metadata without response contents", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("x-request-id", "request-123");
    response.setHeader("cf-ray", "ray-456-SEA");
    response.setHeader("set-cookie", "private-cookie");
    if (request.url === "/valid") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end('{"token":"private-token"}');
    } else {
      response
        .writeHead(request.url === "/upstream" ? 530 : 200, {
          "content-type": "text/html",
          "content-length": "29",
        })
        .end("<html>private-token!!!</html>");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    assert.deepEqual(
      await readApiJson(await fetch(base + "/valid"), "valid response"),
      { token: "private-token" },
    );
    for (const path of ["/upstream", "/invalid-json"]) {
      await assert.rejects(
        readApiJson(await fetch(base + path), "E2E operation"),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            path === "/upstream"
              ? /failed with HTTP 530/
              : /returned invalid JSON: HTTP 200/,
          );
          assert.match(error.message, /\(html\)/);
          assert.match(error.message, /content_type="text\/html"/);
          assert.match(error.message, /content_length=29/);
          assert.match(error.message, /request_id=request-123/);
          assert.match(error.message, /cf_ray=ray-456-SEA/);
          assert.doesNotMatch(
            String(error) + String(error.cause),
            /private-|set-cookie/,
          );
          return true;
        },
      );
    }
    assert.deepEqual(requests, ["/valid", "/upstream", "/invalid-json"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an errored response body cannot replace the observed HTTP failure", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error("private-transport-detail"));
      },
    }),
    { status: 503, headers: { "content-type": "text/html" } },
  );
  await assert.rejects(
    readApiJson(response, "E2E operation"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /failed with HTTP 503 \(html\)/);
      assert.doesNotMatch(String(error) + String(error.cause), /private-/);
      return true;
    },
  );
});
