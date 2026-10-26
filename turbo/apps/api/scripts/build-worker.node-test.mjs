import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";

import { build } from "esbuild";
import { workerRequireBanner } from "./worker-bundle-banner.mjs";
import { validateWorkerRouteBoundaries } from "./worker-route-boundaries.mjs";

test("domain build rejects reintroduced global and foreign route tables", () => {
  for (const path of [
    "src/signals/route.ts",
    "src/signals/route-groups/core.ts",
    "../../packages/api-contracts/src/client-transforms/desktop.ts",
  ]) {
    assert.throws(() => {
      validateWorkerRouteBoundaries({
        outputs: {
          "worker.js": {
            entryPoint: "src/worker-domains/data.ts",
            inputs: { [path]: { bytesInOutput: 1 } },
          },
        },
      });
    }, /global or foreign registry/);
  }
});

test("Data build rejects a runtime contract brought back by a shared helper", () => {
  assert.throws(() => {
    validateWorkerRouteBoundaries({
      outputs: {
        "worker.js": {
          entryPoint: "src/worker-domains/data.ts",
          inputs: {
            "../../packages/api-contracts/src/contracts/browser-user-actions.ts":
              {
                bytesInOutput: 200,
              },
          },
        },
      },
    });
  }, /unrelated business contract/);
});

test("build boundaries allow full API composition and erased dependencies", () => {
  for (const [entryPoint, bytesInOutput] of [
    ["src/worker.ts", 200],
    ["src/worker-domains/data.ts", 0],
  ]) {
    validateWorkerRouteBoundaries({
      outputs: {
        "worker.js": {
          entryPoint,
          inputs: { "src/signals/route.ts": { bytesInOutput } },
        },
      },
    });
  }
});

const apiRoot = resolve(import.meta.dirname, "..");
const { outputFiles } = await build({
  stdin: {
    contents: `const pg = require("pg"); const email = require("@react-email/render"); module.exports = { pg, email };`,
    resolveDir: apiRoot,
  },
  platform: "node",
  format: "cjs",
  bundle: true,
  write: false,
  alias: {
    "pg-native": resolve(apiRoot, "src/worker-unsupported-pg-native.ts"),
    "@react-email/render": resolve(
      apiRoot,
      "src/worker-unsupported-react-email.ts",
    ),
  },
});
const runtimeRequire = createRequire(import.meta.url);
function load(forceNative = false) {
  const commonJsModule = { exports: {} };
  // Isolate pg's native-selection input without changing the test process env.
  const runtimeProcess = {
    ...process,
    env: { ...process.env, NODE_PG_FORCE_NATIVE: forceNative ? "1" : "" },
  };
  new Function("require", "module", "exports", "process", outputFiles[0].text)(
    runtimeRequire,
    commonJsModule,
    commonJsModule.exports,
    runtimeProcess,
  );
  return commonJsModule.exports;
}

test("Worker require interop initializes real Node builtins when import.meta.url is absent", async () => {
  const result = await build({
    stdin: {
      contents: `${workerRequireBanner}\nexport const EventEmitter = require("node:events").EventEmitter; export const processes = [require("process"), require("node:process")];`,
    },
    platform: "node",
    format: "cjs",
    bundle: true,
    write: false,
    // Reproduce the legacy Workers module-registry input, not Node's file URL.
    define: { "import.meta.url": "undefined" },
  });
  const commonJsModule = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(
    runtimeRequire,
    commonJsModule,
    commonJsModule.exports,
  );
  const { EventEmitter, processes } = commonJsModule.exports;
  assert.equal(processes[0], process);
  assert.equal(processes[1], process);
  const emitter = new EventEmitter();
  let observed;
  emitter.on("probe", (value) => {
    observed = value;
  });
  emitter.emit("probe", "worker-native-require");
  assert.equal(observed, "worker-native-require");
});

test("Worker pg shim preserves real JS client initialization without connecting", () => {
  const { pg } = load();
  const client = new pg.Client();
  assert.equal(typeof client.query, "function");
  assert.ok(client.connection);
  assert.equal(client._connected, false);
  // Reading the lazy branch is also safe; only native construction fails.
  assert.throws(() => {
    return new pg.native.Client();
  }, /pg-native\/libpq is unsupported.*JavaScript.*NODE_PG_FORCE_NATIVE/);
});

test("forced native selection fails actionably on client construction, not startup", () => {
  const { pg } = load(true);
  assert.throws(() => {
    return new pg.Client();
  }, /pg-native\/libpq is unsupported/);
});

test("optional React renderer initializes safely and never fabricates email HTML", () => {
  const { email } = load();
  assert.throws(() => {
    return email.render();
  }, /Supply pre-rendered html\/text to Resend/);
});
