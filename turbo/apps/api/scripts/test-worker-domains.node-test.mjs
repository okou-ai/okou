import { URL } from "node:url";
import process from "node:process";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
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
const bypass = {
  "x-vercel-protection-bypass": environment.VERCEL_AUTOMATION_BYPASS_SECRET,
};
const domains = ["core", "execution", "integrations", "data"];
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

async function responseOf(worker, path, options) {
  const response = await worker.fetch(`https://api.example.invalid${path}`, {
    redirect: "manual",
    ...options,
  });
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

const cases = [
  { path: "/health", status: 200 },
  { path: "/health", method: "HEAD", status: 200 },
  { path: "/api/build-info", status: 200 },
  { path: "/api/chat-thread-drafts", status: 401 },
  { path: "/api/connectors", status: 401 },
  { path: "/api/weather/current", method: "POST", body: "{}", status: 401 },
  {
    path: "/api/weather/current",
    method: "POST",
    body: "{broken",
    status: 401,
  },
  { path: "/sign-in?redirect_url=%2Fchat", status: 302 },
  {
    path: "/api/weather/current",
    method: "POST",
    headers: { "X-Client-Type": "App", "X-Client-Version": "0.0.0" },
    body: "{}",
    status: 426,
  },
  {
    path: "/api/weather/current",
    method: "POST",
    protected: true,
    body: "{}",
    status: 403,
  },
];

async function initializeWorkers(t) {
  const directory = await mkdtemp(resolve(tmpdir(), "okou-api-domains-"));
  t.after(() => {
    return rm(directory, { recursive: true, force: true });
  });
  for (const name of ["gateway", ...domains, "processor"]) {
    await copyFile(
      resolve(apiRoot, `dist-worker-domains/${name}/worker.js`),
      resolve(directory, `${name}.js`),
    );
  }
  await copyFile(
    process.env.WORKER_BASELINE || resolve(apiRoot, "dist-worker/worker.js"),
    resolve(directory, "monolith.js"),
  );
  const common = {
    modules: true,
    compatibilityDate: "2026-09-02",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    // No real provider calls or database access are needed by these cases.
    outboundService(request) {
      if (new URL(request.url).hostname === "api.axiom.co") {
        return new WorkerResponse(null, { status: 204 });
      }
      throw new Error(
        `Unexpected external request: ${new URL(request.url).origin}`,
      );
    },
  };
  const bindings = {
    API_ENV_JSON_PARTS: "1",
    API_ENV_JSON_0: JSON.stringify(environment),
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      rootPath: directory,
      workers: [
        {
          ...common,
          name: "gateway",
          scriptPath: resolve(directory, "gateway.js"),
          serviceBindings: Object.fromEntries(
            domains.map((name) => {
              return [name.toUpperCase(), name];
            }),
          ),
        },
        ...domains.map((name) => {
          return {
            ...common,
            name,
            bindings,
            scriptPath: resolve(directory, `${name}.js`),
            serviceBindings: { SLIDES_PREPARER: "processor" },
          };
        }),
        {
          ...common,
          name: "processor",
          scriptPath: resolve(directory, "processor.js"),
        },
      ],
    }),
  );
  t.after(() => {
    return mf.dispose();
  });
  // Use HTTP dispatch rather than the SDK's /cdn-cgi proxy, whose Origin
  // protection would intercept cross-origin preflights before the API sees them.
  const baseline = new Miniflare(
    convertV4MiniflareOptions({
      rootPath: directory,
      workers: [
        {
          ...common,
          name: "monolith",
          bindings,
          scriptPath: resolve(directory, "monolith.js"),
        },
      ],
    }),
  );
  t.after(() => {
    return baseline.dispose();
  });
  const gateway = { fetch: mf.dispatchFetch };
  const monolith = { fetch: baseline.dispatchFetch };
  return { gateway, monolith };
}

test(
  "the built domain gateway preserves real API HTTP behavior through native Service Bindings",
  { timeout: 120_000 },
  async (t) => {
    const { gateway, monolith } = await initializeWorkers(t);
    for (const item of cases) {
      await t.test(
        `${item.method ?? "GET"} ${item.path} returns ${item.status}`,
        async () => {
          const options = {
            method: item.method ?? "GET",
            headers: {
              ...(item.protected ? {} : bypass),
              "Content-Type": "application/json",
              ...item.headers,
            },
            ...(item.body ? { body: item.body } : {}),
          };
          const expected = await responseOf(monolith, item.path, options);
          const actual = await responseOf(gateway, item.path, options);
          assert.equal(actual.status, item.status, actual.body);
          assert.deepEqual(actual, expected);
        },
      );
    }
    const manifest = JSON.parse(
      await readFile(
        resolve(apiRoot, "dist-worker-domains/route-manifest.json"),
        "utf8",
      ),
    );
    for (const domain of domains) {
      await t.test(
        `${domain} CORS preflight reaches the common middleware`,
        async () => {
          const route = manifest.find((entry) => {
            return entry.domain === domain;
          });
          const path = route.path.replace(/:[^/]+/g, "test");
          const options = {
            method: "OPTIONS",
            headers: {
              Origin: "https://app.okou.ai",
              "Access-Control-Request-Method": route.method,
              "Access-Control-Request-Headers": "authorization,content-type",
            },
          };
          const actual = await responseOf(gateway, path, options);
          assert.equal(actual.status, 204, actual.body);
          assert.deepEqual(actual, await responseOf(monolith, path, options));
        },
      );
    }
  },
);
