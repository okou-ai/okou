import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ReadableStream } from "node:stream/web";
import { test } from "node:test";
import { URL } from "node:url";
import { apiRoot } from "./worker-build-options.mjs";

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler"));
const {
  Miniflare,
  Response: WorkerResponse,
  convertV4MiniflareOptions,
} = wranglerRequire("miniflare");
const environment = JSON.parse(
  await readFile(
    new URL("./worker-domain-test-env.json", import.meta.url),
    "utf8",
  ),
);
const compatibilityDate = "2026-09-02";
const ingressPath = resolve(apiRoot, "dist-worker-ingress/ingress/worker.js");
const apiPath = resolve(apiRoot, "dist-worker-ingress/api/worker.js");
const selectedHeaders = [
  "content-type",
  "cache-control",
  "location",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-max-age",
  "vary",
];

async function runtime(t, workers) {
  const rootPath = await mkdtemp(resolve(tmpdir(), "okou-api-ingress-"));
  const localWorkers = [];
  for (const worker of workers) {
    if (worker.scriptPath) {
      const scriptPath = resolve(rootPath, `${worker.name}.js`);
      await copyFile(worker.scriptPath, scriptPath);
      localWorkers.push({ ...worker, scriptPath });
    } else {
      localWorkers.push(worker);
    }
  }
  const mf = new Miniflare(
    convertV4MiniflareOptions({ rootPath, workers: localWorkers }),
  );
  t.after(async () => {
    await mf.dispose();
    await rm(rootPath, { recursive: true, force: true });
  });
  await mf.ready;
  return mf;
}

function ingress() {
  return {
    name: "ingress",
    modules: true,
    compatibilityDate,
    scriptPath: ingressPath,
    serviceBindings: { API: "api" },
  };
}

async function responseOf(mf, path, options) {
  // HTTP dispatch preserves cross-origin preflights that the SDK proxy rejects.
  const response = await mf.dispatchFetch(
    `https://api.example.invalid${path}`,
    {
      redirect: "manual",
      ...options,
    },
  );
  return {
    status: response.status,
    headers: Object.fromEntries(
      selectedHeaders
        .filter((name) => {
          return response.headers.has(name);
        })
        .map((name) => {
          return [name, response.headers.get(name)];
        }),
    ),
    body: await response.text(),
  };
}

test(
  "the minimal ingress preserves the unchanged full API through a native Service Binding",
  { timeout: 120_000 },
  async (t) => {
    const api = {
      name: "api",
      modules: true,
      compatibilityDate,
      compatibilityFlags: ["nodejs_compat"],
      scriptPath: apiPath,
      bindings: {
        API_ENV_JSON_PARTS: "1",
        API_ENV_JSON_0: JSON.stringify(environment),
      },
      outboundService(request) {
        if (new URL(request.url).hostname === "api.axiom.co") {
          return new WorkerResponse(null, { status: 204 });
        }
        throw new Error(
          `Unexpected external request: ${new URL(request.url).origin}`,
        );
      },
    };
    const direct = await runtime(t, [api]);
    const forwarded = await runtime(t, [ingress(), api]);
    const cases = [
      { path: "/health", status: 200 },
      { path: "/health", method: "HEAD", status: 200 },
      { path: "/api/build-info", status: 200 },
      { path: "/api/chat-thread-drafts", status: 401 },
      { path: "/api/data/router/tools", method: "GET", status: 401 },
      { path: "/sign-in?redirect_url=%2Fchat", status: 302 },
      {
        path: "/api/data/router/tools",
        method: "GET",
        headers: { "X-Client-Type": "App", "X-Client-Version": "0.0.0" },
        status: 426,
      },
      {
        path: "/api/data/router/tools",
        method: "OPTIONS",
        headers: {
          Origin: "https://app.okou.ai",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
        status: 204,
      },
      {
        path: "/api/data/router/tools",
        method: "GET",
        protected: true,
        status: 403,
      },
    ];
    for (const item of cases) {
      await t.test(
        `${item.method ?? "GET"} ${item.path}: ${item.status}`,
        async () => {
          const options = {
            method: item.method ?? "GET",
            headers: {
              ...(item.protected
                ? {}
                : {
                    "x-vercel-protection-bypass":
                      environment.VERCEL_AUTOMATION_BYPASS_SECRET,
                  }),
              "Content-Type": "application/json",
              ...item.headers,
            },
            ...(item.body ? { body: item.body } : {}),
          };
          const expected = await responseOf(direct, item.path, options);
          const actual = await responseOf(forwarded, item.path, options);
          assert.equal(actual.status, item.status, actual.body);
          assert.deepEqual(actual, expected);
        },
      );
    }
  },
);

// This protocol peer runs inside workerd. It tests the transport boundary,
// independently of business handlers; it does not claim authenticated API/SSE
// coverage or replace the full API comparison above.
const protocolPeer = `
export default {
  fetch(request) {
    const headers = new Headers({
      "content-type": "application/octet-stream",
      "x-original-url": request.url,
      "x-original-method": request.method,
      "x-original-authorization": request.headers.get("authorization") ?? "",
      "x-original-cookie": request.headers.get("cookie") ?? "",
    });
    headers.append("set-cookie", "first=1; HttpOnly; Path=/");
    headers.append("set-cookie", "second=2; Secure; Path=/");
    return new Response(request.body, { status: 201, headers });
  },
};
`;

test(
  "native Service Binding preserves binary streaming, URL, method, credentials, and response cookies",
  { timeout: 30_000 },
  async (t) => {
    const mf = await runtime(t, [
      ingress(),
      { name: "api", modules: true, compatibilityDate, script: protocolPeer },
    ]);
    const first = new Uint8Array([0, 255, 10, 13, 128]);
    const second = new Uint8Array([1, 2, 3, 200]);
    let upload;
    const body = new ReadableStream({
      start(controller) {
        upload = controller;
        controller.enqueue(first);
      },
    });
    const url = "https://api.example.invalid/echo/a%2Fb?value=%2F%20&value=two";
    const response = await mf.dispatchFetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        cookie: "session=test-session",
      },
      body,
      duplex: "half",
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-original-url"), url);
    assert.equal(response.headers.get("x-original-method"), "POST");
    assert.equal(
      response.headers.get("x-original-authorization"),
      "Bearer test-token",
    );
    assert.equal(
      response.headers.get("x-original-cookie"),
      "session=test-session",
    );
    assert.deepEqual(response.headers.getSetCookie(), [
      "first=1; HttpOnly; Path=/",
      "second=2; Secure; Path=/",
    ]);
    const reader = response.body.getReader();
    // The first bytes must arrive before the client supplies the remaining
    // upload. Buffering either request or response would deadlock this exchange.
    const received = [];
    while (received.length < first.length) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      received.push(...chunk.value);
    }
    assert.deepEqual(Uint8Array.from(received), first);
    upload.enqueue(second);
    upload.close();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      received.push(...chunk.value);
    }
    assert.deepEqual(
      Uint8Array.from(received),
      new Uint8Array([...first, ...second]),
    );
    reader.releaseLock();
  },
);
