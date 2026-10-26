import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import {
  apiRoot,
  workerBuildOptions,
  validateWorkerExternals,
} from "./worker-build-options.mjs";

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler"));
const {
  Miniflare,
  Response: WorkerResponse,
  convertV4MiniflareOptions,
} = wranglerRequire("miniflare");

test(
  "Worker runtime delivers manual and escaping request errors to Sentry",
  { timeout: 30_000 },
  async (t) => {
    const directory = await mkdtemp(resolve(tmpdir(), "okou-worker-sentry-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const options = workerBuildOptions({
      entryPoint: "src/worker.ts",
      outputDirectory: directory,
    });
    delete options.entryPoints;
    options.stdin = {
      contents: `
      import { Hono } from "hono";
      import { captureException } from "@sentry/cloudflare";
      import { createApiWorker } from "./src/worker-runtime";
      export default createApiWorker(() => {
        const app = new Hono();
        app.get("/manual", (context) => {
          captureException(new Error("worker-manual-error"));
          return context.text("accepted");
        });
        app.get("/escaping", () => {
          throw new Error("worker-escaping-error");
        });
        app.onError((error) => { throw error; });
        return app;
      });
    `,
      resolveDir: apiRoot,
      sourcefile: "worker-runtime-sentry-fixture.ts",
      loader: "ts",
    };
    const result = await build(options);
    validateWorkerExternals(result);
    for (const output of result.outputFiles) {
      await writeFile(output.path, output.contents);
    }
    const environment = {
      ...JSON.parse(
        await readFile(
          new URL("./worker-domain-test-env.json", import.meta.url),
          "utf8",
        ),
      ),
      SENTRY_DSN: "https://fixture@sentry.example.invalid/1",
    };
    const deliveries = new Map([
      ["worker-manual-error", Promise.withResolvers()],
      ["worker-escaping-error", Promise.withResolvers()],
    ]);
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        rootPath: directory,
        modules: true,
        scriptPath: resolve(directory, "worker.js"),
        compatibilityDate: "2026-09-02",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          API_ENV_JSON_PARTS: "1",
          API_ENV_JSON_0: JSON.stringify(environment),
        },
        async outboundService(request) {
          assert.equal(
            new URL(request.url).origin,
            "https://sentry.example.invalid",
          );
          const lines = (await request.text()).split("\n");
          for (let index = 1; index + 1 < lines.length; index += 2) {
            const header = JSON.parse(lines[index]);
            if (header.type !== "event") continue;
            const event = JSON.parse(lines[index + 1]);
            const value = event.exception?.values?.[0]?.value;
            const delivery = deliveries.get(value);
            assert.ok(delivery, `Unexpected Sentry error: ${value}`);
            delivery.resolve(event);
          }
          return new WorkerResponse("{}", { status: 200 });
        },
      }),
    );
    t.after(() => mf.dispose());

    const manual = await mf.dispatchFetch("https://api.example.invalid/manual");
    assert.equal(manual.status, 200);
    assert.equal(await manual.text(), "accepted");
    const captured = await deliveries.get("worker-manual-error").promise;
    assert.equal(captured.request.url, "https://api.example.invalid/manual");

    const escaping = await mf.dispatchFetch(
      "https://api.example.invalid/escaping",
    );
    assert.equal(escaping.status, 500);
    await escaping.text();
    const unhandled = await deliveries.get("worker-escaping-error").promise;
    assert.equal(unhandled.request.url, "https://api.example.invalid/escaping");
    assert.equal(
      unhandled.exception.values[0].mechanism.type,
      "auto.http.cloudflare",
    );
    assert.equal(unhandled.exception.values[0].mechanism.handled, false);
  },
);
